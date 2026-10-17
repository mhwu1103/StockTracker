"""族群大波段（像記憶體、被動元件那種）：起漲前，族群層級的哪些指標先動？

    GOOAYE_DATA=<解壓後的長歷史 docs/data> python scripts/study_sector_wave.py

只印表，不寫檔；結論整理在 BACKTEST.md。

- 族群指數：成分股還原收盤的等權平均（每天的日報酬取平均再連乘）
- 族群大波段：t 收盤後的 60 個交易日內，族群指數最高漲到 t 的 1.3 倍以上
- 營收廣度：成分股裡最新已公布月份營收年增 > 0 的比例（m 月營收從 m+1 月 11 日起才算）
- 股價廣度：成分股裡收盤創 60 日新高的比例
- 外資：成分股 20 日外資買賣超合計（億元，用當天收盤換算）
- 題材子族群名單是今天整理的（有事後偏誤），所以同一套也用官方產業跑一次
- 前段（< 2024-07）與後段分開報；兩段方向一致才算數
"""

from __future__ import annotations

import json
import os
import sys
from collections import defaultdict

import numpy as np

from gooaye import SITE, Prices, common, dated_files, load

sys.stdout.reconfigure(encoding="utf-8")
DIRS = [d for d in (os.environ.get("GOOAYE_DATA"), SITE) if d]
SPLIT = "2024-07-01"
W = 60

P = Prices(DIRS)
dates, T = P.dates, P.N
codes = sorted(c for c in P.C if common(c))
N = len(codes)
ci = {c: k for k, c in enumerate(codes)}
AC = np.full((T, N), np.nan)
RAW = np.full((T, N), np.nan)
for c in codes:
    k, cu = ci[c], P.cum[c]
    for i, v in P.C[c].items():
        AC[i, k] = v / cu[i]
        RAW[i, k] = v
ACf = AC.copy()
for i in range(1, T):
    m = np.isnan(ACf[i])
    ACf[i, m] = ACf[i - 1, m]
r1 = ACf / np.vstack([np.full((1, N), np.nan), ACf[:-1]]) - 1
r1[(np.abs(r1) > 0.5) | np.isnan(AC)] = np.nan
hi60 = np.full((T, N), np.nan)
for i in range(59, T):
    hi60[i] = np.nanmax(ACf[i - 59:i + 1], 0)
NEWHI = (ACf >= hi60) & np.isfinite(AC)

FO = np.zeros((T, N))
for d, p in dated_files("insti/daily", DIRS).items():
    if d in P.di:
        for mk in load(p)["stocks"].values():
            for c, r in mk.items():
                if c in ci and r[4]:
                    FO[P.di[d], ci[c]] = r[1] * r[4]


def nextm(m):
    y, mo = int(m[:4]), int(m[5:]) + 1
    return f"{y + (mo > 12)}-{(mo - 1) % 12 + 1:02d}"


rev = {m: load(p) for m, p in dated_files("value/rev", [SITE]).items()}
YOY = np.full((T, N), np.nan)
for m in sorted(rev):
    i0 = next((i for i, d in enumerate(dates) if d >= f"{nextm(m)}-11"), None)
    if i0 is None:
        continue
    for c, v in rev[m].items():
        if c in ci and v[1] is not None:
            YOY[i0:, ci[c]] = v[1]                     # 之後的月份會覆蓋

themes = load(os.path.join(SITE, "themes.json"))["groups"]
G = {}
for g in themes:
    for s in g["subs"]:
        mem = [ci[c] for c in s["codes"] if c in ci]
        if len(mem) >= 3:
            G[f"{g['name']}／{s['name']}"] = mem
ind = load(os.path.join(SITE, "industry.json"))["map"]
IG = defaultdict(list)
for c, n in ind.items():
    if c in ci and n not in ("其他", "存託憑證"):
        IG[n].append(ci[c])
IG = {k: v for k, v in IG.items() if len(v) >= 5}


def group_series(mem):
    with np.errstate(all="ignore"):
        dr = np.nanmean(r1[:, mem], 1)
        idx = np.cumprod(1 + np.nan_to_num(dr))
        yv = YOY[:, mem]
        rb = np.sum(yv > 0, 1) / np.maximum(np.sum(np.isfinite(yv), 1), 1)
        ymed = np.nanmedian(yv, 1)
        hb = np.sum(NEWHI[:, mem], 1) / np.maximum(np.sum(np.isfinite(AC[:, mem]), 1), 1)
        fo20 = np.convolve(FO[:, mem].sum(1), np.ones(20), "full")[:T] / 1e8
    fmax = np.full(T, np.nan)
    f60 = np.full(T, np.nan)
    for i in range(T - W):
        fmax[i] = idx[i + 1:i + 1 + W].max() / idx[i] - 1
        f60[i] = idx[i + W] / idx[i] - 1
    r60 = np.full(T, np.nan)
    r60[60:] = idx[60:] / idx[:-60] - 1
    return dict(idx=idx, rb=rb, ymed=ymed, hb=hb, fo20=fo20, fmax=fmax, f60=f60, r60=r60)


