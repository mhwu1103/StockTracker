"""共用邏輯：價格結構——樞紐高低點、突破、回踩與趨勢。

這一支把幾句常見的交易口訣翻成可以從四價算出來、可以被資料證偽的欄位：

    上漲行情是突破之後的回踩，回踩不破前期高點就還在
    下跌行情是破位之後的反彈，反彈衝不過前期低點就還在
    趨勢沒被破壞之前，別跟它反著做

「前期高點」＝樞紐高點（pivot high）：某一根的最高價比前後各 k 根都高。
k 有兩組（3 與 5）：k 小抓得到短波段、k 大只留大波段，兩組一起算，看的人自己選。

**樞紐是事後確認的**：第 i 根要等到第 i+k 根收盤才知道它是不是樞紐。
這是這套方法的本質，不是延遲的 bug，但讀資料的人必須知道。

「破不破」一律以**收盤價**為準：盤中最低跌破前高不算破，收盤跌破才算突破失敗。

只放邏輯，不負責 I/O 與排程——那是 build_structure.py 的事。
"""

from __future__ import annotations

import json
from collections import deque

import twse

# --------------------------------------------------------------------------- #
# 電子類股
# --------------------------------------------------------------------------- #
# 證交所官方產業別裡屬於「電子」的八個子產業，與 fetch_industry.py 的 INDUSTRY_NAMES
# 用同一批中文名。這八類就是電子類指數的成分口徑；電機機械、數位雲端不算在內。
ELECTRONIC_INDUSTRIES = (
    "半導體業",
    "電腦及週邊設備業",
    "光電業",
    "通信網路業",
    "電子零組件業",
    "電子通路業",
    "資訊服務業",
    "其他電子業",
)

INDUSTRY_PATH = twse.DATA_DIR / "industry.json"

_SUFFIX = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def load_industry() -> tuple:
    """讀 industry.json，回傳 (代號 -> 產業, 代號 -> 簡稱)。

    `names` 是後加的欄位，舊檔沒有就回空的 dict，呼叫端要能容忍查不到名字。
    """
    if not INDUSTRY_PATH.exists():
        return {}, {}
    raw = json.loads(INDUSTRY_PATH.read_text(encoding="utf-8"))
    return raw.get("map") or {}, raw.get("names") or {}


def industry_of(code: str, mapping: dict):
    """代號 -> 產業。與 docs/app.js 的 industryOf() 同一套規則，改動時兩邊要一起看。

    這裡只補「特別股沿用母公司分類」那一條：ETF（00 開頭）與查不到的代號一律回 None，
    電子股的篩選本來就不該把它們收進來。
    """
    found = mapping.get(code)
    if found:
        return found
    if code.startswith("00"):
        return None                       # ETF／ETN 不在公司清單裡，也不算電子股
    parent = code.rstrip(_SUFFIX)         # 特別股 2891B -> 2891
    return mapping.get(parent) if parent != code else None


def electronic_codes(mapping: dict = None) -> set:
    """回傳電子類股的代號集合（含特別股）。"""
    if mapping is None:
        mapping, _ = load_industry()
    wanted = set(ELECTRONIC_INDUSTRIES)
    return {code for code in mapping if industry_of(code, mapping) in wanted}


def name_of(code: str, names: dict) -> str:
    """代號 -> 簡稱；查不到就回代號本身，讓畫面至少還認得出是哪一檔。"""
    return names.get(code) or names.get(code.rstrip(_SUFFIX)) or code


# --------------------------------------------------------------------------- #
# 結構狀態機
# --------------------------------------------------------------------------- #
PIVOT_KS = (3, 5)
KMAX = max(PIVOT_KS)

# 每一根 K 要留多久：算 k 的樞紐要看前後各 k 根，所以視窗是 2k+1
WINDOW = 2 * KMAX + 1

# 趨勢要比「最近兩個」樞紐高與「最近兩個」樞紐低，各留兩個就夠
PIVOTS_KEPT = 2

# dir：結構的方向
UP, DOWN, NONE = 1, -1, 0

# phase：突破之後走到哪一步（向下是完全鏡像的）
PHASE_FRESH = 0     # 突破後還沒回來測             ／ 破位後還沒反彈
PHASE_RETEST = 1    # 回踩中（碰到前高、收盤還守著）／ 反彈中
PHASE_HELD = 2      # 回踩守住（站回突破後高點）   ／ 反彈受阻（跌破反彈前低點）
PHASE_FAILED = 3    # 突破失敗（收盤跌回前高之下） ／ 破位失敗（收盤站回前低之上）


