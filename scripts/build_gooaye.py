"""MK 頁（gooaye.html）-> docs/data/gooaye.json。

把 MK 693 集裡講過的規則，拿網站的資料一條一條驗過（BACKTEST.md 的三節「MK 的……」），
這一頁只做兩件事：

1. **大盤溫度計**：加權指數相對季線、年線的位置（照他的原話跑一遍狀態），融資水位、維持率、券資比，
   以及 VIX、油價、初領失業金（macro.json）。
2. **今天的清單**：只列回測成立的規則挑出來的股票，以及回測說要避開的。
   算式跟回測共用 gooaye.py，定義跟 BACKTEST.md 一字不差——頁面上列的就是回測測的那個東西。

規則記分板（RULES）是回測的結論，每次重跑回測後手動更新這裡的數字；它是研究結果，不是每天會變的資料。

    python scripts/build_gooaye.py
"""

from __future__ import annotations

import statistics as st
from datetime import date

import twse
from gooaye import Prices, common, load_revenue, ma, prev_month, rev_streaks, roll_prev

OUT = twse.DATA_DIR / "gooaye.json"
RECENT = 5          # 價格型態的清單看最近幾個交易日
DRIFT_DAYS = 20     # 營收創高之後的漂移，回測持有 20 個交易日
TOP = 80            # 每份清單最多列幾檔

