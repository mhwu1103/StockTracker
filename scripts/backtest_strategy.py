"""策略頁那套規則（動能 ＋ 營收創新高，抱 20 天）的回測與壓力測試。

    GOOAYE_DATA=<解壓後的長歷史 docs/data> python scripts/backtest_strategy.py

只印表，不寫檔；結論整理在 BACKTEST.md。規則與算式都在 scripts/strategy.py，網站（build_strategy.py）
用的是同一份。

壓力測試：開盤漲停買不買得到、晚 1～2 天進場、持有天數、檔數、訊號多時怎麼挑、逐年對 0050、
同一套機制改成隨機選股、跟 0050 各半
"""

from __future__ import annotations

import sys

import numpy as np

import strategy as S

sys.stdout.reconfigure(encoding="utf-8")
SPLIT = "2024-07-01"
WARM = 130

D = S.Data(S.stock_dirs())
dates, T = D.dates, D.T
sig = S.signals(D)
i_split = next(i for i, d in enumerate(dates) if d >= SPLIT)


def seg(res, lo, hi):
    """lo～hi（索引）這一段的報酬與最大回落：策略、0050"""
    e, b = res["eq"][lo:hi], res["bench"][lo:hi]
    e, b = e / e[0], b / b[0]
    return e[-1] - 1, b[-1] - 1, S.max_drawdown(e), S.max_drawdown(b)


def line(res, label):
    a = seg(res, WARM, i_split + 1)
    b = seg(res, i_split, T)
    r = np.array([t["r"] for t in res["trades"]])
    return (f"{label:<34} 前段 {a[0]*100:+6.0f}%（0050 {a[1]*100:+4.0f}%）回落 {a[2]*100:4.0f}%／{a[3]*100:4.0f}% ｜ "
            f"後段 {b[0]*100:+6.0f}%（0050 {b[1]*100:+4.0f}%）回落 {b[2]*100:4.0f}%／{b[3]*100:4.0f}% ｜ "
            f"{len(r)} 筆 勝率 {(r > 0).mean()*100:4.1f}%")


print(f"資料 {dates[0]} ~ {dates[-1]}；從 {dates[WARM]} 開盤開始；前段 < {SPLIT} ≤ 後段；回落是 策略／0050")
base = S.simulate(D, sig, WARM)
print("\n一、規則本身")
print(line(base, "定案的規則"))

print("\n二、壓力測試")
for label, kw in (("不跳過開盤漲停（假設買得到）", {"skip_limit": False}),
                  ("晚 1 天進場", {"delay": 1}), ("晚 2 天進場", {"delay": 2}),
                  ("抱 10 天", {"hold": 10}), ("抱 40 天", {"hold": 40}), ("抱 60 天", {"hold": 60}),
                  ("最多 5 檔", {"K": 5}), ("最多 20 檔", {"K": 20}),
                  ("訊號多時隨機挑", {"order": "random", "seed": 1}),
                  ("訊號多時挑最弱的", {"order": "weak"})):
    print(line(S.simulate(D, sig, WARM, **kw), label))

print("\n三、逐年（策略報酬／0050 報酬）")
years = sorted({d[:4] for d in dates[WARM:]})
cells = []
for y in years:
    lo = max(WARM, next(i for i, d in enumerate(dates) if d[:4] == y) - 1)
    hi = next((i for i, d in enumerate(dates) if d[:4] > y), T)
    s, b, _, _ = seg(base, lo, hi)
    cells.append(f"{y} {s*100:+5.0f}%／{b*100:+4.0f}%")
print("  ".join(cells))

print("\n四、同一套機制改成隨機選股（每天在流動池隨機挑跟訊號一樣多檔，30 次）")
rand_n = sig.sum(1)
ra, rb = [], []
for sd in range(30):
    r = S.simulate(D, sig, WARM, seed=sd, rand_n=rand_n)
    ra.append(seg(r, WARM, i_split + 1)[0])
    rb.append(seg(r, i_split, T)[0])
ra.sort()
rb.sort()
print(f"隨機：前段 中位 {ra[15]*100:+.0f}%（最好 {ra[-1]*100:+.0f}%）｜ 後段 中位 {rb[15]*100:+.0f}%（最好 {rb[-1]*100:+.0f}%）")

print("\n五、跟 0050 各配一部分（每天再平衡，近似）")
for w in (0.3, 0.5, 0.7):
    rs = np.r_[0, base["eq"][WARM + 1:] / base["eq"][WARM:-1] - 1]
    rb_ = np.r_[0, base["bench"][WARM + 1:] / base["bench"][WARM:-1] - 1]
    mix = {"eq": np.full(T, np.nan), "bench": base["bench"], "trades": base["trades"]}
    mix["eq"][WARM:] = np.cumprod(1 + w * rs + (1 - w) * rb_)
    print(line(mix, f"策略 {int(w*100)}% ＋ 0050 {int((1-w)*100)}%"))
