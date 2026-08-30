"""由 docs/data/daily/{twse,tpex}/*.json 重建三種範圍的索引與歷史序列。

範圍（scope）：
    twse  上市      抓取端直接產生
    tpex  上櫃      抓取端直接產生
    all   全部      在這裡由上市＋上櫃合併算出來

合併後的名次一定算得準：某檔若排得進合併後的前 300 名，它在自己市場裡的名次
必然也在前 300 名內，所以只用兩邊各自的前 300 名就足以還原正確的合併排行。

產出（全部是純衍生檔，隨時可重算）：
    docs/data/daily/all/YYYY-MM-DD.json    合併後的排行
    daily/{scope}/*.json 裡的 streak／vh／ma／mav／macd 欄位（就地補寫）
    docs/data/index.json                   交易日清單 + 三種範圍的每日成交值
    docs/data/history/{scope}/YYYY.json     該範圍「個股 -> 每日 (名次, 成交值)」轉置表

用法：
    python scripts/build_history.py
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict, deque
from datetime import datetime

import twse

# 合併排行時要保留的欄位；名次、連續進榜天數與成交量新高天數都會重算，
# 不能沿用來源市場的
RECORD_FIELDS = ("code", "name", "value", "volume", "close", "changePct")

# 成交量新高：今天的量是往前幾個交易日裡的最大值（含今天）。
# 超過這個天數就不再往前算——對「爆量」而言已經沒有分辨力，也省下檔案體積。
VOL_HIGH_MAX = 250

# 均線：要算哪幾條，順序即 daily 檔裡 ma／mav 陣列的順序，須與前端的 MA_WINDOWS 一致
MA_WINDOWS = (5, 10, 20, 60)

# 連續站上／跌破的天數最多算到這裡，超過就顯示成 60+
MA_STREAK_MAX = 60

# MACD：標準參數（快線 12、慢線 26、訊號線 9）
MACD_FAST, MACD_SLOW, MACD_SIGNAL = 12, 26, 9

# EMA 沒有真正的起點，是從第一天的收盤價一路遞推出來的，跑不夠久就還帶著起點的味道。
# 連續收盤價少於這麼多天就不出 MACD——26 日 EMA 的起點誤差到這裡只剩約 1%。
MACD_WARMUP = 60

# 收盤價往回只湊得到這麼多天就斷了（新上市、長期停牌、資料起點）時，
# 天數小於這個數字的一律當成資料不足。
# 「站上 3 天」與「有資料的那 3 天都站上」是兩件事，後者可能昨天就站上了，
# 報成「剛站上」是假訊號。前端最多回看 10 日，斷在 10 天以外不影響判讀。
MA_TRUST_DAYS = 11


def load_day(date_iso: str, scope: str):
    path = twse.daily_path(date_iso, scope)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def merge_day(date_iso: str, twse_day: dict, tpex_day: dict) -> dict:
    records = []
    for day, market in ((twse_day, "twse"), (tpex_day, "tpex")):
        for stock in day["stocks"]:
            rec = {k: stock[k] for k in RECORD_FIELDS}
            # 開盤價是後來才加的欄位，加欄位之前抓的日子沒有；沒有就不寫，
            # 前端看 open 在不在來決定要不要顯示「收紅」條件。
            if stock.get("open") is not None:
                rec["open"] = stock["open"]
            rec["m"] = market          # 前端在「全部」範圍要標出上市／上櫃
            records.append(rec)

    payload = twse.build_payload(date_iso, "MERGED", records)
    # build_payload 只看得到兩邊的前 300 名，全市場的檔數與成交值要用原始數字相加
    payload["marketCount"] = twse_day["marketCount"] + tpex_day["marketCount"]
    payload["marketValue"] = twse_day["marketValue"] + tpex_day["marketValue"]
    return payload


def update_streaks(payload, day_index, date_iso, streaks) -> bool:
    """替當日前 200 名補上 streak／since 欄位，回傳檔案內容是否有變動。"""
    changed = False
    for stock in payload["stocks"]:
        if stock["rank"] <= twse.STREAK_RANK:
            prev = streaks.get(stock["code"])
            if prev and prev[2] == day_index - 1:      # 前一個交易日也在榜上
                count, since = prev[0] + 1, prev[1]
            else:
                count, since = 1, date_iso
            streaks[stock["code"]] = (count, since, day_index)
            fresh = {"streak": count, "since": since}
        else:
            fresh = {}

        if stock.get("streak") != fresh.get("streak") or stock.get("since") != fresh.get("since"):
            changed = True
            stock.pop("streak", None)
            stock.pop("since", None)
            stock.update(fresh)
    return changed


def stamp_vol_high(payload, stacks, seq) -> bool:
    """替當日每一檔補上 `vh`：今天的成交量是往前幾個交易日裡的最大值（含今天）。

    用單調遞減堆疊攤提成 O(1)：把量比今天小的日子都彈掉，剩下的堆頂就是上一次
    「量不小於今天」的那天，兩者的距離就是這次新高的天數。平手不算新高，
    所以只彈掉嚴格比今天小的。

    只有當天成交值前 300 名的股票有資料，沒進榜的日子一律當成量比今天小。
    對突然爆量的股票這個假設是對的（它先前連成交值前 300 都排不上），
    但低價高量股會因此被高估——前端的爆量分頁有註明這一點。

    `vh` 為 1（連昨天都沒超過）的佔了一半以上，省略不寫，前端讀不到就當 1。
    """
    changed = False
    for stock in payload["stocks"]:
        stack = stacks.setdefault(stock["code"], [])
        volume = stock["volume"]
        while stack and stack[-1][1] < volume:
            stack.pop()
        window = seq - stack[-1][0] if stack else seq + 1
        stack.append((seq, volume))

        fresh = min(window, VOL_HIGH_MAX)
        fresh = fresh if fresh >= 2 else None
        if stock.get("vh") != fresh:
            changed = True
            stock.pop("vh", None)
            if fresh:
                stock["vh"] = fresh
    return changed


def run_days(run, side, emitted):
    """更新「連續在同一側幾天」：回傳新的 (側, 天數, 是否被資料截斷)。

    run 為 None 代表昨天算不出來——那今天是「有資料以來的第一天」，不是剛穿越，
    所以標成截斷；真的換邊才從 1 重新起算。
    """
    if run is None or not emitted:
        return (side, 1, True)
    if run[0] == side:
        return (side, min(run[1] + 1, MA_STREAK_MAX), run[2])
    return (side, 1, False)


def run_value(run):
    """截斷又還沒走滿 MA_TRUST_DAYS 天的一律當資料不足，不然報成「剛穿越」是假訊號。"""
    if run is None:
        return None
    return None if run[2] and run[1] < MA_TRUST_DAYS else run[0] * run[1]


class MaTracker:
    """單一市場的技術面狀態機：一天餵一次全市場收盤價，吐出當日的均線與 MACD。

    均線與 EMA 都只有在收盤價「連續」時才算得準，所以每一檔都盯著自己上一次出現在
    第幾個交易日；中間斷過（停牌、剛上市、資料起點）就整個重來，寧可算不出來也不硬算。
    """

    def __init__(self):
        self.seq = 0            # 這個市場已經走過幾個交易日
        self.codes = {}         # code -> {"seq", "closes", "runs"}

    def reset(self):
        """這一天沒有收盤價檔（回補還沒補到）：連續性就斷在這裡。"""
        self.codes.clear()

    def feed(self, closes: dict) -> dict:
        self.seq += 1
        out = {}
        for code, close in closes.items():
            state = self.codes.get(code)
            if state is None or state["seq"] != self.seq - 1:
                state = {"seq": 0,
                         "closes": deque(maxlen=max(MA_WINDOWS)),
                         "runs": [None] * len(MA_WINDOWS),
                         "days": 0,          # 連續有收盤價的天數，EMA 夠不夠熟看它
                         "ema": None,        # (快線 EMA, 慢線 EMA, 訊號線 DEA)
                         "cross": None}      # MACD 柱在同一側連續幾天
                self.codes[code] = state
            state["seq"] = self.seq
            state["closes"].append(close)
            out[code] = self._step(state, close)
        return out

    def _step(self, state, close) -> dict:
        return {**self._moving_averages(state, close), **self._macd(state, close)}

    def _macd(self, state, close) -> dict:
        """DIF＝快線 EMA − 慢線 EMA，DEA＝DIF 的 EMA，柱＝DIF − DEA。

        存的是三條 EMA 而不是 DIF／DEA／柱：前端有了 EMA 才推得出「明天收在多少
        就會交叉」——那是解出來的價位，不是預測。
        """
        state["days"] += 1
        fast, slow, sig = (2 / (n + 1) for n in (MACD_FAST, MACD_SLOW, MACD_SIGNAL))
        if state["ema"] is None:
            ema_fast = ema_slow = close      # 起點就是第一天的收盤價，靠時間把它稀釋掉
            dea = 0.0
        else:
            ema_fast, ema_slow, dea = state["ema"]
            ema_fast += fast * (close - ema_fast)
            ema_slow += slow * (close - ema_slow)
            dea += sig * ((ema_fast - ema_slow) - dea)
        state["ema"] = (ema_fast, ema_slow, dea)

        emitted = state["days"] >= MACD_WARMUP
        if not emitted:
            state["cross"] = None
            return {}
        side = 1 if (ema_fast - ema_slow) > dea else -1
        state["cross"] = run_days(state["cross"], side, state["cross"] is not None)
        return {"macd": [round(ema_fast, 3), round(ema_slow, 3), round(dea, 3),
                         run_value(state["cross"])]}

    def _moving_averages(self, state, close) -> dict:
        # 由近而遠累加一次，四條線一起算出來
        averages = [None] * len(MA_WINDOWS)
        total = 0.0
        wanted = {w: i for i, w in enumerate(MA_WINDOWS)}
        for days, price in enumerate(reversed(state["closes"]), start=1):
            total += price
            if days in wanted:
                averages[wanted[days]] = total / days

        status = []
        for i, average in enumerate(averages):
            run = state["runs"][i]
            if average is None:
                state["runs"][i] = None
                status.append(None)
                continue
            run = run_days(run, 1 if close > average else -1, run is not None)
            state["runs"][i] = run
            status.append(run_value(run))

        return {
            "ma": status,
            "mav": [None if a is None else round(a, 2) for a in averages],
        }


def load_closes(date_iso: str, scope: str):
    path = twse.close_path(date_iso, scope)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))["c"]


# 這三個欄位由 stamp_ma 就地補進 daily 檔，算不出來就整個拿掉，不留半截舊值
TECH_FIELDS = ("ma", "mav", "macd")


def stamp_ma(payload, tech_today) -> bool:
    """替當日前 200 名補上均線與 MACD。

    `ma` 是四個帶正負號的整數，依序對應 5／10／20／60 日線：
    正數＝已站上幾個交易日（1 就是今天剛站上），負數＝已跌破幾天，null＝資料不足。
    收盤價等於均線時算跌破那一側。天數最多算到 60，前端顯示成 60+。
    `mav` 是同樣順序的四條均線價。

    `macd` 是 [快線 EMA, 慢線 EMA, DEA, 交叉天數]：前三個給前端推「明天收在多少
    就會交叉」，第四個與 `ma` 同一套約定（正＝黃金交叉後第幾天、負＝死亡交叉）。
    """
    changed = False
    for stock in payload["stocks"]:
        entry = tech_today.get(stock["code"]) if stock["rank"] <= twse.STREAK_RANK else None
        fresh = dict(entry) if entry else {}
        # 四條線全都算不出來就別留空陣列，省下每天 200 筆的 [null,null,null,null]
        if "ma" in fresh and all(v is None for v in fresh["ma"]):
            fresh.pop("ma")
            fresh.pop("mav", None)
        for key in TECH_FIELDS:
            if stock.get(key) != fresh.get(key):
                changed = True
            stock.pop(key, None)
        stock.update(fresh)
    return changed


def write_if_changed(path, payload) -> bool:
    """內容沒變就不重寫，避免每天產生無謂的 git 差異。"""
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return True


def main() -> int:
    dates = sorted(set(twse.existing_dates("twse")) | set(twse.existing_dates("tpex")))
    if not dates:
        print("docs/data/daily/ 沒有任何資料，請先執行 fetch_daily.py 或 backfill.py")
        return 1

    # 以下每個 dict 的鍵都是 scope
    streaks = {s: {} for s in twse.SCOPES}
    ma_trackers = {m: MaTracker() for m in ("twse", "tpex")}   # 技術面與範圍無關，價就是價
    vol_stacks = {s: {} for s in twse.SCOPES}     # scope -> code -> 單調遞減的 (日序, 量)
    vol_seq = {s: 0 for s in twse.SCOPES}         # scope -> 這個範圍已經走過幾個交易日
    by_year = {s: defaultdict(lambda: {"dates": [], "stocks": {}}) for s in twse.SCOPES}
    series = {s: {"marketValues": [], "top200Values": [], "top10Values": []} for s in twse.SCOPES}
    missing = defaultdict(list)
    rewritten = defaultdict(int)

    for day_index, date_iso in enumerate(dates):
        # 均線與 MACD 吃的是全市場收盤價（docs/data/close/），跟排行的前 300 名無關
        tech_today = {}
        for market, tracker in ma_trackers.items():
            closes = load_closes(date_iso, market)
            if closes is None:
                tracker.reset()
            else:
                tech_today.update(tracker.feed(closes))

        days = {scope: load_day(date_iso, scope) for scope in ("twse", "tpex")}
        both = days["twse"] and days["tpex"]
        days["all"] = merge_day(date_iso, days["twse"], days["tpex"]) if both else None

        for scope in twse.SCOPES:
            payload = days[scope]
            if payload is None:
                # 這一天缺資料：三條序列都補 null，連續進榜天數也會自然中斷
                missing[scope].append(date_iso)
                for key in series[scope]:
                    series[scope][key].append(None)
                continue

            changed = update_streaks(payload, day_index, date_iso, streaks[scope])
            # 新高天數要以「這個範圍自己的交易日」計數，缺資料的日子不能算進去
            changed |= stamp_vol_high(payload, vol_stacks[scope], vol_seq[scope])
            vol_seq[scope] += 1
            changed |= stamp_ma(payload, tech_today)
            if scope == "all" or changed:
                if write_if_changed(twse.daily_path(date_iso, scope), payload):
                    rewritten[scope] += 1

            stocks = payload["stocks"]
            series[scope]["marketValues"].append(round(payload["marketValue"] / 1e8, 2))
            series[scope]["top200Values"].append(
                round(sum(s["value"] for s in stocks if s["rank"] <= twse.STREAK_RANK) / 1e8, 2))
            series[scope]["top10Values"].append(
                round(sum(s["value"] for s in stocks if s["rank"] <= 10) / 1e8, 2))

            bucket = by_year[scope][date_iso[:4]]
            bucket["dates"].append(date_iso)
            year_index = len(bucket["dates"]) - 1
            for stock in stocks:
                entry = bucket["stocks"].get(stock["code"])
                if entry is None:
                    entry = {"name": stock["name"], "p": []}
                    bucket["stocks"][stock["code"]] = entry
                entry["name"] = stock["name"]      # 沿用最新名稱（公司可能改名）
                entry["p"].append([year_index, stock["rank"], round(stock["value"] / 1e8, 2)])

    for scope in twse.SCOPES:
        folder = twse.HISTORY_DIR / scope
        folder.mkdir(parents=True, exist_ok=True)
        for year, bucket in sorted(by_year[scope].items()):
            path = twse.history_path(year, scope)
            write_if_changed(path, {"year": int(year), **bucket})
            print(f"  {scope}/{year}.json：{len(bucket['dates'])} 個交易日、"
                  f"{len(bucket['stocks'])} 檔曾進榜（{path.stat().st_size / 1024:,.0f} KB）")

        valid = {f"{year}.json" for year in by_year[scope]}
        for stale in folder.glob("*.json"):
            if stale.name not in valid:
                stale.unlink()
                print(f"  移除過期檔案 {scope}/{stale.name}")

    twse.write_json(
        twse.INDEX_PATH,
        {
            "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
            "latest": dates[-1],
            "years": sorted({d[:4] for d in dates}, reverse=True),
            "dates": dates,
            "scopes": {s: series[s] for s in twse.SCOPES},
        },
    )
    print(f"index.json：{len(dates)} 個交易日（{dates[0]} ~ {dates[-1]}）")

    for scope in twse.SCOPES:
        if rewritten[scope]:
            print(f"{twse.SCOPE_NAMES[scope]}：更新了 {rewritten[scope]} 個每日檔")
        gaps = missing[scope]
        if gaps:
            span = f"{gaps[0]} ~ {gaps[-1]}" if len(gaps) > 1 else gaps[0]
            print(f"! {twse.SCOPE_NAMES[scope]}：{len(gaps)} 個交易日沒有資料（{span}），"
                  f"這些天的連續進榜天數會從中斷處重新起算")
    return 0


if __name__ == "__main__":
    sys.exit(main())