# ---------------------------------------------------------------------------
# 規則記分板：他講過的規則、我們的資料怎麼說。數字出自 BACKTEST.md 2026-10-11 的三節。
# verdict：ok 成立／bull 只在多頭成立／risk 只能控風險／weak 證據不足／no 不成立
# ---------------------------------------------------------------------------
RULES = [
    {"k": "drift", "era": "2020–21", "rule": "月營收 10 號出來再進場已經晚了", "verdict": "no",
     "stat": "營收創歷史新高＋YoY>20%，11 日開盤才進場，之後 20 日超額 +2.98%（t 8.9），2022 空頭 +1.32%",
     "note": "公布期間確實先漲 +3.4%，但公布後還有一段。全部規則裡最強的一條，下面清單第一份就是它"},
    {"k": "accel", "era": "2023–26", "rule": "營收要配股價確認：營收加速、股價突破", "verdict": "ok",
     "stat": "股價創 12 個月新高＋營收 YoY 連 2 月加速，下個月超額 +2.37%（t 3.0）；沒加速的只有 +1.12%",
     "note": "6 個年度都是正的；中位數 +1.28%，效果有一部分來自少數大漲股"},
    {"k": "lowbase", "era": "2020–21", "rule": "YoY 高要先看是不是低基期", "verdict": "ok",
     "stat": "YoY>30% 但營收不到近兩年高點的 9 成：下個月超額 +0.14%（t 0.9），等於隨機",
     "note": "營收要創新高才算數；低基期的高 YoY 列在避開清單"},
    {"k": "base", "era": "2020–21", "rule": "整理一兩季、上方沒套牢的突破才算", "verdict": "ok",
     "stat": "創 250 日新高、舊高在 120 天前：20 日超額 +2.16%（t 3.7），2022 空頭 +0.82%",
     "note": "對照：舊高就在 20 天內的連續創高，2022 是 −3.50%"},
    {"k": "newlow", "era": "2023–24", "rule": "創新低當天不抄底", "verdict": "ok",
     "stat": "創 250 日新低：20 日超額 −1.35%（t −3.7）、60 日 −3.94%，2022 也沒反彈",
     "note": ""},
    {"k": "hotbreak", "era": "2025–26", "rule": "熱門股一次殺破季線就先閃", "verdict": "ok",
     "stat": "60 日漲幅前 10%、連 40 天在季線上，第一次跌破：5 日超額 −0.72%（t −2.5）、20 日 −1.15%",
     "note": "短線成立，60 日之後就沒差"},
    {"k": "ma60", "era": "2022", "rule": "大盤跌破季線就不做多，季線轉正才回來", "verdict": "risk",
     "stat": "加權指數 2000 年起：最大回落 −58% → −27%，但年化 8.98% → 7.72%",
     "note": "是風控、不是賺錢工具；2009 年以後兩段都輸買進持有"},
    {"k": "ma240", "era": "2023–24", "rule": "加權指數跌破年線就閉眼分批買", "verdict": "ok",
     "stat": "在年線下買進，之後 120 日平均 +7.51%（全部日子 +5.43%），20 日內沒有優勢",
     "note": "要抱得夠久；跟上一條不矛盾：個股不做多，指數可以左側"},
    {"k": "black", "era": "2023–24", "rule": "指數高檔出長黑就先降槓桿", "verdict": "no",
     "stat": "26 年 35 次：之後 20 日平均 +2.27%、69% 上漲；長黑後空手 20 天年化只剩 6.68%",
     "note": "看到長黑就降槓桿會少賺"},
    {"k": "margin", "era": "2022、2025", "rule": "融資斷頭潮、融資大減是底部", "verdict": "ok",
     "stat": "大盤融資維持率 < 145% 之後 20 日加權指數 +6.60%（84% 上漲）；融資 20 日減少 15% 以上 +7.48%（100%）",
     "note": "只有 2022、2025-04、2026-07 這幾段，樣本少；融資暴增是不是過熱，五年裡只有一段看不出來"},
    {"k": "vix", "era": "2022", "rule": "VIX 彈破 30 就加碼", "verdict": "ok",
     "stat": "加權指數 2000 年起，VIX 在 30 以上的日子買進：之後 60 日 +9.44%、120 日 +19.26%（80% 上漲）",
     "note": "要待在高檔才是；剛站上 30 那一天之後 120 日只有 +4.64%，跟平常差不多"},
    {"k": "oil", "era": "2025–26", "rule": "油價在 90 幾美元是承平，120～130 以上就退場", "verdict": "weak",
     "stat": "布蘭特 120 美元以上：之後 60 日加權指數 −11.79%（只有 6% 上漲）；但五段裡 2008／2011／2012／2022 都跌，2026 反而 +30%",
     "note": "只有五段、最新一段相反"},
    {"k": "icsa", "era": "2020–21", "rule": "初領失業金是景氣轉壞的第一個警訊", "verdict": "no",
     "stat": "初領失業金四週平均比去年多 20% 以上的日子：之後 120 日加權指數 +15.06%（77% 上漲）",
     "note": "已經變差的時候股市在築底，拿來當賣出訊號會賣在低點"},
    {"k": "peak", "era": "2025–26", "rule": "營收爆出來、大家猜下個月更好就是尾聲", "verdict": "no",
     "stat": "營收連續創新高第 1／2／3／4+ 個月，下個月超額 +0.94／+1.25／+2.32／+2.69%",
     "note": "越連續越強；他說的可能只發生在少數題材股的頂部"},
    {"k": "nogo", "era": "2025–26", "rule": "營收好、股價不漲是警訊", "verdict": "no",
     "stat": "營收創新高＋YoY>20% 但公布月跑輸大盤：下個月超額 +0.90%，中位數比跑贏的那組還好",
     "note": ""},
    {"k": "sync", "era": "2023–26", "rule": "同族群一起突破比單檔獨漲好", "verdict": "bull",
     "stat": "同產業同日 ≥3 檔創 60 日新高：20 日 +0.77% vs 獨漲 +0.46%（都不顯著），2022 兩邊都負",
     "note": ""},
    {"k": "regain", "era": "2025–26", "rule": "大跌後最先站回前高的是新主流", "verdict": "weak",
     "stat": "0050 回落 ≥10% 的 6 個波段，低點後第 10 天已站回前高：20 日 +0.47%（t 2.0），60 日 −0.28%",
     "note": "樣本只有 6 次"},
    {"k": "trust", "era": "2022", "rule": "台股看投信：投信連買＋族群轉強", "verdict": "no",
     "stat": "投信連買 3 天＋同產業 ≥3 檔：20 日 +1.65%；反向的投信連賣 3 天 +1.50%，一樣好",
     "note": "漲是因為挑到大型股，不是投信"},
    {"k": "chips", "era": "2020–26", "rule": "不看分點、不太信法人籌碼", "verdict": "ok",
     "stat": "5 年回測：外資、投信、土洋同買都只在多頭有效，2022 空頭裡土洋同買 −1.76%",
     "note": "見 BACKTEST.md 5 年版"},
]


