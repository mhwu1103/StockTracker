"""策略的多空開關：現行的「0050 跌破 120 日線」換成兩條均線（20 日、100 日）會不會比較好？

    GOOAYE_DATA=<解壓後的長歷史 docs/data> python scripts/backtest_regime_lights.py

只印表，不寫檔；結論在 BACKTEST.md「大盤兩條均線」。

常見的大盤燈號用兩條線分三格：站上 20 日與 100 日線（偏多）、跌破 20 日線（偏空）、其他（震盪）。
策略的空頭做法只有一種（不買新股、閒錢放現金），所以把「哪幾格算空頭」換成幾種切法，其他規則都跟定案一樣：

- 跌破 20 日線就算空頭
- 跌破 100 日線
- 只要不是兩條都站上（跌破任一條）
- 兩條都跌破

每一種跑 SEEDS 種挑股順序，報前段（< 2024-07，含 2022 空頭）與後段的中位數、贏 0050 的比例、最大回落。
另外報「純擇時」：多頭抱 0050、空頭抱現金，不選股——看開關本身的好壞，不被選股蓋過去。
"""

from __future__ import annotations

import sys

import numpy as np

import strategy as S

sys.stdout.reconfigure(encoding="utf-8")
SPLIT = "2024-07-01"
WARM = 130
SEEDS = 20

D = S.Data(S.stock_dirs())
dates, T = D.dates, D.T
sig = S.signals(D)
i_split = next(i for i, d in enumerate(dates) if d >= SPLIT)
YEARS = sorted({d[:4] for d in dates[WARM:]})
YB = {y: (max(WARM, next(i for i, d in enumerate(dates) if d[:4] == y) - 1),
          next((i for i, d in enumerate(dates) if d[:4] > y), T)) for y in YEARS}


def seg(eq, bench, lo, hi):
    e, b = eq[lo:hi], bench[lo:hi]
    return e[-1] / e[0] - 1, b[-1] / b[0] - 1


def timing_only(reg):
    eq = np.full(T, np.nan)
    v = 1.0
    eq[WARM] = 1.0
    for t in range(WARM + 1, T):
        if reg[t - 1]:
            v *= D.b_close[t] / D.b_close[t - 1]
        eq[t] = v
    return eq


def flips(reg):
    r = reg[WARM:]
    return int(np.sum(r[1:] != r[:-1]))


base = S.simulate(D, sig, WARM)
bench = base["bench"]
bf, bb = seg(bench, bench, WARM, i_split + 1)[1], seg(bench, bench, i_split, T)[1]
print(f"資料 {dates[0]} ~ {dates[-1]}；從 {dates[WARM]} 開盤開始；前段 < {SPLIT} ≤ 後段；每種 {SEEDS} 種挑股順序")
print(f"0050：前段 {bf*100:+.0f}%、後段 {bb*100:+.0f}%，最大回落 {S.max_drawdown(bench[WARM:])*100:.0f}%\n")

m20, m100, m120 = S.regime_ma(D, 20), S.regime_ma(D, 100), S.regime_ma(D, 120)
CUTS = [
    ("定案：跌破 120 日線", m120),
    ("跌破 20 日線", m20),
    ("跌破 100 日線", m100),
    ("跌破任一條（20 或 100）", m20 & m100),
    ("兩條都跌破", m20 | m100),
]

print(f"{'多空切法':<26} {'空頭天數':>6} {'切換':>5} │ {'純擇時 前段':>9} {'後段':>6} {'回落':>5} │ "
      f"{'策略 前段 中位（贏）':<16} {'後段 中位（贏）':<14} {'回落':>5} │ 逐年 中位超額（點）")
for name, reg in CUTS:
    eq = timing_only(reg)
    tf, tb = seg(eq, bench, WARM, i_split + 1)[0], seg(eq, bench, i_split, T)[0]
    A, B, M, Y = [], [], [], {y: [] for y in YEARS}
    for sd in range(SEEDS):
        r = S.run(D, sig, WARM, regime=reg, order="random", seed=sd)
        A.append(seg(r["eq"], bench, WARM, i_split + 1)[0])
        B.append(seg(r["eq"], bench, i_split, T)[0])
        M.append(S.max_drawdown(r["eq"][WARM:]))
        for y, (lo, hi) in YB.items():
            s_, b_ = seg(r["eq"], bench, lo, hi)
            Y[y].append(s_ - b_)
    A, B = np.array(A), np.array(B)
    print(f"{name:<26} {np.mean(~reg[WARM:])*100:>5.0f}% {flips(reg):>5} │ {tf*100:>+8.0f}% {tb*100:>+5.0f}% "
          f"{S.max_drawdown(eq[WARM:])*100:>4.0f}% │ {np.median(A)*100:>+5.0f}%（{np.mean(A > bf)*100:3.0f}%）    "
          f"{np.median(B)*100:>+5.0f}%（{np.mean(B > bb)*100:3.0f}%）  {np.median(M)*100:>4.0f}% │ "
          + " ".join(f"{y[2:]}:{np.median(v)*100:+.0f}" for y, v in Y.items()), flush=True)
