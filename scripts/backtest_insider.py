"""內部人申報要在市場上賣股之後，股價會不會比較弱？

    GOOAYE_DATA=<解壓後的長歷史 docs/data> python scripts/backtest_insider.py

只印表，不寫檔；結論在 BACKTEST.md「內部人申報轉讓」。

## 事件

insider/<年>.json（fetch_insider.py）裡，轉讓方式是**一般交易、鉅額、盤後定價**的申報——在市場上賣。
贈與、信託、洽特定人是家族之間搬股票，不算。同一家公司同一天的申報併成一筆，金額＝預定轉讓股數 ×
申報日收盤（沒還原，只拿來分大小）。普通股。

- 申報日 t 收盤後進場（t+1 開盤），抱 h 天。申報時間多半在盤中或盤前，用隔天開盤是保守的
- 有效轉讓期間通常是申報後第 3 個營業日起一個月，賣壓如果有，會落在這段

## 跟誰比

內部人常在股價漲了一段之後賣，所以每一筆都跟**同一天、近 60 日漲幅相近（同一個十分位）、前後 20 天沒有
內部人賣股申報**的股票比；也報跟同一天全市場平均比的超額。平均減平均，中位數與「贏」跟對照組的中位數比——
個股報酬右偏，平均減中位數一定是正的（第一版這樣混著減，全部 20 日變成 +1.15%、t 2.2）。t 值以日為單位。
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
HS = (1, 5, 20, 60)
LOOK = 60
SELL = ("一般交易", "鉅額", "盤後定價")
SPLIT = "2024-07-01"

D = S.Data(S.stock_dirs())
dates, T, N = D.dates, D.T, D.N
AO, AC = D.AO, D.AC
di = D.di

R = {}
for h in HS:
    r = np.full((T, N), np.nan)
    r[:T - h] = AC[h:] / AO[1:T - h + 1] - 1
    r[(r < -0.7) | (r > 3)] = np.nan
    R[h] = r
MKT = {h: np.nanmean(R[h], 1) for h in HS}
up = np.full((T, N), np.nan)
up[LOOK:] = D.ACf[LOOK:] / D.ACf[:-LOOK] - 1
up[~np.isfinite(AC)] = np.nan

# 事件：同一家公司同一天併成一筆
agg = {}
for p in sorted(glob.glob(os.path.join(SITE, "insider", "*.json"))):
    for d, code, role, how, shares, held, f, t, mk in json.load(open(p, encoding="utf-8")):
        if not any(k in how for k in SELL) or d not in di or code not in D.ci:
            continue
        key = (d, code)
        e = agg.setdefault(key, {"d": d, "i": di[d], "c": D.ci[code], "shares": 0, "held": 0, "roles": set()})
        e["shares"] += shares
        e["held"] += held
        e["roles"].add(role)
ev = list(agg.values())
for e in ev:
    px = D.RC[e["i"], e["c"]]
    e["val"] = e["shares"] * px / 1e8 if np.isfinite(px) else np.nan          # 億
    e["frac"] = e["shares"] / e["held"] if e["held"] else np.nan
    # 申報人身分沒有「董事長」這一格，只有董事／大股東／經理人（＋配偶、子公司、利用他人名義……）
    e["owner"] = any(r.startswith(("董事本人", "大股東本人", "法人董事代表人本人")) for r in e["roles"])
    e["mgr"] = any(r.startswith("經理人本人") for r in e["roles"])
print(f"市場賣出的申報 {len(ev)} 筆（公司 × 申報日），{min(e['d'] for e in ev)} ～ {max(e['d'] for e in ev)}\n")

# 前後 20 天有申報的，不能當對照組
busy = defaultdict(set)
for e in ev:
    for i in range(max(0, e["i"] - 20), min(T, e["i"] + 21)):
        busy[i].add(e["c"])
dec = np.full((T, N), -1)
for i in range(T):
    u = up[i]
    ok = np.isfinite(u)
    if ok.sum() > 100:
        q = np.nanquantile(u[ok], np.linspace(0, 1, 11)[1:-1])
        dec[i, ok] = np.searchsorted(q, u[ok])


def collect(sel, h):
    out = []
    for e in ev:
        if not sel(e):
            continue
        i, c = e["i"], e["c"]
        if i + h >= T:
            continue
        x = R[h][i, c]
        if not np.isfinite(x) or (i + 1 < T and D.LIMIT_OPEN[i + 1, c]):
            continue
        ctl = ctlm = np.nan
        if dec[i, c] >= 0:
            m = dec[i] == dec[i, c]
            for k in busy[i]:
                m[k] = False
            pr = R[h][i][m]
            pr = pr[np.isfinite(pr)]
            if len(pr) >= 10:
                ctl, ctlm = x - pr.mean(), x - np.median(pr)
        out.append((dates[i], x, ctl, x - MKT[h][i], ctlm))
    return out


def stats(rows):
    if not rows:
        return None
    r = np.array([x[1] for x in rows])
    ex = np.array([x[2] for x in rows if np.isfinite(x[2])])
    em = np.array([x[3] for x in rows])
    exm = np.array([x[4] for x in rows if np.isfinite(x[4])])
    by = defaultdict(list)
    for d, _, e, _, _ in rows:
        if np.isfinite(e):
            by[d].append(e)
    daily = np.array([np.mean(v) for v in by.values()])
    t = daily.mean() / (daily.std(ddof=1) / np.sqrt(len(daily))) if len(daily) > 2 else np.nan
    return {"n": len(r), "avg": r.mean() * 100, "med": np.median(r) * 100, "win": (r > 0).mean() * 100,
            "ex": ex.mean() * 100, "exmed": np.median(exm) * 100, "beat": (exm > 0).mean() * 100,
            "mkt": em.mean() * 100, "t": t}


def table(title, sel):
    print(f"## {title}")
    print(f"{'h':>3} {'筆':>5} {'平均':>7} {'中位':>7} {'上漲':>5} │ {'減對照':>7} {'中位':>7} {'贏對照':>6} {'t':>6} │ {'減大盤':>7}")
    for h in HS:
        s = stats(collect(sel, h))
        if s:
            print(f"{h:>3} {s['n']:>5} {s['avg']:>+7.2f} {s['med']:>+7.2f} {s['win']:>4.0f}% │ {s['ex']:>+7.2f} {s['exmed']:>+7.2f}"
                  f" {s['beat']:>5.0f}% {s['t']:>+6.2f} │ {s['mkt']:>+7.2f}")
    print()


def split(title, sel, h):
    print(f"### {title}，{h} 日，分段")
    for lab, a, b in [("2021-10～2022", "0000", "2023"), ("2023", "2023", "2024"), ("2024", "2024", "2025"),
                      ("2025", "2025", "2026"), ("2026", "2026", "9999"),
                      (f"前段 <{SPLIT}", "0000", SPLIT), (f"後段 ≥{SPLIT}", SPLIT, "9999")]:
        s = stats(collect(lambda e: sel(e) and a <= e["d"] < b, h))
        if s:
            print(f"  {lab:<16} {s['n']:>5} 筆　平均 {s['avg']:>+6.2f}%（中位 {s['med']:>+6.2f}%）　減對照 {s['ex']:>+6.2f}%"
                  f"（中位 {s['exmed']:>+6.2f}%，贏 {s['beat']:>3.0f}%，t {s['t']:>+5.2f}）")
    print()


pre = [up[e["i"], e["c"]] for e in ev if np.isfinite(up[e["i"], e["c"]])]
print(f"申報那天，近 {LOOK} 日漲幅中位數 {np.median(pre) * 100:+.1f}%\n")
ALL = lambda e: True
BIG = lambda e: e["val"] >= 1
HUGE = lambda e: e["val"] >= 5
FRAC = lambda e: e["frac"] >= 0.5
OWNER = lambda e: e["owner"]
MGR = lambda e: e["mgr"] and not e["owner"]
table("全部（市場賣出）", ALL)
table("金額 ≥ 1 億", BIG)
table("金額 ≥ 5 億", HUGE)
table("賣掉手上一半以上", FRAC)
table("董事、大股東本人", OWNER)
table("只有經理人本人", MGR)
split("全部", ALL, 20)
split("金額 ≥ 1 億", BIG, 20)
split("金額 ≥ 1 億", BIG, 60)
split("董事、大股東本人", OWNER, 20)
split("董事、大股東本人", OWNER, 60)
