"""處置預測回測：注意股的累積次數能不能提早一天知道誰會被處置？提早一天買有沒有多賺？

    GOOAYE_DATA=<解壓後的長歷史 docs/data> python scripts/backtest_notice.py

只印表，不寫檔；結論在 BACKTEST.md「處置預測」。

## 一、規則準不準

notice.trigger 用每天的注意股重建處置：那天該不該處置、交易所實際上有沒有處置。

## 二、候選：明天再被注意一次就處置

第 i 天收盤後算 notice.need：明天（i+1）不管哪一款都會處置（any），或只有第一款才會（k1）。
- 隔天真的被處置的比例
- **提早一天的那一段**：i+1 開盤買 → i+2 開盤（現行訊號是處置第一天、也就是 i+2 開盤才買）。
  被處置的，這段就是提早進場多賺（或多賠）的；沒被處置的，這段是白跑一趟的成本
- 跟漲幅相近的對照組比：同一天近 10 日漲幅在這一檔 ±25%（相對）以內、不是候選、沒在處置中的
- i+1 開盤就漲停的買不到，不算

t 值以日為單位（同一天的平均），只拿來看量級。
"""

from __future__ import annotations

import glob
import json
import os
import sys
from collections import Counter, defaultdict

import numpy as np

import notice as NT
import strategy as S

sys.stdout.reconfigure(encoding="utf-8")
LOOK = 10
SPLIT = "2024-07-01"
NEW = "2026-08-07"

D = S.Data(S.stock_dirs())
dates, T = D.dates, D.T
di = {d: i for i, d in enumerate(dates)}
site = S.stock_dirs()[-1]
days = NT.load_notice(site, di)
pubs = NT.load_pubs(site, di)
pubset = {(c, i) for c, xs in pubs.items() for i in xs}
W = 40                                   # 前 40 個交易日的累積不完整，不算

# ── 一、規則準不準 ─────────────────────────────────────────────
print(f"## 規則重建（{dates[W]} ～ {dates[-1]}）")
seg = lambda d: d[:4] + ("新制" if d >= NEW else "")
hit, extra, miss = Counter(), Counter(), Counter()
by_rule = Counter()
for c, nt in days.items():
    ps = pubs.get(c, [])
    for i in nt:
        if i < W:
            continue
        r = NT.trigger(nt, i, NT.last_pub(ps, i, inclusive=False))
        if r and (c, i) in pubset:
            hit[seg(dates[i])] += 1
            by_rule[r] += 1
        elif r:
            extra[seg(dates[i])] += 1
for c, i in pubset:
    if i >= W and not NT.trigger(days.get(c, {}), i, NT.last_pub(pubs[c], i, inclusive=False)):
        miss[seg(dates[i])] += 1
for y in sorted(set(hit) | set(extra) | set(miss)):
    print(f"  {y:<8} 對中 {hit[y]:>4}　多報 {extra[y]:>3}　漏掉 {miss[y]:>3}")
print(f"  合計     對中 {sum(hit.values()):>4}　多報 {sum(extra.values()):>3}　漏掉 {sum(miss.values()):>3}"
      f"　（觸發的條：{', '.join(f'{NT.RULES[k]} {v}' for k, v in by_rule.most_common())}）\n")

# ── 二、候選 ───────────────────────────────────────────────────
inper = defaultdict(set)                 # 第 i 天正在處置中（公布日到處置最後一天）的股票
for p in sorted(glob.glob(os.path.join(site, "disposal", "*.json"))):
    for pub, code, _n, _fr, to, *_ in json.load(open(p, encoding="utf-8")):
        if pub not in di:
            continue
        for i in range(di[pub], T):
            if dates[i] > to:
                break
            inper[i].add(code)

cands = []                               # (i, 代號, any/k1, 條, 隔天有沒有被處置, 那天在不在處置中)
for c, nt in days.items():
    ps = pubs.get(c, [])
    look = sorted({i for j in nt for i in range(j, min(j + 30, T - 2))})
    for i in look:
        if i < W:
            continue
        n = NT.need(nt, i, NT.last_pub(ps, i))
        if n:
            cands.append((i, c, n[0], n[1], (c, i + 1) in pubset, c in inper[i]))
cand_by_day = defaultdict(set)
for x in cands:
    cand_by_day[x[0]].add(x[1])

up = np.full_like(D.ACf, np.nan)
up[LOOK:] = D.ACf[LOOK:] / D.ACf[:-LOOK] - 1
gap = np.full_like(D.AO, np.nan)         # i+1 開盤 → i+2 開盤
gap[:T - 2] = D.AO[2:] / D.AO[1:T - 1] - 1
gap[(gap < -0.5) | (gap > 1)] = np.nan


