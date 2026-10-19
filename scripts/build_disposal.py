"""處置頁 → docs/data/disposal.json：今天公布的處置、處置中的股票、近期處置事件的實際結果。

    python scripts/build_disposal.py

## 回測說了什麼（BACKTEST.md「處置股」，scripts/backtest_disposal.py，2021-10 ～ 2026-10）

被處置的股票，**處置第一天開盤買、抱到處置最後一天收盤**，比**漲幅相近、但沒被處置**的股票平均多
+4.8%（中位數 +3.8%，63% 贏，t 10.7），每一個年度都成立，2022 空頭與 2026-08 起的新制（處置 5 天、
2 分鐘撮合）也是。原始報酬比較普通：平均 +3.4%、中位數 +1.7%、57% 上漲，2022 中位數 +0.05%——
相對強，絕對不一定賺。出關之後買沒有效果。

所以頁面上把「今天公布、明天開始處置」當成訊號列出來，並附上近期每一筆抱滿處置期間的實際結果，
讓人看得到它最近還靈不靈。處置期間要預收款券（先付錢才能買）。開盤就漲停的買不到，不算。

## 明天可能處置（BACKTEST.md「處置預測」，scripts/backtest_notice.py）

處置是照注意股的累積次數判定的（notice.py）：5 年 2,121 筆處置，重建的規則對中 2,119 筆、沒有多報。
所以收盤後就知道誰「明天再被注意一次就處置」。但這**不是買點**：這些候選隔天開盤買、抱到再隔天開盤，
平均 −0.9%，比漲幅相近的股票少 0.7%（t −4，每一年都是負的），隔天真的被處置的只有 55%；
真的被處置的那一半，前一天收盤搶進也比等處置第一天開盤貴 0.2%。列出來是讓手上有的人知道
明天之後可能要預收款券、分盤撮合。

排在 fetch_disposal.py 與 build_history.py 之後（要最新的 disposal/ 與 close/）。
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import numpy as np

import notice as NT
import strategy as S
import twse
from gooaye import SITE, dated_files, load

TPE = timezone(timedelta(hours=8))
LOOK = 10            # 處置前看幾日漲幅
RECENT = 60          # 近期結果列幾個交易日內公布的
RESEARCH = {
    "period": "2021-10 ～ 2026-10",
    "n": 2114,
    "avg": 3.4, "med": 1.7, "win": 57,               # 原始報酬（還原、未扣成本）
    "ex": 4.8, "exmed": 3.8, "beat": 63,             # 減漲幅相近的對照組
    "first": {"ex": 4.6, "beat": 62}, "second": {"ex": 5.2, "beat": 66},
    "years": [
        {"y": "2021-10～2022", "med": 0.05, "ex": 3.4}, {"y": "2023", "med": 1.6, "ex": 3.2},
        {"y": "2024", "med": 0.9, "ex": 4.4}, {"y": "2025", "med": 3.2, "ex": 5.0},
        {"y": "2026 舊制", "med": 3.0, "ex": 6.2}, {"y": "2026-08 新制", "med": 2.9, "ex": 4.1},
    ],
    "out": "出關隔天開盤買沒有效果：5 日中位數 −1.8%，跟漲幅相近的對照組比也沒贏（44%）",
    "pre": 43,                                       # 公布那天近 10 日漲幅中位數 %
    "watch": {                                       # 明天可能處置（backtest_notice.py，不在處置中的候選）
        "disp": 2121, "hit": 2119, "extra": 0,       # 規則重建：實際處置、對中、多報
        "n": 2924, "got": 55,                        # 候選次數、隔天真的被處置 %
        "r": -0.9, "ex": -0.7, "beat": 42,           # 隔天開盤 → 再隔天開盤；減漲幅相近的對照組
        "close": -0.2,                               # 被處置的：前一天收盤 → 處置第一天開盤
    },
}


def pct(x, d=1):
    return None if x is None or not np.isfinite(x) else round(float(x) * 100, d)


def main() -> int:
    events = []
    for _, p in sorted(dated_files("disposal", [SITE]).items()):
        events += load(p)
    if not events:
        print("! 沒有處置資料，跳過")
        return 0
    D = S.Data([SITE])
    dates, T = D.dates, D.T
    last = T - 1
    asof = dates[last]
    ind = (load(os.path.join(SITE, "industry.json")) or {}).get("map") or {}
    names = (load(os.path.join(SITE, "industry.json")) or {}).get("names") or {}

    def on_or_before(d):
        i = None
        for k, x in enumerate(dates):
            if x > d:
                break
            i = k
        return i

    def row(e):
        pub, code, name, fr, to, k, mins, mk = e
        c = D.ci.get(code)
        out = {"c": code, "n": names.get(code) or name, "ind": ind.get(code), "pub": pub, "from": fr, "to": to,
               "k": k, "mins": mins, "mk": mk}
        if c is None:
            return out
        ip = on_or_before(pub)
        if ip is not None and ip >= LOOK:
            a, b = D.ACf[ip - LOOK, c], D.ACf[ip, c]
            out["pre"] = pct(b / a - 1) if a and np.isfinite(a) and np.isfinite(b) else None
        ie = on_or_before(to)
        if ip is not None and ip + 1 <= last and ie is not None:
            i0 = ip + 1
            o = D.AO[i0, c]
            out["limit"] = bool(D.LIMIT_OPEN[i0, c])
            if np.isfinite(o):
                j = min(ie, last)
                out["day"] = j - i0 + 1
                out["r"] = pct(D.ACf[j, c] / o - 1)
                out["done"] = to <= asof
        return {k2: v for k2, v in out.items() if v is not None}

    # 今天公布（明天開始處置）：公布日在最後一個交易日（含）之後
    today = [row(e) for e in events if e[0] >= asof]
    # 明天可能處置：明天再被注意一次就會處置的（今天剛公布處置的已經歸零，不會在這裡）
    di = {d: i for i, d in enumerate(dates)}
    days, pubs = NT.load_notice(SITE, di), NT.load_pubs(SITE, di)
    held = {e[1] for e in events if e[0] <= asof <= e[4]}
    watch = []
    for code, nt in days.items():
        n = NT.need(nt, last, NT.last_pub(pubs.get(code, []), last))
        if not n:
            continue
        w = {"c": code, "n": names.get(code) or D.names.get(code) or code, "ind": ind.get(code),
             "need": n[0], "rule": n[1], "held": code in held}
        c = D.ci.get(code)
        if c is not None and last >= LOOK:
            a, b = D.ACf[last - LOOK, c], D.ACf[last, c]
            w["pre"] = pct(b / a - 1) if a and np.isfinite(a) and np.isfinite(b) else None
        watch.append({k: v for k, v in w.items() if v is not None})
    watch.sort(key=lambda r: (r["held"], -(r.get("pre") or -1e9)))
    # 處置中：期間涵蓋最後一個交易日
    active = [row(e) for e in events if e[3] <= asof <= e[4] and e[0] < asof]
    # 近期：最近 RECENT 個交易日內公布、已經進場的
    since = dates[max(0, last - RECENT)]
    recent = [row(e) for e in events if since <= e[0] < asof]
    recent = [r for r in recent if "r" in r]
    recent.sort(key=lambda r: r["pub"], reverse=True)
    done = [r for r in recent if r.get("done") and not r.get("limit")]
    rs = np.array([r["r"] for r in done]) if done else np.array([])
    for xs in (today, active):
        xs.sort(key=lambda r: (-(r.get("k") or 1), -(r.get("pre") or -1e9)))

    out = {
        "updated": datetime.now(TPE).isoformat(timespec="seconds"),
        "asof": asof, "look": LOOK,
        "today": today, "watch": watch, "active": active, "recent": recent,
        "recentStats": {"n": len(rs), "avg": round(float(rs.mean()), 1) if len(rs) else None,
                        "med": round(float(np.median(rs)), 1) if len(rs) else None,
                        "win": round(float((rs > 0).mean() * 100)) if len(rs) else None, "days": RECENT},
        "research": RESEARCH,
    }
    twse.write_if_changed(twse.DATA_DIR / "disposal.json", out)
    print(f"處置：{asof} 公布 {len(today)} 檔、明天可能處置 {len(watch)} 檔、處置中 {len(active)} 檔、近 {RECENT} 日已出關 {len(rs)} 筆")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