class StructureTracker:
    """單一市場的結構狀態機：一天餵一次全市場四價，吐出當日每一檔的結構。

    形狀刻意與 build_history.py 的 MaTracker 一致——同樣是逐日 feed、
    同樣用「上一次出現在第幾個交易日」盯連續性、同樣用 reset() 處理缺資料的日子。
    樞紐要連續的 K 棒才數得對，中間斷過就整個重來，寧可算不出來也不硬算。
    """

    def __init__(self):
        self.seq = 0            # 這個市場已經走過幾個交易日
        self.codes = {}         # code -> 個股狀態

    def reset(self):
        """這一天沒有四價檔（回補還沒補到）：連續性就斷在這裡。"""
        self.codes.clear()

    def feed(self, prices: dict) -> dict:
        """`prices` 是 code -> [開, 高, 低, 收]，回傳 code -> 當日結構。

        回傳值的 `s` 是 {k: [dir, phase, age, pdays, ref, trend]}，
        `pivots` 是今天剛確認的樞紐 [(k, 幾根之前, 'h'/'l', 價)]。
        """
        self.seq += 1
        out = {}
        for code, price in prices.items():
            bar = self._bar(price)
            if bar is None:
                continue
            state = self.codes.get(code)
            if state is None or state["seq"] != self.seq - 1:
                state = self._new_state()
                self.codes[code] = state
            state["seq"] = self.seq
            out[code] = self._step(state, bar)
        return out

    @staticmethod
    def _bar(price):
        """[開, 高, 低, 收] -> (高, 低, 收)；缺高低就用開收的極值補。

        開高低是加個股 K 線時才補收的（見 twse.write_closes），更早的日子只有收盤價。
        補法與前端 fillCandles() 一致：不假造當天其實沒有的振幅。
        """
        if not price or price[3] is None:
            return None
        open_, high, low, close = price
        base = open_ if open_ is not None else close
        return (high if high is not None else max(base, close),
                low if low is not None else min(base, close),
                close)

    @staticmethod
    def _new_state() -> dict:
        return {
            "seq": 0,
            "n": 0,                                  # 已連續看過幾根 K
            "prev": None,                            # 昨天的收盤價，判斷「穿越」要用
            "bars": deque(maxlen=WINDOW),            # 最近 WINDOW 根的 (高, 低, 收)
            "k": {k: {"highs": deque(maxlen=PIVOTS_KEPT),   # 已確認樞紐高 (根序, 價)
                      "lows": deque(maxlen=PIVOTS_KEPT),
                      "dir": NONE,
                      "phase": PHASE_FRESH,
                      "since": 0,      # 突破那一根的序號
                      "pstart": 0,     # 目前 phase 是從哪一根開始的
                      "ref": None,     # 被突破的樞紐價位（會隨新樞紐往前搬，見 _step_up）
                      "ext": None}     # 突破後的最高收盤（向下是最低收盤）
                  for k in PIVOT_KS},
        }

    def _step(self, state, bar) -> dict:
        state["bars"].append(bar)
        state["n"] += 1
        out = {"s": {}, "pivots": []}
        for k in PIVOT_KS:
            out["pivots"].extend(self._confirm_pivots(state, k))
            out["s"][k] = self._advance(state, k, bar)
        state["prev"] = bar[2]
        return out

    def _confirm_pivots(self, state, k: int) -> list:
        """今天收盤後，第 (n-1-k) 根的樞紐身分就確定了。回傳這一根新確認的樞紐。

        兩側都要嚴格大於（或小於）才算，平手不算——雙頂那種兩根一樣高的，
        算成兩個樞紐只會讓後面的「前期高點」在兩個一樣的價位之間跳來跳去。
        """
        bars = state["bars"]
        span = 2 * k + 1
        if len(bars) < span:
            return []
        window = list(bars)[-span:]
        center = window[k]
        others = window[:k] + window[k + 1:]
        at = state["n"] - 1 - k                  # 這一根的序號（0 起算）
        ks = state["k"][k]
        found = []
        if all(center[0] > other[0] for other in others):
            ks["highs"].append((at, center[0]))
            found.append((k, k, "h", center[0]))
        if all(center[1] < other[1] for other in others):
            ks["lows"].append((at, center[1]))
            found.append((k, k, "l", center[1]))
        return found

    def _advance(self, state, k: int, bar) -> list:
        """把今天的四價餵進這一組 k 的狀態機，回傳 [dir, phase, age, pdays, ref, trend]。"""
        high, low, close = bar
        ks = state["k"][k]
        now = state["n"] - 1

        if ks["dir"] == UP:
            self._step_up(ks, now, low, close)
        elif ks["dir"] == DOWN:
            self._step_down(ks, now, high, close)

        self._maybe_break(ks, now, state["prev"], close)

        if ks["dir"] == NONE:
            return [NONE, PHASE_FRESH, 0, 0, None, self._trend(ks)]
        return [ks["dir"], ks["phase"], now - ks["since"], now - ks["pstart"],
                round(ks["ref"], 2), self._trend(ks)]

    @staticmethod
    def _set_phase(ks, phase, now):
        if ks["phase"] != phase:
            ks["phase"] = phase
            ks["pstart"] = now

    def _step_up(self, ks, now, low, close):
        """向上結構的一天。`ext` 是回踩之前的最高收盤，就是「守住」要跨過的門檻。"""
        ref = ks["ref"]
        if close < ref:
            # 收盤跌回前高之下：這次突破就是失敗了（盤中跌破不算，只看收盤）
            self._set_phase(ks, PHASE_FAILED, now)
            return
        if ks["phase"] == PHASE_FAILED:
            return                                  # 已經失效，等 _maybe_break 重起
        if low <= ref:
            # 最低價回到前高：進入回踩。ext 不動，凍在回踩之前的高點
            self._set_phase(ks, PHASE_RETEST, now)
        elif ks["phase"] == PHASE_RETEST and close > ks["ext"]:
            # 回踩過後收盤站回突破後的高點：這一段回踩守住了
            self._set_phase(ks, PHASE_HELD, now)
            ks["ext"] = close
        elif ks["phase"] in (PHASE_FRESH, PHASE_HELD):
            ks["ext"] = max(ks["ext"], close)

    def _step_down(self, ks, now, high, close):
        """向下結構的一天，與 _step_up 完全鏡像。`ext` 是反彈之前的最低收盤。"""
        ref = ks["ref"]
        if close > ref:
            self._set_phase(ks, PHASE_FAILED, now)
            return
        if ks["phase"] == PHASE_FAILED:
            return
        if high >= ref:
            self._set_phase(ks, PHASE_RETEST, now)
        elif ks["phase"] == PHASE_RETEST and close < ks["ext"]:
            # 反彈碰到前低就是衝不過去，之後又跌破反彈前的低點：這一段反彈受阻
            self._set_phase(ks, PHASE_HELD, now)
            ks["ext"] = close
        elif ks["phase"] in (PHASE_FRESH, PHASE_HELD):
            ks["ext"] = min(ks["ext"], close)

    def _maybe_break(self, ks, now, prev, close):
        """看今天有沒有突破，以及要不要把前期高低點往前搬。

        突破的條件是**穿越**：昨天的收盤還在樞紐之下（含等於）、今天收上去。
        只寫「收盤 > 樞紐價」是不行的——價格本來就在上面、後來才在下面形成一個
        樞紐高，那也會被算成突破，但實際上什麼都沒發生。

        已經在結構裡的另外給一條「階梯」：新確認的樞紐高比目前的 ref 更高、
        而且今天收在它之上，就把 ref 往上搬。不搬的話，一路走高的股票會永遠停在
        很久以前的那個前高，回踩根本不會發生。搬的時候 age 不重算，因為突破日
        還是最初那一天；重算的是 phase，新的前高要重新等它的回踩。
        """
        top = ks["highs"][-1] if ks["highs"] else None
        bottom = ks["lows"][-1] if ks["lows"] else None
        idle = ks["dir"] == NONE or ks["phase"] == PHASE_FAILED

        if prev is not None:
            if top and prev <= top[1] < close:
                self._start(ks, UP, now, top[1], close)
                return
            if bottom and prev >= bottom[1] > close:
                self._start(ks, DOWN, now, bottom[1], close)
                return
        if idle:
            return
        if ks["dir"] == UP and top and ks["ref"] < top[1] < close:
            ks.update(ref=top[1], ext=close)
            self._set_phase(ks, PHASE_FRESH, now)
        elif ks["dir"] == DOWN and bottom and ks["ref"] > bottom[1] > close:
            ks.update(ref=bottom[1], ext=close)
            self._set_phase(ks, PHASE_FRESH, now)

    @staticmethod
    def _start(ks, direction, now, ref, close):
        ks.update(dir=direction, phase=PHASE_FRESH, since=now, pstart=now,
                  ref=ref, ext=close)

    @staticmethod
    def _trend(ks) -> int:
        """樞紐序列的趨勢：高點更高且低點更高＝上升，兩個都更低＝下降，其餘＝震盪。"""
        highs, lows = ks["highs"], ks["lows"]
        if len(highs) < PIVOTS_KEPT or len(lows) < PIVOTS_KEPT:
            return 0
        if highs[-1][1] > highs[-2][1] and lows[-1][1] > lows[-2][1]:
            return 1
        if highs[-1][1] < highs[-2][1] and lows[-1][1] < lows[-2][1]:
            return -1
        return 0
