"""策略頁的規則，多頭與空頭用不同做法，有沒有比較好？

    GOOAYE_DATA=<解壓後的長歷史 docs/data> python scripts/backtest_strategy_regime.py

只印表，不寫檔；結論整理在 BACKTEST.md。多空用 0050（還原）收盤在 60／120／200 日線之上或之下判斷，
t 日收盤後就知道、用在 t+1 開盤。每一種跑 SEEDS 種挑股順序。

限制：長歷史只有 2021-10 起，裡面只有一次空頭（2022）。空頭時的做法只在那一次上驗證過。
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
H20, H40, MA10 = {"hold": 20}, {"hold": 40}, {"hold": None, "ma": 10}


def seg(eq, bench, lo, hi):
    e, b = eq[lo:hi], bench[lo:hi]
    return e[-1] / e[0] - 1, b[-1] / b[0] - 1


def timing_only(reg):
    """純擇時對照：多頭抱 0050、空頭抱現金，不選股"""
    eq = np.full(T, np.nan)
    v = 1.0
    eq[WARM] = D.b_close[WARM] / D.b_open[WARM]
    for t in range(WARM + 1, T):
        if reg[t - 1]:
            v *= D.b_close[t] / D.b_close[t - 1]
        eq[t] = v * eq[WARM]
    return eq


base = S.simulate(D, sig, WARM)
bench = base["bench"]
bf, bb = seg(bench, bench, WARM, i_split + 1)[1], seg(bench, bench, i_split, T)[1]
print(f"資料 {dates[0]} ~ {dates[-1]}；從 {dates[WARM]} 開盤開始；前段 < {SPLIT} ≤ 後段；每種 {SEEDS} 種挑股順序")
print(f"0050：前段 {bf*100:+.0f}%、後段 {bb*100:+.0f}%，最大回落 {S.max_drawdown(bench[WARM:])*100:.0f}%")
print(f"\n{'做法':<44} {'前段 中位（贏0050）':<18} | {'後段 中位（贏0050）':<18} | {'回落中位':>6} | 逐年 中位超額（點）")


def run(name, **kw):
    A, B, M, Y = [], [], [], {y: [] for y in YEARS}
    for sd in range(SEEDS):
        r = S.simulate(D, sig, WARM, order="random", seed=sd, **kw)
        A.append(seg(r["eq"], bench, WARM, i_split + 1)[0])
        B.append(seg(r["eq"], bench, i_split, T)[0])
        M.append(S.max_drawdown(r["eq"][WARM:]))
        for y, (lo, hi) in YB.items():
            s_, b_ = seg(r["eq"], bench, lo, hi)
            Y[y].append(s_ - b_)
    A, B = np.array(A), np.array(B)
    print(f"{name:<44} {np.median(A)*100:+5.0f}%（{np.mean(A > bf)*100:3.0f}%）      | "
          f"{np.median(B)*100:+5.0f}%（{np.mean(B > bb)*100:3.0f}%）      | {np.median(M)*100:5.0f}% | "
          + " ".join(f"{y[2:]}:{np.median(v)*100:+.0f}" for y, v in Y.items()), flush=True)


run("一律抱 20 天（定案）")
run("一律抱 40 天", exit=H40)
for n in (60, 120, 200):
    reg = S.regime_ma(D, n)
    bear_days = np.mean(~reg[WARM:])
    bear22 = np.mean(~reg[YB["2022"][0]:YB["2022"][1]])
    eq = timing_only(reg)
    tf, tb = seg(eq, bench, WARM, i_split + 1)[0], seg(eq, bench, i_split, T)[0]
    print(f"\n—— 多空用 0050 的 {n} 日線判斷：空頭天數 {bear_days*100:.0f}%（2022 年 {bear22*100:.0f}%）；"
          f"純擇時（多頭 0050、空頭現金）前段 {tf*100:+.0f}%、後段 {tb*100:+.0f}%、回落 {S.max_drawdown(eq[WARM:])*100:.0f}%")
    run(f"[{n}] 多頭抱 20 天／空頭抱 40 天", regime=reg, exit=H20, exit_bear=H40)
    run(f"[{n}] 多頭跌破 10 日線出場／空頭抱 40 天", regime=reg, exit=MA10, exit_bear=H40)
    run(f"[{n}] 多頭跌破 10 日線出場／空頭抱 20 天", regime=reg, exit=MA10, exit_bear=H20)
    run(f"[{n}] 多頭抱 20 天／空頭最多 5 檔", regime=reg, K_bear=5)
    run(f"[{n}] 多頭抱 20 天／空頭不買新股（閒錢 0050）", regime=reg, K_bear=0)
    run(f"[{n}] 多頭抱 20 天／空頭不買新股、閒錢放現金", regime=reg, K_bear=0, bear_idle="cash")
    run(f"[{n}] 多頭抱 40 天／空頭不買新股、閒錢放現金", regime=reg, exit=H40, exit_bear=H40, K_bear=0, bear_idle="cash")