S = {k: group_series(v) for k, v in G.items()}
SI = {k: group_series(v) for k, v in IG.items()}

# ---------------- 一、個案：記憶體與被動元件 ----------------
print(f"資料 {dates[0]} ~ {dates[-1]}")
for name in [k for k in G if k.startswith("記憶體") or k.startswith("被動元件")]:
    s = S[name]
    print(f"\n【{name}】成分 {len(G[name])} 檔　每月最後一個交易日")
    print(f"{'月底':<11}{'族群指數':>8}{'近60日':>8}{'營收轉正比例':>10}{'年增中位':>9}{'創60日高比例':>11}{'外資20日(億)':>12}{'之後60日最高':>11}")
    for i, d in enumerate(dates):
        if i + 1 < T and dates[i + 1][:7] == d[:7]:
            continue
        if d < "2022-01":
            continue
        fm = f"{s['fmax'][i]*100:+8.0f}%" if np.isfinite(s["fmax"][i]) else "      —"
        print(f"{d:<11}{s['idx'][i]:8.2f}{s['r60'][i]*100:+7.0f}%{s['rb'][i]*100:9.0f}%{s['ymed'][i]:+9.1f}"
              f"{s['hb'][i]*100:10.0f}%{s['fo20'][i]:+12.0f}{fm}")

# ---------------- 二、系統性：什麼條件之後，族群容易出大波段 ----------------
def evaluate(SS, label):
    rows = defaultdict(lambda: {"前段": [], "後段": []})
    base = {"前段": [], "後段": []}
    for k, s in SS.items():
        rb3 = np.full(T, np.nan)
        rb3[60:] = s["rb"][60:] - s["rb"][:-60]
        conds = {
            "營收轉正比例 ≥ 60%": s["rb"] >= 0.6,
            "營收轉正比例 3 個月內 +30 點以上": rb3 >= 0.3,
            "營收轉正 ≥ 60% 且 3 個月 +30 點": (s["rb"] >= 0.6) & (rb3 >= 0.3),
            "創 60 日新高的成分 ≥ 30%": s["hb"] >= 0.3,
            "族群近 60 日漲 ≥ 20%": s["r60"] >= 0.2,
            "營收 +30 點 ＋ 新高比例 ≥ 30%": (rb3 >= 0.3) & (s["hb"] >= 0.3),
            "營收轉正 ≥ 60% ＋ 新高比例 ≥ 30%": (s["rb"] >= 0.6) & (s["hb"] >= 0.3),
            "營收轉正 ≥ 60% ＋ 族群 60 日漲 ≥ 20%": (s["rb"] >= 0.6) & (s["r60"] >= 0.2),
            "外資 20 日買超 ＋ 新高比例 ≥ 30%": (s["fo20"] > 0) & (s["hb"] >= 0.3),
        }
        for i in range(130, T - W):
            if not np.isfinite(s["fmax"][i]):
                continue
            per = "前段" if dates[i] < SPLIT else "後段"
            wave = s["fmax"][i] >= 0.3
            base[per].append((wave, s["f60"][i]))
            for cn, m in conds.items():
                if m[i]:
                    rows[cn][per].append((wave, s["f60"][i]))
    print(f"\n【{label}】族群 {len(SS)} 個；大波段＝之後 60 日內族群指數最高漲 ≥ 30%")
    bw = {p: np.mean([w for w, _ in base[p]]) for p in base}
    bf = {p: np.mean([f for _, f in base[p]]) for p in base}
    print(f"基準（任一天、任一族群）：大波段機率 前段 {bw['前段']*100:.1f}%／後段 {bw['後段']*100:.1f}%；"
          f"60 日平均漲幅 前段 {bf['前段']*100:+.1f}%／後段 {bf['後段']*100:+.1f}%")
    print(f"{'條件':<34} 前段：族群日數 大波段機率(倍數) 60日平均 | 後段：族群日數 大波段機率(倍數) 60日平均")
    for cn, d in rows.items():
        cells = []
        for p in ("前段", "後段"):
            xs = d[p]
            if len(xs) < 30:
                cells.append(f"{len(xs):>6}  樣本太少")
                continue
            w = np.mean([a for a, _ in xs])
            f = np.mean([b for _, b in xs])
            cells.append(f"{len(xs):>6} {w*100:5.1f}%({w/bw[p]:3.1f}x) {f*100:+6.1f}%")
        print(f"{cn:<34} " + " | ".join(cells))


evaluate(S, "題材子族群（有事後偏誤）")
evaluate(SI, "官方產業（沒有事後偏誤）")
