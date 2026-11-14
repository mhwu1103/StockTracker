"""策略 B（好財報 ＋ 開高、抱 20 天、最多 20 檔、空頭停手放現金）的回測與壓力測試。

    GOOAYE_DATA=<解壓後的長歷史 docs/data> python scripts/backtest_strategy_b.py [trade] [exit]

只印表，不寫檔；結論整理在 BACKTEST.md「好財報 ＋ 開高」，策略頁「規則」分頁的數字（build_strategy.py 的
RESEARCH_B）也從這裡來。規則與算式都在 scripts/strategy.py，網站用的是同一份（strategy.run_b）。

財報要有去年同季可比，資料從 2021-10 起，所以訊號 2023-03 才開始——只有一段，沒有前後段可切。
組合的結果有路徑依賴，主要的數字都報 SEEDS 種挑股順序（訊號多於空位時隨機挑）的中位數、10～90% 範圍
與贏 0050 的比例。不帶參數跑第一、二節；加 trade 多跑每筆交易與漂移發生在哪幾天，加 exit 多跑出場比較。
"""

from __future__ import annotations

import sys

import numpy as np

import strategy as S
import structure

sys.stdout.reconfigure(encoding="utf-8")
FROM = "2023-03-01"
SEEDS = 30
ARGS = set(sys.argv[1:])

D = S.Data(S.stock_dirs())
dates, T, N = D.dates, D.T, D.N
EV = S.fin_events(D)
SIG, _ = S.signals_b(D, EV)
POOL = S.pool_b(D)
ALLFIN = np.zeros((T, N), bool)                   # 每一則有得比的季報（在流動池裡的），當隨機對照的母體
for t, k, g, r, p1 in EV:
    ALLFIN[t, k] = POOL[t, k]
START = next(i for i, d in enumerate(dates) if d >= FROM)
YEARS = sorted({d[:4] for d in dates[START:]})
YB = {y: (max(START, next(i for i, d in enumerate(dates) if d[:4] == y) - 1),
          next((i for i, d in enumerate(dates) if d[:4] > y), T)) for y in YEARS}
REG = S.regime_ma(D, S.RULE_B["regime_ma"])
el = structure.electronic_codes()
EL = np.array([c in el for c in D.codes])


def seg(res, lo, hi):
    e, b = res["eq"][lo:hi], res["bench"][lo:hi]
    return e[-1] / e[0] - 1, b[-1] / b[0] - 1


def sharpe(eq):
    x = eq[np.isfinite(eq)]
    r = np.diff(x) / x[:-1]
    return r.mean() / r.std() * np.sqrt(245)


def dist(label, fn, seeds=SEEDS):
    A, M, W, Nn, SH, H, Y = [], [], [], [], [], [], {y: [] for y in YEARS}
    for sd in range(seeds):
        r = fn(sd)
        a, bf = seg(r, START, T)
        A.append(a)
        M.append(S.max_drawdown(r["eq"][START:]))
        SH.append(sharpe(r["eq"][START:]))
        tr = r["trades"]
        W.append(np.mean([t["r"] > 0 for t in tr]) if tr else np.nan)
        H.append(np.mean([t["x"] - t["e"] for t in tr]) if tr else np.nan)
        Nn.append(len(tr))
        for y, (lo, hi) in YB.items():
            s_, b_ = seg(r, lo, hi)
            Y[y].append(s_ - b_)
    A = np.array(A)
    print(f"{label:<32} {np.median(A)*100:+5.0f}%（{np.percentile(A,10)*100:+4.0f}～{np.percentile(A,90)*100:+4.0f}），贏 0050 {np.mean(A>bf)*100:3.0f}%"
          f"｜回落 {np.median(M)*100:4.0f}% 夏普 {np.median(SH):.2f} {np.median(Nn):4.0f} 筆 平均抱 {np.nanmean(H):4.1f} 天 勝率 {np.nanmean(W)*100:.0f}%")
    print("      逐年 中位超額（贏的比例）：" + " ".join(f"{y} {np.median(v)*100:+.0f}（{np.mean(np.array(v)>0)*100:.0f}%）"
                                              for y, v in Y.items()), flush=True)


def rand_sig(seed, target, pool):
    """每天從 pool（同一天也有季報反應的股票）隨機抽跟 target 一樣多檔"""
    rng = np.random.default_rng(1000 + seed)
    m = np.zeros((T, N), bool)
    for i in np.nonzero(target.any(1))[0]:
        cand = np.nonzero(pool[i])[0]
        n = min(int(target[i].sum()), len(cand))
        if n:
            m[i, rng.choice(cand, n, replace=False)] = True
    return m


