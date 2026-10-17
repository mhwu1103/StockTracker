"""策略頁那套規則（動能 ＋ 營收創新高、抱 20 天、空頭停手放現金）的回測與壓力測試。

    GOOAYE_DATA=<解壓後的長歷史 docs/data> python scripts/backtest_strategy.py

只印表，不寫檔；結論整理在 BACKTEST.md，策略頁「規則」分頁的數字（build_strategy.py 的 RESEARCH）也從這裡來。
規則與算式都在 scripts/strategy.py，網站用的是同一份（strategy.run）。

組合的結果有路徑依賴（一筆不同，後面整串跟著變），所以主要的數字都報 SEEDS 種挑股順序
（訊號多於空位時隨機挑）的中位數、10～90% 範圍與贏 0050 的比例，不報單一一條。
"""

from __future__ import annotations

import sys

import numpy as np

import strategy as S

sys.stdout.reconfigure(encoding="utf-8")
SPLIT = "2024-07-01"
WARM = 130
SEEDS = 30

D = S.Data(S.stock_dirs())
dates, T = D.dates, D.T
sig = S.signals(D)
i_split = next(i for i, d in enumerate(dates) if d >= SPLIT)
YEARS = sorted({d[:4] for d in dates[WARM:]})
YB = {y: (max(WARM, next(i for i, d in enumerate(dates) if d[:4] == y) - 1),
          next((i for i, d in enumerate(dates) if d[:4] > y), T)) for y in YEARS}


def seg(res, lo, hi):
    e, b = res["eq"][lo:hi], res["bench"][lo:hi]
    return e[-1] / e[0] - 1, b[-1] / b[0] - 1


def dist(label, fn):
    """fn(seed) -> 模擬結果；印分布，回傳摘要"""
    A, B, M, W, Y = [], [], [], [], {y: [] for y in YEARS}
    for sd in range(SEEDS):
        r = fn(sd)
        a, bf = seg(r, WARM, i_split + 1)
        b, bb = seg(r, i_split, T)
        A.append(a)
        B.append(b)
        M.append(S.max_drawdown(r["eq"][WARM:]))
        W.append(np.mean([t["r"] > 0 for t in r["trades"]]))
        for y, (lo, hi) in YB.items():
            s_, b_ = seg(r, lo, hi)
            Y[y].append(s_ - b_)
    A, B = np.array(A), np.array(B)
    out = {
        "front": (np.median(A), np.percentile(A, 10), np.percentile(A, 90), np.mean(A > bf), bf),
        "back": (np.median(B), np.percentile(B, 10), np.percentile(B, 90), np.mean(B > bb), bb),
        "mdd": np.median(M), "win": np.mean(W),
        "years": {y: (np.median(v), np.mean(np.array(v) > 0)) for y, v in Y.items()},
    }
    f, b = out["front"], out["back"]
    print(f"{label:<30} 前段 {f[0]*100:+5.0f}%（{f[1]*100:+4.0f}～{f[2]*100:+4.0f}，贏 0050 {f[3]*100:3.0f}%）｜ "
          f"後段 {b[0]*100:+5.0f}%（{b[1]*100:+4.0f}～{b[2]*100:+4.0f}，{b[3]*100:3.0f}%）｜ 回落 {out['mdd']*100:4.0f}% "
          f"每筆勝率 {out['win']*100:4.1f}%")
    print("    逐年 中位超額（贏 0050 的比例）："
          + " ".join(f"{y} {v[0]*100:+.0f} 點（{v[1]*100:.0f}%）" for y, v in out["years"].items()), flush=True)
    return out


base = S.run(D, sig, WARM)
print(f"資料 {dates[0]} ~ {dates[-1]}；從 {dates[WARM]} 開盤開始；前段 < {SPLIT} ≤ 後段；"
      f"每種 {SEEDS} 種挑股順序；0050 回落 {S.max_drawdown(base['bench'][WARM:])*100:.0f}%")
reg = S.regime_ma(D, S.RULE["regime_ma"])
print(f"空頭天數（0050 在 {S.RULE['regime_ma']} 日線下）：{np.mean(~reg[WARM:])*100:.0f}%\n")

print("一、定案的規則與對照")
dist("定案（含空頭停手放現金）", lambda sd: S.run(D, sig, WARM, order="random", seed=sd))
dist("不分多空（舊版）", lambda sd: S.simulate(D, sig, WARM, order="random", seed=sd))
rand_n = sig.sum(1)
dist("同一套規則改成隨機選股", lambda sd: S.run(D, sig, WARM, seed=sd, rand_n=rand_n))

print("\n二、壓力測試（定案規則，改其中一項）")
for label, kw in (("不跳過開盤漲停（假設買得到）", {"skip_limit": False}),
                  ("晚 1 天進場", {"delay": 1}),
                  ("抱 40 天", {"exit": {"hold": 40}, "exit_bear": {"hold": 40}}),
                  ("最多 5 檔", {"K": 5}), ("最多 20 檔", {"K": 20}),
                  ("空頭閒錢留在 0050", {"bear_idle": "0050"}),
                  ("多空改用 60 日線", {"regime": S.regime_ma(D, 60)}),
                  ("多空改用 200 日線", {"regime": S.regime_ma(D, 200)})):
    dist(label, lambda sd, kw=kw: S.run(D, sig, WARM, order="random", seed=sd, **kw))