def excess(i, k):
    u = up[i]
    x = u[k]
    if not np.isfinite(x) or x == 0:
        return np.nan
    lo, hi = sorted((x * 0.75, x * 1.25))
    m = np.isfinite(u) & (u >= lo) & (u <= hi) & np.isfinite(gap[i])
    for c in cand_by_day[i] | inper[i]:
        if c in D.ci:
            m[D.ci[c]] = False
    pr = gap[i][m]
    return gap[i, k] - np.median(pr) if len(pr) >= 3 else np.nan


rows = []
for i, c, kind, rule, got, held in cands:
    k = D.ci.get(c)
    if k is None or i + 2 >= T or D.LIMIT_OPEN[i + 1, k] or not np.isfinite(gap[i, k]):
        continue
    rows.append({"d": dates[i], "i": i, "kind": kind, "rule": rule, "got": got, "held": held,
                 "up": up[i, k] > 0, "pre": up[i, k], "r": gap[i, k], "ex": excess(i, k)})
print(f"## 候選：明天再被注意一次就處置（{len(cands)} 次，能買的 {len(rows)} 次）\n")


def line(lab, xs):
    if not xs:
        return
    r = np.array([x["r"] for x in xs])
    ex = np.array([x["ex"] for x in xs if np.isfinite(x["ex"])])
    by = defaultdict(list)
    for x in xs:
        if np.isfinite(x["ex"]):
            by[x["d"]].append(x["ex"])
    dl = np.array([np.mean(v) for v in by.values()])
    t = dl.mean() / (dl.std(ddof=1) / np.sqrt(len(dl))) if len(dl) > 2 else np.nan
    got = np.mean([x["got"] for x in xs]) * 100
    print(f"  {lab:<22} {len(xs):>5} 次　隔天處置 {got:>3.0f}%　提早那段 平均 {r.mean()*100:>+6.2f}%（中位 {np.median(r)*100:>+6.2f}%，"
          f"上漲 {(r > 0).mean()*100:>3.0f}%）　減對照 {ex.mean()*100:>+6.2f}%（中位 {np.median(ex)*100:>+6.2f}%，贏 {(ex > 0).mean()*100:>3.0f}%，t {t:>+5.2f}）")


fresh = [x for x in rows if not x["held"]]
print("### 不在處置中的候選（處置中的要預收款券，另外看）")
line("全部", fresh)
line("隔天真的被處置", [x for x in fresh if x["got"]])
line("隔天沒有被處置", [x for x in fresh if not x["got"]])
line("any：哪一款都會", [x for x in fresh if x["kind"] == "any"])
line("k1：要第一款", [x for x in fresh if x["kind"] == "k1"])
line("近 10 日上漲", [x for x in fresh if x["up"]])
line("近 10 日下跌", [x for x in fresh if not x["up"]])
for r in NT.RULES:
    line(f"差一次：{NT.RULES[r]}", [x for x in fresh if x["rule"] == r])
print("\n### 處置中的候選（明天再被注意就再次處置）")
line("全部", [x for x in rows if x["held"]])

# 盤中就算得出會不會達第一款：被處置的，i+1 收盤買 vs 等處置第一天（i+2）開盤買
over = []
for i, c, kind, rule, got, held in cands:
    k = D.ci.get(c)
    if got and not held and k is not None and i + 2 < T:
        x = D.AO[i + 2, k] / D.AC[i + 1, k] - 1
        if np.isfinite(x):
            over.append(x)
over = np.array(over)
print(f"\n### 隔天真的被處置的：前一天收盤 → 處置第一天開盤 {len(over)} 次，平均 {over.mean()*100:+.2f}%"
      f"（中位 {np.median(over)*100:+.2f}%，上漲 {(over > 0).mean()*100:.0f}%）——收盤搶進 vs 等開盤")

print("\n### 不在處置中、近 10 日上漲，分段")
segs = [("2021-10～2022", "0000", "2023"), ("2023", "2023", "2024"), ("2024", "2024", "2025"), ("2025", "2025", "2026"),
        ("2026 舊制", "2026", NEW), ("2026 新制", NEW, "9999"), (f"前段 <{SPLIT}", "0000", SPLIT), (f"後段 ≥{SPLIT}", SPLIT, "9999")]
for lab, a, b in segs:
    line(lab, [x for x in fresh if x["up"] and a <= x["d"] < b])
