"""策略頁 → docs/data/strategy.json：今天的訊號、實盤追蹤的模擬持股、近一年照規則跑的淨值。

    python scripts/build_strategy.py

規則與算式在 scripts/strategy.py（回測 backtest_strategy.py 用同一份）。這支只讀網站上的資料
（docs/data，只留兩年），所以：

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
YEAR = 250
OUT = os.path.join(SITE, "strategy.json")
TPE = timezone(timedelta(hours=8))

# 5 年回測（2022-04 ～ 2026-10，長歷史，scripts/backtest_strategy.py）。數字的出處與算法在 BACKTEST.md。
# 組合的結果有路徑依賴（一筆不同，後面整串跟著變），所以報 30 種挑股順序的中位數與範圍，不報單一一條。
RESEARCH = {
    "period": "2022-04 ～ 2026-10",
    "rows": [
        {"k": "前段 2022-04 ～ 2024-06", "s": 63, "lo": 35, "hi": 93, "b": 52, "win": 67},
        {"k": "後段 2024-07 ～ 2026-10", "s": 166, "lo": 116, "hi": 207, "b": 143, "win": 70},
    ],
    "rand": {"a": 25, "b": 40, "win": "7～13"},
    "years": [
        {"y": "2022", "win": 0, "pt": -15}, {"y": "2023", "win": 97, "pt": 27}, {"y": "2024", "win": 60, "pt": 3},
        {"y": "2025", "win": 47, "pt": -2}, {"y": "2026", "win": 80, "pt": 27},
    ],
    "trade": {"win": 48, "n": 486},
    "notes": [
        "「營收創新高」這個條件是從 2024-06 以前的資料挖出來的，後段才是沒參與挑選的考試——而後段是 AI 多頭",
        "2022 空頭那一年，30 種挑股順序全部輸 0050（中位數少 15 個百分點）；2025 年大約五五波",
        "每筆勝率不到一半，賺在少數大漲的股票；抱 10 天或 60 天都會輸 0050，20 天附近才成立",
        "同一套進出規則改成隨機選股，只有 7～13% 的路徑贏 0050——差別在選股條件，不是剛好買了小型股",
    ],
}


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

    def stats(res, start):
        e, b = res["eq"][start:], res["bench"][start:]
        r = [t["r"] for t in res["trades"]]
        return {
            "ret": pct(e[-1] - 1), "bret": pct(b[-1] - 1),
            "mdd": pct(S.max_drawdown(e)), "bmdd": pct(S.max_drawdown(b)),
            "n": len(r), "win": pct(np.mean([x > 0 for x in r])) if r else None,
            "avg": pct(np.mean(r)) if r else None,
        }

    def curve(res, start):
        return {"dates": dates[start:], "eq": [round(float(x), 4) for x in res["eq"][start:]],
                "bench": [round(float(x), 4) for x in res["bench"][start:]]}

    # 實盤追蹤
    li = next((i for i, d in enumerate(dates) if d >= LIVE_FROM), None)
    live = {"from": LIVE_FROM, "started": li is not None}
    staying = set()
    if li is not None:
        res = S.simulate(D, sig, li)
        stay = [p for p in res["open"] if p["x"] > T]               # 明天開盤還不用賣的
        staying = {p["k"] for p in stay}
        live.update({
            "holdings": [holding(p) for p in sorted(res["open"], key=lambda p: p["e"])],
            "trades": [trade(t) for t in reversed(res["trades"])],
            "stats": stats(res, li), "curve": curve(res, li),
            "cash": round(float(res["cash"] / res["eq"][last]) * 100, 1),
        })
    free = S.RULE["slots"] - len(staying)

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
    yr = S.simulate(D, sig, ys)
    year = {
        "from": dates[ys], "stats": stats(yr, ys), "curve": curve(yr, ys),
        "holdings": [holding(p) for p in sorted(yr["open"], key=lambda p: p["e"])],
        "trades": [trade(t) for t in reversed(yr["trades"])][:60],
    }

    out = {
        "updated": datetime.now(TPE).isoformat(timespec="seconds"),
        "d": dates[last],
        "rule": S.RULE,
        "signals": signals, "free": free,
        "live": live, "year": year, "research": RESEARCH,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    ls = live.get("stats") or {}
    print(f"{dates[last]}：訊號 {len(signals)} 檔，明天空位 {free}、要買 {n_buy} 檔；"
          f"實盤{'自 ' + LIVE_FROM if li is not None else '尚未開始（' + LIVE_FROM + ' 起）'}"
          f"{'，' + str(ls.get('ret')) + '% vs 0050 ' + str(ls.get('bret')) + '%' if ls else ''}；"
          f"近一年 {year['stats']['ret']}% vs 0050 {year['stats']['bret']}% -> {os.path.relpath(OUT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