def run(sig, sd, **kw):
    return S.run_b(D, sig, START, order="random", seed=sd, **kw)


base = S.run_b(D, SIG, START)
bz = base["bench"][START:]
print(f"資料 {dates[0]} ~ {dates[-1]}；從 {dates[START]} 開盤開始；每種 {SEEDS} 種挑股順序")
print(f"季報 {len(EV)} 則（有去年同季可比）；訊號 {SIG[START:].sum()} 筆、{SIG[START:].any(0).sum()} 檔"
      f"（電子 {(SIG[START:] & EL).sum()} 筆）；逐年 " + " ".join(f"{y} {SIG[lo:hi].sum()}" for y, (lo, hi) in YB.items()))
print(f"0050 {(bz[-1]/bz[0]-1)*100:+.0f}%、回落 {S.max_drawdown(bz)*100:.0f}%、夏普 {sharpe(bz):.2f}；"
      f"空頭天數 {np.mean(~REG[START:])*100:.0f}%\n")

print("一、定案的規則與對照")
dist("定案（20 檔、空頭停手放現金）", lambda sd: run(SIG, sd))
dist("單一路徑：先買 20 日漲幅大的", lambda sd: S.run_b(D, SIG, START), seeds=1)
dist("不分多空", lambda sd: run(SIG, sd, regime=None))
dist("最多 10 檔", lambda sd: run(SIG, sd, K=10))
dist("最多 10 檔、不分多空", lambda sd: run(SIG, sd, K=10, regime=None))
dist("對照：隨機挑有季報的股票", lambda sd: run(rand_sig(sd, SIG, ALLFIN), sd))
sa = S.signals(D)
dist("策略 A（同一段）", lambda sd: S.run(D, sa, START, order="random", seed=sd))


def half(sd):
    a = S.run(D, sa, START, order="random", seed=sd)
    b = run(SIG, sd)
    return {"eq": (a["eq"] + b["eq"]) / 2, "bench": a["bench"], "trades": a["trades"] + b["trades"]}


dist("A、B 各一半資金", half)
a_ = S.run(D, sa, START)["eq"][START:]
b_ = base["eq"][START:]
ra, rb, rz = (np.diff(np.log(x[::20])) for x in (a_, b_, bz))
print(f"20 日報酬相關：A–B {np.corrcoef(ra, rb)[0, 1]:.2f}；減 0050 之後 {np.corrcoef(ra - rz, rb - rz)[0, 1]:.2f}")

print("\n二、壓力測試（定案規則，改其中一項）")
for label, kw in (("不跳過開盤漲停（假設買得到）", {"skip_limit": False}),
                  ("晚 1 天進場", {"delay": 1}), ("晚 2 天進場", {"delay": 2}), ("晚 3 天進場", {"delay": 3}),
                  ("晚 5 天進場", {"delay": 5}), ("晚 10 天進場", {"delay": 10}),
                  ("抱 10 天", {"hold": 10}), ("抱 15 天", {"hold": 15}), ("抱 40 天", {"hold": 40}), ("抱 60 天", {"hold": 60}),
                  ("最多 30 檔", {"K": 30}),
                  ("空頭閒錢留在 0050", {"bear_idle": "0050"}),
                  ("多空改用 60 日線", {"regime": S.regime_ma(D, 60)}),
                  ("多空改用 200 日線", {"regime": S.regime_ma(D, 200)})):
    dist(label, lambda sd, kw=kw: run(SIG, sd, **kw))
for label, m in (("只做電子股", EL), ("只做非電子股", ~EL)):
    dist(label, lambda sd, m=m: run(SIG & m[None, :], sd))
    dist(f"  對照：隨機挑{label[2:]}的季報股", lambda sd, m=m: run(rand_sig(sd, SIG & m[None, :], ALLFIN & m[None, :]), sd))

