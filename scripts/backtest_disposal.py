"""處置股回測：被處置之後、出關之後，股價通常怎麼走？

    GOOAYE_DATA=<解壓後的長歷史 docs/data> python scripts/backtest_disposal.py

只印表，不寫檔；結論在 BACKTEST.md「處置股」。

## 事件

disposal/<年>.json（fetch_disposal.py）的每一筆：公布日 p（收盤後公布，隔天起處置）、處置的第一個與
最後一個交易日。只看普通股。

- **處置**：p 日收盤後知道 → p+1 開盤進場（處置第一天），抱 h 天
- 進場那天開盤就漲停（≥ 前收 × 1.095）的不算——實務上買不到，跟策略頁同一條
- **出關**：處置最後一天 e 收盤後 → e+1 開盤進場（出關第一天），抱 h 天
- **處置期間**：p+1 開盤 → e 收盤

## 跟誰比

被處置的股票是前幾天大漲、量暴增的那一群，直接跟大盤比，賺賠全是「大漲之後」的效果，不是處置的。
所以每一筆都跟**同一天、近 10 日漲幅排在全市場前 5%、但沒被處置**的股票比（對照組）；另外也報跟
全市場同一天中位數比的超額。

`PEER=match` 改成跟**漲幅相近**的比：同一天近 10 日漲幅在這一檔的 ±25%（相對）以內、沒被處置的
（至少 3 檔才算）。處置股的漲幅比前 5% 的門檻高得多，這一組才排除得掉「漲越多越會再漲」。

t 值以日為單位（同一天的事件取平均），持有期重疊沒有修正——只拿來看量級。
"""

from __future__ import annotations

import glob
import json
import os
import sys
from collections import defaultdict

import numpy as np

import strategy as S
from gooaye import SITE

sys.stdout.reconfigure(encoding="utf-8")
HS = (1, 5, 10, 20)
LOOK = 10            # 對照組：近幾日漲幅
TOP = 0.05           # 排在前幾 % 算「同樣大漲」
SPLIT = "2024-07-01"

D = S.Data(S.stock_dirs())
dates, T, N = D.dates, D.T, D.N
AO, AC = D.AO, D.AC

# 每一天、每一檔：i+1 開盤進、i+h 收盤出的還原報酬
R = {}
for h in HS:
    r = np.full((T, N), np.nan)
    r[:T - h] = AC[h:] / AO[1:T - h + 1] - 1
    r[(r < -0.7) | (r > 3)] = np.nan
    R[h] = r
up = np.full((T, N), np.nan)
up[LOOK:] = D.ACf[LOOK:] / D.ACf[:-LOOK] - 1
up[~np.isfinite(AC)] = np.nan


def day_on_or_after(d):
    return next((i for i, x in enumerate(dates) if x >= d), None)


def day_on_or_before(d):
    i = None
    for k, x in enumerate(dates):
        if x > d:
            break
        i = k
    return i


ev = []
for p in sorted(glob.glob(os.path.join(SITE, "disposal", "*.json"))):
    for pub, code, name, fr, to, k, mins, mk in json.load(open(p, encoding="utf-8")):
        c = D.ci.get(code)
        if c is None:
            continue
        ip, i_end = day_on_or_before(pub), day_on_or_before(to)
        if ip is None or i_end is None or i_end <= ip or pub < dates[0]:
            continue
        ev.append({"d": pub, "c": c, "ip": ip, "ie": i_end, "k": min(k, 2), "mk": mk, "mins": mins})
print(f"事件 {len(ev)} 筆（普通股、在價格資料範圍內），{dates[0]} ～ {dates[-1]}\n")

disposed = defaultdict(set)          # 那一天正在處置中（或剛公布）的股票，不能當對照組
for e in ev:
    for i in range(e["ip"], e["ie"] + 1):
        disposed[i].add(e["c"])


def peer_mask(i):
    u = up[i]
    ok = np.isfinite(u)
    if ok.sum() < 100:
        return None
    cut = np.nanquantile(u[ok], 1 - TOP)
    m = ok & (u >= cut)
    for c in disposed.get(i, ()):
        m[c] = False
    return m


