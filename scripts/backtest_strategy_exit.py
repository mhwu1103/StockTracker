"""策略頁的進場不變，換不同的出場方式比較。

    GOOAYE_DATA=<解壓後的長歷史 docs/data> python scripts/backtest_strategy_exit.py

只印表，不寫檔；結論整理在 BACKTEST.md。進場、資金、成本都跟 scripts/strategy.py 定案的一樣，只換 exit。
組合的結果有路徑依賴，所以每一種出場都跑 SEEDS 種挑股順序（訊號多於空位時隨機挑），報中位數與範圍。
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

EXITS = [
    ("固定抱 10 天", {"hold": 10}),
    ("固定抱 15 天", {"hold": 15}),
    ("固定抱 20 天（定案）", {"hold": 20}),
    ("固定抱 25 天", {"hold": 25}),
    ("固定抱 30 天", {"hold": 30}),
    ("固定抱 40 天", {"hold": 40}),
    ("固定抱 60 天", {"hold": 60}),
    ("跌破 10 日線", {"hold": None, "ma": 10}),
    ("跌破 20 日線", {"hold": None, "ma": 20}),
    ("跌破 60 日線", {"hold": None, "ma": 60}),
    ("最高點回落 10%", {"hold": None, "trail": 0.10}),
    ("最高點回落 15%", {"hold": None, "trail": 0.15}),
    ("最高點回落 20%", {"hold": None, "trail": 0.20}),
    ("最高點回落 25%", {"hold": None, "trail": 0.25}),
    ("抱 20 天＋停損 8%", {"hold": 20, "stop": 0.08}),
    ("抱 20 天＋停損 12%", {"hold": 20, "stop": 0.12}),
    ("抱 20 天＋停利 20%", {"hold": 20, "take": 0.20}),
    ("抱 20 天＋停利 30%", {"hold": 20, "take": 0.30}),
    ("抱滿 20 天後跌破 20 日線才賣", {"hold": None, "min": 20, "ma": 20}),
    ("抱滿 20 天後最高點回落 15% 才賣", {"hold": None, "min": 20, "trail": 0.15}),
    ("抱 20 天，到期又有訊號就續抱", {"hold": 20, "renew": True}),
    ("抱 60 天＋最高點回落 15%", {"hold": 60, "trail": 0.15}),
    # 「跌破 10 日線就走」的折衷：先抱一段才看 10 日線；或抱 20 天、跌破 10 日線又虧到一定程度才提前走
    ("跌破 10 日線（對照）", {"hold": None, "ma": 10}),
    ("先抱 5 天，之後跌破 10 日線才賣", {"hold": None, "min": 5, "ma": 10}),
    ("先抱 10 天，之後跌破 10 日線才賣", {"hold": None, "min": 10, "ma": 10}),
    ("先抱 15 天，之後跌破 10 日線才賣", {"hold": None, "min": 15, "ma": 10}),
    ("先抱 10 天後看 10 日線，最多 40 天", {"hold": 40, "min": 10, "ma": 10}),
    ("抱 20 天；破 10 日線且虧 5% 提前賣", {"hold": 20, "ma_stop": (10, 0.05)}),
    ("抱 20 天；破 10 日線且虧 8% 提前賣", {"hold": 20, "ma_stop": (10, 0.08)}),
    ("抱 20 天；破 10 日線且虧 12% 提前賣", {"hold": 20, "ma_stop": (10, 0.12)}),
    ("抱 40 天；破 10 日線且虧 8% 提前賣", {"hold": 40, "ma_stop": (10, 0.08)}),
]
# 只跑名稱裡含有命令列參數的那幾種：python backtest_strategy_exit.py 10 日線
if sys.argv[1:]:
    EXITS = [x for x in EXITS if any(a in x[0] for a in sys.argv[1:])]


def seg(res, lo, hi):
    e, b = res["eq"][lo:hi], res["bench"][lo:hi]
    return e[-1] / e[0] - 1, b[-1] / b[0] - 1


print(f"資料 {dates[0]} ~ {dates[-1]}；從 {dates[WARM]} 開盤開始；前段 < {SPLIT} ≤ 後段；每種出場 {SEEDS} 種挑股順序")
b_front = seg(S.simulate(D, sig, WARM), WARM, i_split + 1)[1]
b_back = seg(S.simulate(D, sig, WARM), i_split, T)[1]
print(f"0050：前段 {b_front*100:+.0f}%、後段 {b_back*100:+.0f}%\n")
print(f"{'出場':<30} {'前段 中位（10～90%）':<22}{'贏0050':>6} | {'後段 中位（10～90%）':<22}{'贏0050':>6} | "
      f"{'回落中位':>7} {'平均抱':>6} {'每筆勝率':>7} | 逐年 中位超額（點）")
for name, ex in EXITS:
    A, B, M, H, W, Y = [], [], [], [], [], {y: [] for y in YEARS}
    for sd in range(SEEDS):
        r = S.simulate(D, sig, WARM, order="random", seed=sd, exit=ex)
        A.append(seg(r, WARM, i_split + 1)[0])
        B.append(seg(r, i_split, T)[0])
        M.append(S.max_drawdown(r["eq"][WARM:]))
        tr = r["trades"]
        H.append(np.mean([t["x"] - t["e"] for t in tr]))
        W.append(np.mean([t["r"] > 0 for t in tr]))
        for y, (lo, hi) in YB.items():
            s_, b_ = seg(r, lo, hi)
            Y[y].append(s_ - b_)
    A, B = np.array(A), np.array(B)
    print(f"{name:<30} {np.median(A)*100:+5.0f}%（{np.percentile(A,10)*100:+4.0f}～{np.percentile(A,90)*100:+4.0f}）"
          f"{np.mean(A > b_front)*100:6.0f}% | {np.median(B)*100:+5.0f}%（{np.percentile(B,10)*100:+4.0f}～{np.percentile(B,90)*100:+4.0f}）"
          f"{np.mean(B > b_back)*100:6.0f}% | {np.median(M)*100:6.0f}% {np.mean(H):5.1f}天 {np.mean(W)*100:6.1f}% | "
          + " ".join(f"{y[2:]}:{np.median(v)*100:+.0f}" for y, v in Y.items()), flush=True)
