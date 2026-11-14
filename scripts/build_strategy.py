"""策略頁 → docs/data/strategy.json：今天的訊號、實盤追蹤的模擬持股、近一年照規則跑的淨值。

三套策略各一個帳：A＝動能 ＋ 營收創新高（檔案最上層的欄位），B＝好財報 ＋ 開高（"b" 底下同樣的欄位，
另有 mix：A、B 兩個帳各放一半資金的淨值），C＝處置期間（"c"，mix 是三個帳各放三分之一）。下面的說明三套都適用，
B、C 的實盤追蹤從 LIVE_FROM_B／LIVE_FROM_C 開始，B 還要 events/、C 還要 disposal/。

    python scripts/build_strategy.py

規則與算式在 scripts/strategy.py（回測 backtest_strategy.py 用同一份）。這支只讀網站上的資料
（docs/data，只留兩年），所以：

- 多空：0050 收盤在 120 日線之下時，明天開盤不買新股、閒錢放現金（規則在 strategy.py）
- **實盤追蹤**從 LIVE_FROM 那天開盤開始，之後每一天都是回測沒看過的資料。每天整段重算——規則固定、
  資料不回頭改，重算的結果跟昨天那一段一樣
- **近一年**是最近 YEAR 個交易日照同一套規則跑一次，讓頁面在實盤累積起來之前也有東西看；它每天往前滾，
  不是固定的一段
- 網站的每日原始檔只留 730 天，實盤追蹤需要 LIVE_FROM 前 60 個交易日起的資料，大約 2028-07 會被修剪掉。
  到那之前要改成把已出場的交易寫進檔案、從上次的持股接著算

排在 build_history.py 之後（要 exright/ 與最新的 close/），value/rev 也要已經更新。
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone

import numpy as np

import strategy as S
from gooaye import SITE, load

LIVE_FROM = "2026-10-19"
LIVE_FROM_B = "2026-11-16"      # 策略 B（好財報 ＋ 開高）的實盤追蹤從這天開盤開始
LIVE_FROM_C = "2026-11-16"      # 策略 C（處置期間）
YEAR = 250
OUT = os.path.join(SITE, "strategy.json")
TPE = timezone(timedelta(hours=8))

# 5 年回測（2022-04 ～ 2026-10，長歷史，scripts/backtest_strategy.py）。數字的出處與算法在 BACKTEST.md。
# 組合的結果有路徑依賴（一筆不同，後面整串跟著變），所以報 30 種挑股順序的中位數與範圍，不報單一一條。
RESEARCH = {
    "period": "2022-04 ～ 2026-10",
    "rows": [
        {"k": "前段 2022-04 ～ 2024-06", "s": 109, "lo": 81, "hi": 143, "b": 52, "win": 100},
        {"k": "後段 2024-07 ～ 2026-10", "s": 232, "lo": 140, "hi": 273, "b": 143, "win": 87},
    ],
    "mdd": -29, "bmdd": -27,
    "old": {"a": 55, "b": 158, "wa": 60, "wb": 63, "mdd": -35},       # 不分多空（2026-10-18 以前的版本）
    "rand": {"a": 41, "b": 65, "wa": 30, "wb": 3},                    # 同一套規則（含多空）改成隨機選股
    "years": [
        {"y": "2022", "win": 100, "pt": 10}, {"y": "2023", "win": 100, "pt": 25}, {"y": "2024", "win": 33, "pt": -8},
        {"y": "2025", "win": 67, "pt": 14}, {"y": "2026", "win": 93, "pt": 48},
    ],
    "trade": {"win": 55},
    "notes": [
        "「營收創新高」是從 2024-06 以前的資料挖出來的；「空頭停手」是看過 2022 才加的——5 年裡只有這一次空頭，它只在這一次上驗證過",
        "後段是 AI 多頭；2024 年是弱點，只有三分之一的路徑贏 0050（中位數少 8 個百分點）",
        "選股管多頭、停手管空頭：同一套規則改成隨機選股，2022 一樣贏（停手的功勞），後段卻只有 3% 的路徑贏 0050",
        "每筆勝率約一半出頭，賺在少數大漲的股票；均線出場、移動停利、停利在空頭都更差",
        "組合的結果有路徑依賴：同一套規則只是挑股順序不同，兩年報酬就能差 10～15 個百分點以上",
    ],
}


# 策略 B 的回測（2023-03 ～ 2026-11，長歷史，scripts/backtest_strategy_b.py）。財報要有去年同季可比，
# 所以只有這一段、沒有前後段；同樣報 30 種挑股順序的中位數與範圍。出處在 BACKTEST.md「好財報 ＋ 開高」。
RESEARCH_B = {
    "period": "2023-03 ～ 2026-11",
    "s": 447, "lo": 423, "hi": 468, "b": 270, "win": 100,
    "mdd": -21, "bmdd": -27, "sharpe": 2.05, "bsharpe": 1.59,
    "nobear": {"s": 476, "mdd": -33},                                 # 不分多空
    "k10": {"s": 425, "mdd": -26},                                    # 最多 10 檔
    "rand": {"s": 313, "win": 93},                                    # 同一天隨機挑有季報的股票（含多空）
    "late": [{"d": 1, "s": 390}, {"d": 2, "s": 359}, {"d": 3, "s": 341}, {"d": 5, "s": 285}, {"d": 10, "s": 241}],
    "mix": {"s": 441, "lo": 366, "hi": 530, "mdd": -24, "sharpe": 1.92,          # A、B 各一半
            "a": 435, "alo": 284, "ahi": 630, "amdd": -34, "asharpe": 1.61},     # 同一段只做 A
    "years": [
        {"y": "2023", "win": 100, "pt": 14}, {"y": "2024", "win": 0, "pt": -10},
        {"y": "2025", "win": 73, "pt": 1}, {"y": "2026", "win": 100, "pt": 63},
    ],
    # 每個訊號都買（不受檔數限制）；pwin 是組合裡的每筆勝率
    "trade": {"n": 773, "stocks": 475, "win": 57, "avg": 5.3, "med": 1.8, "gain": 16.1, "loss": -9.2, "pwin": 60},
    "notes": [
        "沒有樣本外：只有 3 年 8 個月、約 14 季，幾乎都是多頭；門檻（年增 30%、開高 2%）是在同一段資料上定的。真正的考試是實盤追蹤",
        "2024 年每一條路徑都輸 0050（中位數少 10 個百分點），2025 年打平；超額主要來自 2023 與 2026",
        "賺在賺賠比，不在勝率：每筆只有一半贏同期的 0050，但賺的那筆平均是賠的將近兩倍",
        "空頭時訊號變差（99 筆平均 −3.1%、44% 賺錢），所以帶空頭停手；5 年裡的空頭天數只有 11%",
        "出場試過 21 種：固定 15～20 天最好，25 天以上、均線、移動停利都比較差；停損、停利跟不設差不多",
        "只做電子股 +433%、只做非電子股 +265%（輸 0050）：訊號在兩邊都比隨機挑好，但非電子股這幾年本身就弱",
        "訊號裡月營收也創 12 個月新高的 234 筆，每筆平均多賺 3 個百分點、每年都是正的——事後看的交集，還沒放進規則",
    ],
}


# 策略 C 的回測（2022-04 ～ 2026-11，長歷史，scripts/backtest_strategy_c.py）。30 種挑股順序的中位數與範圍。
# 出處在 BACKTEST.md「處置期間」。2026-08-07 起處置從 10 個交易日改成 5 個，長歷史幾乎都是舊制。
RESEARCH_C = {
    "period": "2022-04 ～ 2026-11",
    "rows": [
        {"k": "前段 2022-04 ～ 2024-06", "s": 192, "lo": 158, "hi": 212, "b": 52, "win": 100},
        {"k": "後段 2024-07 ～ 2026-11", "s": 357, "lo": 256, "hi": 412, "b": 128, "win": 100},
    ],
    "mdd": -41, "bmdd": -27, "sharpe": 1.69, "bsharpe": 1.26,
    "ctrl": {"a": 8, "b": 32, "wa": 0, "wb": 0},                      # 同一天、漲幅相近、沒被處置的股票
    "bear": {"a": 155, "b": 425, "mdd": -30},                         # 加上空頭停手、閒錢放現金
    "slip": [{"p": 0.5, "a": 146, "b": 253, "wb": 100}, {"p": 1.0, "a": 92, "b": 173, "wb": 83},
             {"p": 1.5, "a": 55, "b": 90, "wb": 20}, {"p": 2.0, "a": 31, "b": 46, "wb": 0}],
    "last5": {"a": 231, "b": 471, "mdd": -37},                        # 只抱最後 5 天（等於新制的長度）
    "fixed": [{"d": 5, "a": 25, "b": 96}, {"d": 20, "a": 24, "b": 78}],   # 不管處置到哪天、固定抱幾天
    "new": {"from": "2026-08-07", "n": 176, "s": 3, "lo": 0, "hi": 10, "b": -1, "win": 90, "x": 1.3, "xmed": 1.8},
    "mix": {"from": "2023-03", "s": 606, "lo": 535, "hi": 680, "mdd": -27, "sharpe": 2.00,     # 三套各三分之一
            "ab": 441, "abmdd": -25, "absharpe": 1.92, "c": 905, "cmdd": -41, "csharpe": 1.82,
            "ca": 0.50, "cb": 0.29, "abc": 0.50},                     # 減 0050 之後 10 日報酬的相關
    "years": [
        {"y": "2022", "win": 100, "pt": 20}, {"y": "2023", "win": 100, "pt": 35}, {"y": "2024", "win": 100, "pt": 65},
        {"y": "2025", "win": 100, "pt": 27}, {"y": "2026", "win": 100, "pt": 64},
    ],
    # 每個訊號都買（不受檔數限制）；x／xmed 是減同期 0050 的平均與中位數，cut5 是拿掉最賺的 5% 之後的平均，
    # big 是單筆賠超過 20% 的比例；pwin 是組合裡的每筆勝率
    "trade": {"n": 2002, "win": 54, "avg": 2.9, "med": 1.2, "gain": 13.3, "loss": -9.7, "x": 1.5, "xmed": 0.5,
              "cut5": 0.7, "big": 5.4, "pwin": 54},
    "notes": [
        "新制只有 3 個月：2026-08-07 起處置從 10 個交易日改成 5 個，上面的 5 年回測幾乎都是舊制。新制 176 筆，方向一樣、樣本太短",
        "怕滑價：每筆平均只賺 2.9%、抱不到 10 天。來回多扣 1% 還贏，多扣 1.5% 就跟 0050 打平。"
        "回測用的是開盤與收盤的集合競價價格，處置股量縮，實際成交價要實盤才知道",
        "回落比 0050 大（−41% 對 −27%）：買的都是剛大漲過的股票，5% 的交易單筆賠超過 20%",
        "賺在少數幾筆：拿掉最賺的 5%，每筆平均只剩 +0.7%；每筆只有一半出頭贏同期的 0050",
        "沒有樣本外：這個效果是 2026-10 的事件研究在同一段資料上發現的，組合的規則也是照那個結果定的",
        "報酬集中在處置快結束的那幾天（舊制最後兩天各多 0.7～1.0%），出關後頭兩天各跌約 0.5%——所以最後一天收盤就賣，不等出關",
        "不看多空：2022 年也贏 0050，加上空頭停手前段少賺 37 個百分點、回落小 11 點；空頭只有 2022 一次，兩種都說得通",
        "處置期間是分盤撮合，買進可能要預收款券（戶頭要先有錢），不能當沖",
    ],
}


# 外資台指期（不在規則裡，只當參考）：回測在 BACKTEST.md「台指期法人未平倉」（scripts/backtest_futures.py）。
# 放進策略當多空開關會變差，但「空單一個月加得最快」的那 20% 日子，之後 5 天大盤平均約 0%（其他日子 +0.6%）。
FUT_WIN, FUT_CHG, FUT_PCT = 250, 20, 0.2
FUT_RESEARCH = {"fast5": 0.0, "other5": 0.6, "since": "2019-07"}


def futures_note():
    """外資約當大台淨未平倉（大台 ＋ 小台 ÷ 4）、近 20 日變化，與那個變化在近一年裡的百分位。"""
    f = load(os.path.join(SITE, "futures.json"))
    if not f:
        return None
    d = f["d"]
    F = [None if a is None or b is None else a + b / 4 for a, b in zip(f["tx"]["fo"], f["mtx"]["fo"])]
    ok = [(dd, v) for dd, v in zip(d, F) if v is not None]
    if len(ok) < FUT_WIN + FUT_CHG:
        return None
    days, vals = zip(*ok)
    chg = [vals[i] - vals[i - FUT_CHG] for i in range(FUT_CHG, len(vals))]
    win = chg[-FUT_WIN:]
    rank = sum(1 for x in win if x < win[-1]) / len(win)
    return {"d": days[-1], "net": round(vals[-1]), "chg": round(chg[-1]), "rank": round(rank * 100),
            "fast": rank < FUT_PCT, "days": FUT_CHG, "pct": round(FUT_PCT * 100), "research": FUT_RESEARCH}


def pct(x, d=1):
    return None if x is None or not np.isfinite(x) else round(float(x) * 100, d)


def main() -> int:
    D = S.Data([SITE])
    T, dates = D.T, D.dates
    if T < 120:
        print("! 資料不到 120 個交易日，跳過")
        return 0
    sig = S.signals(D)
    ind = (load(os.path.join(SITE, "industry.json")) or {}).get("map") or {}
    last = T - 1

    def row(k, extra):
        c = D.codes[k]
        return {"c": c, "n": D.names.get(c, c), "ind": ind.get(c), **extra}

    def holding(p):
        k = p["k"]
        return row(k, {
            "sd": dates[p["s"]], "ed": dates[p["e"]],
            "day": last - p["e"] + 1, "left": p["x"] - last,             # 還要抱幾個交易日（明天開盤賣是 1）
            "px": float(D.RO[p["e"], k]), "now": float(D.RCf[last, k]),
            "r": pct(D.ACf[last, k] / D.AOf[p["e"], k] - 1),
        })

    def trade(t):
        k = t["k"]
        return row(k, {"sd": dates[t["s"]], "ed": dates[t["e"]], "xd": dates[t["x"]], "r": pct(t["r"])})

    def risk(x, ds):
        """一條淨值的近期表現與風險：近 20／60 日、距最高點、年化波動、夏普（不扣無風險利率）"""
        r = np.diff(x) / x[:-1]
        peak = int(np.argmax(x))
        return {
            "r20": pct(x[-1] / x[-21] - 1) if len(x) > 20 else None,
            "r60": pct(x[-1] / x[-61] - 1) if len(x) > 60 else None,
            "dd": pct(x[-1] / x[peak] - 1), "peak": ds[peak],
            "vol": pct(r.std() * np.sqrt(245)) if len(r) > 20 else None,
            "sharpe": round(float(r.mean() / r.std() * np.sqrt(245)), 2) if len(r) > 20 and r.std() > 0 else None,
        }

    def months(e, b, ds):
        """每個月的報酬（上個月最後一天收盤 → 這個月最後一天收盤；第一個月從起點算）"""
        out, prev = [], 0
        ends = [i for i in range(len(ds)) if i == len(ds) - 1 or ds[i + 1][:7] != ds[i][:7]]
        for i in ends:
            base_e = e[prev] if prev else 1.0
            base_b = b[prev] if prev else 1.0
            out.append({"m": ds[i][:7], "s": pct(e[i] / base_e - 1), "b": pct(b[i] / base_b - 1)})
            prev = i
        return out

    def stats(res, start):
        e, b = res["eq"][start:], res["bench"][start:]
        ds = dates[start:]
        r = [t["r"] for t in res["trades"]]
        return {
            "ret": pct(e[-1] - 1), "bret": pct(b[-1] - 1),
            "mdd": pct(S.max_drawdown(e)), "bmdd": pct(S.max_drawdown(b)),
            "n": len(r), "win": pct(np.mean([x > 0 for x in r])) if r else None,
            "avg": pct(np.mean(r)) if r else None,
            "s": risk(e, ds), "b": risk(b, ds), "months": months(e, b, ds),
        }

    def curve(res, start):
        return {"dates": dates[start:], "eq": [round(float(x), 4) for x in res["eq"][start:]],
                "bench": [round(float(x), 4) for x in res["bench"][start:]]}

    def holding_c(p):
        """策略 C 的持股：抱到處置迄日收盤；sell＝"open" 是最後一天收盤跌停沒賣掉、明天開盤賣"""
        k = p["k"]
        return row(k, {
            "sd": dates[p["s"]], "ed": dates[p["e"]], "day": last - p["e"] + 1,
            "to": p["to"], "k": p["n"], "sell": p["mode"],
            "px": float(D.RO[p["e"], k]), "now": float(D.RCf[last, k]),
            "r": pct(D.ACf[last, k] / D.AOf[p["e"], k] - 1),
        })

    def track(runner, sg, since, holding=holding, stay=lambda p: p["x"] > T):
        """實盤追蹤：(頁面要的 dict, 明天開盤還不用賣的那幾檔, 模擬結果, 起點)"""
        li = next((i for i, d in enumerate(dates) if d >= since), None)
        live = {"from": since, "started": li is not None}
        if li is None:
            return live, set(), None, None
        res = runner(D, sg, li)
        staying = {p["k"] for p in res["open"] if stay(p)}
        live.update({
            "holdings": [holding(p) for p in sorted(res["open"], key=lambda p: p["e"])],
            "trades": [trade(t) for t in reversed(res["trades"])],
            "stats": stats(res, li), "curve": curve(res, li),
            "cash": round(float(res["cash"] / res["eq"][last]) * 100, 1),
        })
        return live, staying, res, li

    def yearly(runner, sg, ys, holding=holding):
        yr = runner(D, sg, ys)
        return yr, {
            "from": dates[ys], "stats": stats(yr, ys), "curve": curve(yr, ys),
            "holdings": [holding(p) for p in sorted(yr["open"], key=lambda p: p["e"])],
            "trades": [trade(t) for t in reversed(yr["trades"])][:60],
        }

    def mix(eqs, bench, start):
        """幾個帳各放一樣多的資金（各跑各的，淨值相加）。比 start 早開始的帳，用起點前一天的收盤當 1"""
        parts = [e / (e[start - 1] if np.isfinite(e[start - 1]) else 1.0) for e in eqs]
        res = {"eq": sum(parts) / len(parts), "bench": bench, "trades": []}
        return {"from": dates[start], "stats": stats(res, start), "curve": curve(res, start)}

    # 實盤追蹤
    live, staying, res_a, li = track(S.run, sig, LIVE_FROM)
    # 多空：0050（還原）收盤在 120 日線之下是空頭，明天開盤不買新股、閒錢放現金
    n = S.RULE["regime_ma"]
    reg = S.regime_ma(D, n)
    bull = bool(reg[last])
    ma_now = float(np.mean(D.b_close[last - n + 1:last + 1]))
    flip = next((i for i in range(last, 0, -1) if reg[i - 1] != reg[i]), 0)
    regime = {
        "bull": bull, "ma": n, "since": dates[flip],
        "gap": pct(D.b_close[last] / ma_now - 1),
        "close": D.P.C["0050"].get(last),
    }
    regime["fut"] = futures_note()
    cap = S.RULE["slots"] if bull else S.RULE["bear_slots"]
    free = max(0, cap - len(staying))

    # 今天收盤後的訊號：照 20 日漲幅排，明天開盤依空位依序買（開盤漲停的跳過，得等開盤才知道）
    cand = sorted(np.nonzero(sig[last])[0], key=lambda k: -np.nan_to_num(D.ret20[last, k]))
    signals, n_buy = [], 0
    for k in cand:
        info = D.rev_info(k, last)
        held = k in staying
        buy = not held and n_buy < free
        n_buy += buy
        signals.append(row(k, {
            "close": float(D.RC[last, k]), "r20": pct(D.ret20[last, k]),
            "m": info[0] if info else None, "yoy": info[2] if info else None,
            "held": held, "buy": bool(buy),
        }))

    # 近一年
    ys = max(70, T - YEAR)
    yr, year = yearly(S.run, sig, ys)

    # ---- 策略 B：好財報 ＋ 開高（規則在 strategy.py 的 RULE_B；多空開關跟 A 同一個）
    sigb, info = S.signals_b(D)
    live_b, staying_b, res_b, lb = track(S.run_b, sigb, LIVE_FROM_B)
    cap_b = S.RULE_B["slots"] if bull else S.RULE_B["bear_slots"]
    free_b = max(0, cap_b - len(staying_b))
    signals_b, n_buy_b = [], 0
    for k in sorted(np.nonzero(sigb[last])[0], key=lambda k: -np.nan_to_num(D.ret20[last, k])):
        g, react, p1 = info[(last, k)]
        held = k in staying_b
        buy = not held and n_buy_b < free_b
        n_buy_b += buy
        signals_b.append(row(k, {
            "close": float(D.RC[last, k]), "r20": pct(D.ret20[last, k]),
            "q": f"{p1[:4]} Q{int(p1[5:7]) // 3}", "g": pct(g) if isinstance(g, float) else None,
            "gt": g if isinstance(g, str) else None, "react": pct(react),
            "held": held, "buy": bool(buy),
        }))
    yr_b, year_b = yearly(S.run_b, sigb, ys)
    b = {
        "rule": S.RULE_B, "signals": signals_b, "free": free_b,
        "live": live_b, "year": year_b, "research": RESEARCH_B,
        "mix": {
            "live": mix([res_a["eq"], res_b["eq"]], res_b["bench"], lb) if res_a and res_b and lb > li else None,
            "year": mix([yr["eq"], yr_b["eq"]], yr_b["bench"], ys),
        },
    }

    # ---- 策略 C：處置期間（規則在 strategy.py 的 RULE_C；不看多空）
    evc = S.disposal_events(D)

    def stay_c(p):
        return p["mode"] == "close"                       # 收盤跌停延到明天開盤賣的，明天就空出來

    live_c, staying_c, res_c, lc = track(S.run_c, evc, LIVE_FROM_C, holding=holding_c, stay=stay_c)
    free_c = max(0, S.RULE_C["slots"] - len(staying_c))
    up10 = D.ACf[last] / D.ACf[last - 10] - 1
    signals_c, n_buy_c = [], 0
    for e in sorted((e for e in evc if e["s"] == last), key=lambda e: -np.nan_to_num(D.ret20[last, e["k"]])):
        k = e["k"]
        held = k in staying_c
        buy = not held and n_buy_c < free_c
        n_buy_c += buy
        signals_c.append(row(k, {
            "close": float(D.RCf[last, k]), "r20": pct(D.ret20[last, k]), "r10": pct(up10[k]),
            "k": e["n"], "fr": e["fr"], "to": e["to"], "held": held, "buy": bool(buy),
        }))
    yr_c, year_c = yearly(S.run_c, evc, ys, holding=holding_c)
    c = {
        "rule": S.RULE_C, "signals": signals_c, "free": free_c,
        "live": live_c, "year": year_c, "research": RESEARCH_C,
        "mix": {
            "live": (mix([res_a["eq"], res_b["eq"], res_c["eq"]], res_c["bench"], lc)
                     if res_a and res_b and res_c and lc >= lb > li else None),
            "year": mix([yr["eq"], yr_b["eq"], yr_c["eq"]], yr_c["bench"], ys),
        },
    }

    out = {
        "updated": datetime.now(TPE).isoformat(timespec="seconds"),
        "d": dates[last],
        "rule": S.RULE,
        "signals": signals, "free": free, "regime": regime,
        "live": live, "year": year, "research": RESEARCH,
        "b": b, "c": c,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    ls = live.get("stats") or {}
    print(f"{dates[last]}：訊號 {len(signals)} 檔，明天空位 {free}、要買 {n_buy} 檔；"
          f"實盤{'自 ' + LIVE_FROM if li is not None else '尚未開始（' + LIVE_FROM + ' 起）'}"
          f"{'，' + str(ls.get('ret')) + '% vs 0050 ' + str(ls.get('bret')) + '%' if ls else ''}；"
          f"{'多頭' if bull else '空頭'}（0050 距 {n} 日線 {regime['gap']}%）；"
          f"近一年 {year['stats']['ret']}% vs 0050 {year['stats']['bret']}%")
    lsb = live_b.get("stats") or {}
    print(f"  B（好財報＋開高）：訊號 {len(signals_b)} 檔，明天空位 {free_b}、要買 {n_buy_b} 檔；"
          f"實盤{'自 ' + LIVE_FROM_B if lb is not None else '尚未開始（' + LIVE_FROM_B + ' 起）'}"
          f"{'，' + str(lsb.get('ret')) + '% vs 0050 ' + str(lsb.get('bret')) + '%' if lsb else ''}；"
          f"近一年 {year_b['stats']['ret']}% vs 0050 {year_b['stats']['bret']}%")
    lsc = live_c.get("stats") or {}
    print(f"  C（處置期間）：今天公布 {len(signals_c)} 檔，明天空位 {free_c}、要買 {n_buy_c} 檔；"
          f"實盤{'自 ' + LIVE_FROM_C if lc is not None else '尚未開始（' + LIVE_FROM_C + ' 起）'}"
          f"{'，' + str(lsc.get('ret')) + '% vs 0050 ' + str(lsc.get('bret')) + '%' if lsc else ''}；"
          f"近一年 {year_c['stats']['ret']}% vs 0050 {year_c['stats']['bret']}% -> {os.path.relpath(OUT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