def matched_mask(i, c, band=0.25):
    """漲幅相近的對照組：同一天近 10 日漲幅在這一檔的 ±25%（相對）以內、沒被處置的。"""
    u = up[i]
    x = u[c]
    if not np.isfinite(x) or x <= 0:
        return None
    m = np.isfinite(u) & (u >= x * (1 - band)) & (u <= x * (1 + band))
    for k in disposed.get(i, ()):
        m[k] = False
    return m


MODE = os.environ.get("PEER", "top")       # top：前 5%；match：漲幅相近


def stats(rows):
    """rows: [(日, 報酬, 減對照組, 減大盤)] → 平均、中位數、贏對照組比例、t 值（以日為單位）"""
    if not rows:
        return None
    r = np.array([x[1] for x in rows])
    ex = np.array([x[2] for x in rows if np.isfinite(x[2])])
    em = np.array([x[3] for x in rows])
    by = defaultdict(list)
    for d, _, e, _ in rows:
        if np.isfinite(e):
            by[d].append(e)
    daily = np.array([np.mean(v) for v in by.values()])
    t = daily.mean() / (daily.std(ddof=1) / np.sqrt(len(daily))) if len(daily) > 2 else np.nan
    return {"n": len(r), "avg": r.mean() * 100, "med": np.median(r) * 100, "win": (r > 0).mean() * 100,
            "ex": ex.mean() * 100 if len(ex) else np.nan, "exmed": np.median(ex) * 100 if len(ex) else np.nan,
            "beat": (ex > 0).mean() * 100 if len(ex) else np.nan, "mkt": em.mean() * 100, "t": t}


def collect(sel, at, h):
    """at(e) = 訊號日 i（i+1 開盤進場）"""
    out = []
    for e in ev:
        if not sel(e):
            continue
        i = at(e)
        if i is None or i + h >= T:
            continue
        x = R[h][i, e["c"]]
        if not np.isfinite(x) or (i + 1 < T and D.LIMIT_OPEN[i + 1, e["c"]]):     # 開盤就漲停：買不到
            continue
        m = matched_mask(i, e["c"]) if MODE == "match" else peer_mask(i)
        pr = R[h][i][m] if m is not None else np.array([])
        pr = pr[np.isfinite(pr)]
        allr = R[h][i][np.isfinite(R[h][i])]
        out.append((dates[i], x, x - np.median(pr) if len(pr) >= (3 if MODE == "match" else 10) else np.nan, x - np.median(allr)))
    return out


def table(title, sel, at):
    print(f"## {title}")
    print(f"{'h':>3} {'筆':>5} {'平均':>7} {'中位':>7} {'上漲':>5} │ {'減對照':>7} {'中位':>7} {'贏對照':>6} {'t':>6} │ {'減大盤':>7}")
    for h in HS:
        s = stats(collect(sel, at, h))
        if not s:
            continue
        print(f"{h:>3} {s['n']:>5} {s['avg']:>+7.2f} {s['med']:>+7.2f} {s['win']:>4.0f}% │ {s['ex']:>+7.2f} {s['exmed']:>+7.2f}"
              f" {s['beat']:>5.0f}% {s['t']:>+6.2f} │ {s['mkt']:>+7.2f}")
    print()


def split(title, sel, at, h):
    print(f"### {title}，{h} 日，分段")
    segs = [("2021-10～2022-12", "2021-10", "2023-01"), ("2023", "2023-01", "2024-01"), ("2024", "2024-01", "2025-01"),
            ("2025", "2025-01", "2026-01"), ("2026", "2026-01", "2027-01"),
            (f"前段 <{SPLIT}", "0000", SPLIT), (f"後段 ≥{SPLIT}", SPLIT, "9999")]
    for lab, a, b in segs:
        s = stats(collect(lambda e: sel(e) and a <= e["d"] < b, at, h))
        if s:
            print(f"  {lab:<18} {s['n']:>4} 筆　平均 {s['avg']:>+6.2f}%（中位 {s['med']:>+6.2f}%，上漲 {s['win']:>3.0f}%）　減對照 {s['ex']:>+6.2f}%（中位 {s['exmed']:>+6.2f}%，"
                  f"贏 {s['beat']:>3.0f}%，t {s['t']:>+5.2f}）　減大盤 {s['mkt']:>+6.2f}%")
    print()