def load_names():
    names = dict((twse.read_json(twse.DATA_DIR / "industry.json") or {}).get("names") or {})
    return names


def taiex_state():
    x = twse.read_json(twse.DATA_DIR / "taiex.json") or {}
    d, c = x.get("d") or [], x.get("c") or []
    if len(c) < 70:
        return None
    m60, m240 = ma(c, 60), ma(c, 240)
    # 他的原話：收盤跌破季線就出場，季線上揚而且站回才進場。從有季線的第一天跑起
    inside, since, path = True, None, []
    for i in range(len(c)):
        if m60[i] is None or i < 65 or m60[i - 5] is None:
            continue
        up = m60[i] > m60[i - 5]
        if inside and c[i] < m60[i]:
            inside, since = False, d[i]
        elif not inside and up and c[i] >= m60[i]:
            inside, since = True, d[i]
        path.append(inside)
    i = len(c) - 1
    return {
        "d": d[i], "c": round(c[i], 2),
        "ma60": round(m60[i], 2), "ma240": round(m240[i], 2) if m240[i] else None,
        "ma60_up": m60[i] > m60[i - 5],
        "hold": inside, "since": since,
        "series": {"d": d[-250:], "c": [round(v, 2) for v in c[-250:]],
                   "ma60": [round(v, 2) if v else None for v in m60[-250:]],
                   "ma240": [round(v, 2) if v else None for v in m240[-250:]]},
    }


def margin_state():
    m = twse.read_json(twse.DATA_DIR / "margin.json")
    if not m or not m.get("d"):
        return None
    d = m["d"]
    amt = [a + b for a, b in zip(m["amt_tw"], m["amt_tp"])]
    i = len(d) - 1
    j = max(0, i - 20)
    rank = sum(1 for a in amt if a <= amt[i]) / len(amt)
    return {
        "d": d[i], "amt": round(amt[i]), "amt_tw": m["amt_tw"][i], "amt_tp": m["amt_tp"][i],
        "chg20": round((amt[i] / amt[j] - 1) * 100, 1) if amt[j] else None,
        "mt": m["mt"][i], "mt_tw": m["mt_tw"][i], "mt_tp": m["mt_tp"][i], "sr": m["sr"][i],
        "pct": round(rank * 100), "since": d[0],
        "mt_min": min(v for v in m["mt"] if v), "mt_min_d": d[m["mt"].index(min(v for v in m["mt"] if v))],
        "series": {"d": d[-500:], "amt": [round(a) for a in amt[-500:]], "mt": m["mt"][-500:]},
    }


def macro_state():
    m = twse.read_json(twse.DATA_DIR / "macro.json")
    if not m:
        return None
    out = {}
    for k, x in m.items():
        if x.get("v"):
            out[k] = {"d": x["d"][-1], "v": x["v"][-1]}
    ic = m.get("icsa")
    if ic and len(ic["v"]) > 52:
        out["icsa"]["yoy"] = round((ic["v"][-1] / ic["v"][-53] - 1) * 100, 1)
    for k in ("vix", "brent"):
        if k in m:
            out[k]["series"] = {"d": m[k]["d"][-500:], "v": m[k]["v"][-500:]}
    return out