if "trade" in ARGS:
    H = S.RULE_B["hold"]
    print(f"\n三、每筆交易（每個訊號都買、不受檔數限制，隔天開盤買、抱 {H} 天、扣成本）")

    def picks(m, need):
        ss, cc = np.nonzero(m[START:T - need])
        ss = ss + START
        ok = np.isfinite(D.AO[ss + 1, cc]) & ~D.LIMIT_OPEN[ss + 1, cc]
        return ss[ok], cc[ok]

    for lab, m in (("B 全部", SIG), ("B 電子", SIG & EL[None, :]), ("B 非電子", SIG & ~EL[None, :]),
                   ("B 多頭時", SIG & REG[:, None]), ("B 空頭時", SIG & ~REG[:, None]),
                   ("B＋營收創 12 月新高", SIG & D.REVHI), ("全部季報（對照）", ALLFIN), ("策略 A 的訊號", sa)):
        ss, cc = picks(m, H + 2)
        r = D.AOf[ss + 1 + H, cc] / D.AO[ss + 1, cc] - 1 - S.RULE_B["cost"]
        x = r - (D.b_open[ss + 1 + H] / D.b_open[ss + 1] - 1)
        yy = np.array([dates[s + 1][:4] for s in ss])
        print(f"  {lab}：{len(r)} 筆、{len(set(cc))} 檔，賺錢 {np.mean(r>0)*100:.0f}%，平均 {r.mean()*100:+.1f}%、中位 {np.median(r)*100:+.1f}%，"
              f"賺的 {r[r>0].mean()*100:+.1f}%／賠的 {r[r<=0].mean()*100:+.1f}%；減 0050 平均 {x.mean()*100:+.1f}%、贏 {np.mean(x>0)*100:.0f}%")
        print("      逐年 筆／賺錢／平均／減 0050：" + " ".join(
            f"{y} {np.sum(yy==y)}／{np.mean(r[yy==y]>0)*100:.0f}%／{r[yy==y].mean()*100:+.1f}／{x[yy==y].mean()*100:+.1f}"
            for y in YEARS if np.sum(yy == y)))
    print("\n  漂移發生在買進後的哪幾天（個股 − 0050，開盤到開盤；第 1 天＝規則的買進日）")
    wins = [(1, 3), (3, 6), (6, 11), (11, 16), (16, 21), (21, 31), (31, 41), (41, 61)]
    for lab, m in (("B", SIG), ("全部季報", ALLFIN)):
        ss, cc = picks(m, 62)
        out = []
        for a, b in wins:
            x = D.AOf[ss + b, cc] / D.AOf[ss + a, cc] - 1 - (D.b_open[ss + b] / D.b_open[ss + a] - 1)
            out.append(f"第 {a}～{b-1} 天 {np.nanmean(x)*100:+.2f}%（每天 {np.nanmean(x)/(b-a)*100:+.2f}）")
        print(f"  {lab}（{len(ss)} 筆）：" + "；".join(out))

if "exit" in ARGS:
    print("\n四、出場方式比較（定案規則只換出場，20 種挑股順序）")
    for name, ex in (
            ("固定 10 天", {"hold": 10}), ("固定 15 天", {"hold": 15}), ("固定 20 天（定案）", {"hold": 20}),
            ("固定 25 天", {"hold": 25}), ("固定 30 天", {"hold": 30}), ("固定 40 天", {"hold": 40}), ("固定 60 天", {"hold": 60}),
            ("跌破 10 日線", {"hold": None, "ma": 10}), ("跌破 20 日線", {"hold": None, "ma": 20}),
            ("跌破 60 日線", {"hold": None, "ma": 60}),
            ("高點回落 10%", {"hold": None, "trail": 0.10}), ("高點回落 15%", {"hold": None, "trail": 0.15}),
            ("高點回落 20%", {"hold": None, "trail": 0.20}),
            ("20 天＋停損 8%", {"hold": 20, "stop": 0.08}), ("20 天＋停損 12%", {"hold": 20, "stop": 0.12}),
            ("20 天＋停利 20%", {"hold": 20, "take": 0.20}), ("20 天＋停利 30%", {"hold": 20, "take": 0.30}),
            ("滿 20 天後破 20 日線才賣", {"hold": None, "min": 20, "ma": 20}),
            ("滿 20 天後回落 15% 才賣", {"hold": None, "min": 20, "trail": 0.15}),
            ("20 天；破 10 日線且虧 8% 提前賣", {"hold": 20, "ma_stop": (10, 0.08)}),
            ("40 天；破 10 日線且虧 8% 提前賣", {"hold": 40, "ma_stop": (10, 0.08)})):
        dist(name, lambda sd, ex=ex: run(SIG, sd, exit=ex), seeds=20)