at_pub = lambda e: e["ip"]
at_out = lambda e: e["ie"]
ALL = lambda e: True
FIRST = lambda e: e["k"] == 1
SECOND = lambda e: e["k"] == 2

# 處置前 10 日漲了多少（說明為什麼要對照組）
pre = [up[e["ip"], e["c"]] for e in ev if np.isfinite(up[e["ip"], e["c"]])]
print(f"公布處置那天，近 {LOOK} 日漲幅中位數 {np.median(pre) * 100:+.1f}%（對照組門檻：同一天前 {TOP:.0%}）\n")

table("處置：公布隔天開盤進場（全部）", ALL, at_pub)
table("處置：第一次處置", FIRST, at_pub)
table("處置：第二次處置（20 分鐘撮合）", SECOND, at_pub)
table("出關：處置結束隔天開盤進場（全部）", ALL, at_out)
table("出關：第一次處置結束", FIRST, at_out)
table("出關：第二次處置結束", SECOND, at_out)

NEW = "2026-08-07"     # 新制：處置 5 個交易日、2 分鐘撮合（第一次、第二次都是）
table(f"處置：新制（{NEW} 起，5 日、2 分鐘撮合）", lambda e: e["d"] >= NEW, at_pub)
table(f"處置：舊制的最後一段（2026-01 ～ {NEW}）", lambda e: "2026-01" <= e["d"] < NEW, at_pub)

split("處置（全部）", ALL, at_pub, 10)
split("出關（全部）", ALL, at_out, 5)
split("出關（全部）", ALL, at_out, 20)

# 抱滿處置期間：第一天開盤 → 最後一天收盤（持有天數 = 處置的交易日數），同樣跟漲幅相近的對照組比
def whole(sel):
    out = []
    for e in ev:
        if not sel(e):
            continue
        i, j, c = e["ip"], e["ie"], e["c"]
        if i + 1 >= T or j >= T or j <= i or D.LIMIT_OPEN[i + 1, c]:
            continue
        o, x = AO[i + 1, c], AC[j, c]
        if not (np.isfinite(o) and np.isfinite(x)):
            continue
        rr = AC[j] / AO[i + 1] - 1
        rr[(rr < -0.7) | (rr > 3)] = np.nan
        m = matched_mask(i, c) if MODE == "match" else peer_mask(i)
        pr = rr[m] if m is not None else np.array([])
        pr = pr[np.isfinite(pr)]
        allr = rr[np.isfinite(rr)]
        r0 = x / o - 1
        out.append((dates[i], r0, r0 - np.median(pr) if len(pr) >= (3 if MODE == "match" else 10) else np.nan,
                    r0 - np.median(allr)))
    return stats(out)


print("## 抱滿處置期間（第一天開盤 → 最後一天收盤）")
for lab, sel in [("全部", ALL), ("第一次", FIRST), ("第二次", SECOND),
                 ("2021-10～2022", lambda e: e["d"] < "2023"), ("2023", lambda e: "2023" <= e["d"] < "2024"),
                 ("2024", lambda e: "2024" <= e["d"] < "2025"), ("2025", lambda e: "2025" <= e["d"] < "2026"),
                 ("2026 舊制", lambda e: "2026" <= e["d"] < NEW), ("2026 新制", lambda e: e["d"] >= NEW)]:
    s = whole(sel)
    if s:
        print(f"  {lab:<14} {s['n']:>4} 筆　平均 {s['avg']:>+6.2f}%（中位 {s['med']:>+6.2f}%，上漲 {s['win']:>3.0f}%）　"
              f"減對照 {s['ex']:>+6.2f}%（中位 {s['exmed']:>+6.2f}%，贏 {s['beat']:>3.0f}%，t {s['t']:>+5.2f}）　減大盤 {s['mkt']:>+6.2f}%")