def main() -> int:
    P = Prices()
    N, dates = P.N, P.dates
    today = N - 1
    names = load_names()
    industry = (twse.read_json(twse.DATA_DIR / "industry.json") or {}).get("map") or {}
    rev = load_revenue()
    streak = rev_streaks(rev)
    commons = [c for c in P.C if common(c)]

    def base(c):
        return {"c": c, "n": names.get(c), "ind": industry.get(c)}

    def since(c, i):
        """訊號日隔天開盤進場到今天的還原報酬。"""
        return round(r * 100, 1) if i < today and (r := P.ret(c, i, today - i)) is not None else None

    # ---------- 1. 營收創歷史新高＋YoY>20%，公布後 20 個交易日 ----------
    drift = []
    rev_months = sorted({m for s in rev.values() for m in s})[-2:]
    for m in rev_months:
        nm = prev_month(m, -1)
        ten = max((i for i, d in enumerate(dates) if d[:7] == nm and d[8:] <= "10"), default=None)
        last_day = dates[today]
        pending = ten is None or (last_day[:7] == nm and last_day[8:] <= "10")
        if not pending and today - ten > DRIFT_DAYS:
            continue                     # 這個月的 20 天已經走完
        for c, s in rev.items():
            if m in s and streak[c].get(m, 0) >= 1 and (s[m][1] or 0) > 20:
                row = {**base(c), "m": m, "yoy": s[m][1], "streak": streak[c][m]}
                if pending:
                    row.update(day=None, r=None)
                else:
                    row.update(day=today - ten, r=since(c, ten))
                drift.append(row)
    drift.sort(key=lambda r: (r["day"] is None, -(r["streak"]), -(r["yoy"] or 0)))

    # ---------- 2. 股價創 12 個月新高＋營收 YoY 連 2 月加速 ----------
    month_end = {}
    for i, d in enumerate(dates):
        month_end[d[:7]] = i
    ends = [month_end[m] for m in sorted(month_end)][:-1][-12:]       # 過去 12 個月底（不含這個月）
    accel = []
    for c in commons:
        xs = P.adj(c)
        if not xs[today]:
            continue
        prior = [xs[i] for i in ends if xs[i]]
        if len(prior) < 11 or xs[today] <= max(prior):
            continue
        rs = rev.get(c, {})
        if not rs:
            continue
        L = max(rs)
        yy = [rs.get(prev_month(L, k), (None, None))[1] for k in range(3)]
        if None in yy or not (yy[0] > yy[1] > yy[2] and yy[0] > 0):
            continue
        accel.append({**base(c), "m": L, "yoy": yy, "ath": streak[c].get(L, 0),
                      "hi": round((xs[today] / max(prior) - 1) * 100, 1)})
    # 營收也創新高的排前面（低基期的爆量 YoY 不該排第一，見 H5），同一組再比 YoY
    accel.sort(key=lambda r: (r["ath"] == 0, -r["yoy"][0]))

    # ---------- 3／4／5. 價格型態（最近 RECENT 個交易日） ----------
    base_brk, new_low, hot_break = [], [], []
    for c in commons:
        xs = P.adj(c)
        if not xs[today]:
            continue
        rmx, rmn = roll_prev(xs, 250), roll_prev(xs, 250, -1)
        m60 = ma(xs, 60)
        for i in range(max(250, today - RECENT + 1), today + 1):
            if not xs[i] or rmx[i][2] < 200:
                continue
            # 前 20 天內已經創過的不算第一次
            if xs[i] > rmx[i][0] and not any(xs[k] and rmx[k][0] and rmx[k][2] >= 200 and xs[k] > rmx[k][0]
                                             for k in range(i - 20, i)):
                ago = i - rmx[i][1]
                if ago >= 120:
                    base_brk.append({**base(c), "d": dates[i], "ago": ago, "r": since(c, i)})
            if xs[i] < rmn[i][0] and not any(xs[k] and rmn[k][0] and rmn[k][2] >= 200 and xs[k] < rmn[k][0]
                                             for k in range(i - 20, i)):
                new_low.append({**base(c), "d": dates[i], "r": since(c, i)})
        # 熱門股第一次跌破季線：60 日漲幅前 10%（前一天），之前連 40 天在季線上
        for i in range(max(101, today - RECENT + 1), today + 1):
            if None in (xs[i], m60[i], xs[i - 1], m60[i - 1]) or xs[i] >= m60[i]:
                continue
            run = 0
            for k in range(i - 1, i - 41, -1):
                if xs[k] and m60[k] and xs[k] >= m60[k]:
                    run += 1
                else:
                    break
            if run >= 40:
                hot_break.append({"c": c, "i": i})
    # 熱門的門檻要跟同一天的全市場比
    hb = []
    for e in hot_break:
        i = e["i"]
        r60 = sorted(P.adj(x)[i] / P.adj(x)[i - 60] - 1 for x in commons if P.adj(x)[i] and P.adj(x)[i - 60])
        cut = r60[int(len(r60) * 0.9)] if r60 else None
        xs = P.adj(e["c"])
        if cut is not None and xs[i - 60] and xs[i] / xs[i - 60] - 1 >= cut:
            hb.append({**base(e["c"]), "d": dates[i], "r60": round((xs[i] / xs[i - 60] - 1) * 100),
                       "r": since(e["c"], i)})
    base_brk.sort(key=lambda r: (r["d"], r["ago"]), reverse=True)
    new_low.sort(key=lambda r: r["d"], reverse=True)
    hb.sort(key=lambda r: (r["d"], r["r60"]), reverse=True)

    # ---------- 6. 低基期的高 YoY ----------
    low_base = []
    for c, rs in rev.items():
        if not rs:
            continue
        L = max(rs)
        if L < rev_months[-1]:
            continue
        cur, yoy = rs[L]
        prior = [rs[prev_month(L, k)][0] for k in range(1, 25) if prev_month(L, k) in rs]
        if yoy is not None and yoy > 30 and len(prior) >= 20 and cur < 0.9 * max(prior):
            low_base.append({**base(c), "m": L, "yoy": yoy, "vs_hi": round((cur / max(prior) - 1) * 100)})
    low_base.sort(key=lambda r: -r["yoy"])

    # ---------- 7. 每一檔的檢核表（查詢用，另存一份，前端查的時候才載） ----------
    member = {}
    for key, rows in (("drift", drift), ("accel", accel), ("base", base_brk),
                      ("hotbreak", hb), ("newlow", new_low), ("lowbase", low_base)):
        for r in rows:
            member.setdefault(r["c"], set()).add(key)
    stocks = {}
    for c in commons:
        xs = P.adj(c)
        if not xs[today]:
            continue
        m60 = ma(xs, 60)
        win = [v for v in xs[max(0, today - 249):today + 1] if v]
        rs = rev.get(c, {})
        L = max(rs) if rs else None
        yy = [rs.get(prev_month(L, k), (None, None))[1] for k in range(3)] if L else [None] * 3
        prior = [rs[prev_month(L, k)][0] for k in range(1, 25) if L and prev_month(L, k) in rs]
        stocks[c] = [
            names.get(c), industry.get(c), L,
            yy[0], streak[c].get(L, 0) if L else 0,
            int(None not in yy and yy[0] > yy[1] > yy[2] and yy[0] > 0),
            int(bool(L and yy[0] is not None and yy[0] > 30 and len(prior) >= 20 and rs[L][0] < 0.9 * max(prior))),
            None if m60[today] is None else int(xs[today] >= m60[today]),
            None if m60[today] is None or m60[today - 5] is None else int(m60[today] > m60[today - 5]),
            round((xs[today] / max(win) - 1) * 100, 1) if len(win) >= 200 else None,
            round((xs[today] / xs[today - 20] - 1) * 100, 1) if xs[today - 20] else None,
            sorted(member.get(c, ())),
        ]
    twse.write_if_changed(twse.DATA_DIR / "gooaye_stocks.json", {
        "d": dates[today],
        "fields": ["name", "ind", "revMonth", "yoy", "revStreak", "accel", "lowBase",
                   "aboveMa60", "ma60Up", "fromHigh250", "r20", "lists"],
        "s": stocks,
    })

    def cap(xs):
        return {"n": len(xs), "rows": xs[:TOP]}

    payload = {
        "d": dates[today],
        "market": {"taiex": taiex_state(), "margin": margin_state(), "macro": macro_state()},
        "lists": {
            "drift": cap(drift), "accel": cap(accel), "base": cap(base_brk),
            "hotbreak": cap(hb), "newlow": cap(new_low), "lowbase": cap(low_base),
        },
        "rules": RULES,
    }
    changed = twse.write_if_changed(OUT, payload)
    print(f"{dates[today]}：營收漂移 {len(drift)}、突破加速 {len(accel)}、整理後突破 {len(base_brk)}、"
          f"強勢破季線 {len(hb)}、創新低 {len(new_low)}、低基期 {len(low_base)}"
          f"{'，已更新' if changed else '，沒有變化'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
