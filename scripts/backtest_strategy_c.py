"""策略 C（處置期間：公布隔天開盤買、處置最後一天收盤賣、最多 10 檔、不看多空）的回測與壓力測試。

    GOOAYE_DATA=<解壓後的長歷史 docs/data> python scripts/backtest_strategy_c.py [trade]

只印表，不寫檔；結論整理在 BACKTEST.md「處置期間」，策略頁「規則」分頁的數字（build_strategy.py 的
RESEARCH_C）也從這裡來。規則與算式都在 scripts/strategy.py，網站用的是同一份（strategy.run_c）。

事件研究（跟漲幅相近的對照組比、出關之後怎麼走）在 backtest_disposal.py；這支問的是做成組合、扣成本、
受檔數限制、跟 0050 比之後還剩多少。2022-04-19 開盤開始（跟策略 A 同一天），前段 < 2024-07 ≤ 後段。
主要的數字都報 SEEDS 種挑股順序（訊號多於空位時隨機挑）的中位數、10～90% 範圍與贏 0050 的比例。
加 trade 多跑每筆交易與「報酬落在處置期間的哪幾天」。

2026-08-07 起處置改成 5 個交易日（之前 10 個），所以另外報「只抱最後 5 天」與新制單獨一段。
"""

from __future__ import annotations

import sys

import numpy as np

import strategy as S

sys.stdout.reconfigure(encoding="utf-8")
FROM, SPLIT_D, NEW_D, B_FROM = "2022-04-19", "2024-07-01", "2026-08-07", "2023-03-01"
SEEDS = 30
ARGS = set(sys.argv[1:])

D = S.Data(S.stock_dirs())
dates, T, N = D.dates, D.T, D.N
EV = [e for e in S.disposal_events(D) if e["ie"] < T]          # 迄日還沒到的不算


def at(d):
    return next(i for i, x in enumerate(dates) if x >= d)


START, SPLIT, NEW, B0 = at(FROM), at(SPLIT_D), at(NEW_D), at(B_FROM)
YEARS = sorted({d[:4] for d in dates[START:]})
YB = {y: (max(START, at(y) - 1), next((i for i, d in enumerate(dates) if d[:4] > y), T)) for y in YEARS}
REG = S.regime_ma(D, 120)
COST = S.RULE_C["cost"]

up10 = np.full((T, N), np.nan)
up10[10:] = D.ACf[10:] / D.ACf[:-10] - 1
disposed = np.zeros((T, N), bool)
for e in EV:
    disposed[e["s"]:e["ie"] + 1, e["k"]] = True


def control(seed, ev=EV):
    """對照：同一天、近 10 日漲幅在這一檔 ±25%（相對）以內、沒被處置的股票隨機挑一檔，抱一樣久"""
    rng = np.random.default_rng(500 + seed)
    out = []
    for e in ev:
        u = up10[e["s"]]
        x = u[e["k"]]
        if not np.isfinite(x) or x <= 0:
            continue
        c = np.nonzero(np.isfinite(u) & (u >= x * .75) & (u <= x * 1.25) & ~disposed[e["s"]] & np.isfinite(D.AC[e["s"]]))[0]
        if len(c):
            out.append({**e, "k": int(rng.choice(c))})
    return out


def sharpe(eq):
    x = eq[np.isfinite(eq)]
    r = np.diff(x) / x[:-1]
    return r.mean() / r.std() * np.sqrt(245)


def seg(r, lo, hi):
    e, b = r["eq"], r["bench"]
    return e[hi - 1] / e[lo] - 1, b[hi - 1] / b[lo] - 1


def dist(label, fn, seeds=SEEDS, lo=None):
    lo = START if lo is None else lo
    F, B, A, M, SH, W, Nn, H, Y = [], [], [], [], [], [], [], [], {y: [] for y in YEARS}
    bf = 0.0
    for sd in range(seeds):
        r = fn(sd)
        if lo < SPLIT:
            f, bf = seg(r, lo, SPLIT)
            F.append(f)
        b, bb = seg(r, max(lo, SPLIT), T)
        a, ba = seg(r, lo, T)
        B.append(b)
        A.append(a)
        M.append(S.max_drawdown(r["eq"][lo:]))
        SH.append(sharpe(r["eq"][lo:]))
        tr = r["trades"]
        W.append(np.mean([x["r"] > 0 for x in tr]) if tr else np.nan)
        Nn.append(len(tr))
        H.append(np.mean([x["x"] - x["e"] + 1 for x in tr]) if tr else np.nan)
        for y, (a_, b_) in YB.items():
            if b_ > lo:
                s_, z_ = seg(r, max(a_, lo), b_)
                Y[y].append(s_ - z_)

    def q(v, base):
        return (f"{np.median(v)*100:+4.0f}%（{np.percentile(v,10)*100:+.0f}～{np.percentile(v,90)*100:+.0f}，"
                f"贏 {np.mean(np.array(v)>base)*100:3.0f}%）")

    print(f"{label:<30} " + (f"前 {q(F, bf)} " if F else "") + f"後 {q(B, bb)} 全 {q(A, ba)}"
          f"｜回落 {np.median(M)*100:.0f}% 夏普 {np.median(SH):.2f} {np.median(Nn):.0f} 筆 抱 {np.nanmean(H):.1f} 天 勝率 {np.nanmean(W)*100:.0f}%")
    print("      逐年超額：" + " ".join(f"{y} {np.median(v)*100:+.0f}（{np.mean(np.array(v)>0)*100:.0f}%）"
                                    for y, v in Y.items() if v), flush=True)


def run(sd, ev=EV, **kw):
    return S.run_c(D, ev, START, order="random", seed=sd, **kw)


base = S.run_c(D, EV, START)
bz = base["bench"][START:]
print(f"資料 {dates[0]} ~ {dates[-1]}；從 {dates[START]} 開盤開始；每種 {SEEDS} 種挑股順序")
print(f"處置 {len(EV)} 筆（普通股）、{len({e['k'] for e in EV})} 檔；逐年 "
      + " ".join(f"{y} {sum(1 for e in EV if dates[e['s']][:4] == y)}" for y in YEARS)
      + f"；新制（{NEW_D} 起）{sum(1 for e in EV if e['s'] + 1 >= NEW)} 筆")
print(f"0050 前段 {seg(base, START, SPLIT)[1]*100:+.0f}%、後段 {seg(base, SPLIT, T)[1]*100:+.0f}%、全期 {(bz[-1]/bz[0]-1)*100:+.0f}%、"
      f"回落 {S.max_drawdown(bz)*100:.0f}%、夏普 {sharpe(bz):.2f}\n")

print("一、定案的規則與對照")
dist("定案（10 檔、不看多空）", run)
dist("單一路徑：先買 20 日漲幅大的", lambda sd: base, seeds=1)
dist("空頭停手、閒錢放現金", lambda sd: run(sd, regime=REG))
dist("最多 5 檔", lambda sd: run(sd, K=5))
dist("最多 20 檔", lambda sd: run(sd, K=20))
dist("對照：漲幅相近、沒被處置的", lambda sd: run(sd, ev=control(sd)))
dist("只做第一次處置", lambda sd: run(sd, ev=[e for e in EV if e["n"] == 1]))
dist("只做第二次處置", lambda sd: run(sd, ev=[e for e in EV if e["n"] == 2]))

print("\n二、壓力測試（定案規則，改其中一項）")
for label, kw in (("不跳過開盤漲停（假設買得到）", {"skip_limit": False}),
                  ("收盤跌停也賣得掉", {"ld": False}),
                  ("多扣滑價 0.5%（來回 1.085%）", {"slip": 0.005}), ("多扣滑價 1.0%", {"slip": 0.010}),
                  ("多扣滑價 1.5%", {"slip": 0.015}), ("多扣滑價 2.0%", {"slip": 0.020}),
                  ("晚 1 天進場", {"delay": 1}), ("晚 2 天進場", {"delay": 2}),
                  ("只抱最後 3 天", {"last": 3}), ("只抱最後 5 天", {"last": 5}), ("只抱最後 7 天", {"last": 7}),
                  ("只抱最後 5 天＋滑價 1.0%", {"last": 5, "slip": 0.010}),
                  ("改成出關那天開盤賣", {"exit_open": True}),
                  ("固定抱 5 天", {"hold": 5}), ("固定抱 10 天", {"hold": 10}), ("固定抱 20 天", {"hold": 20})):
    dist(label, lambda sd, kw=kw: run(sd, **kw))

print(f"\n三、新制（{NEW_D} 起，處置 5 個交易日）單獨跑")
evn = [e for e in EV if e["s"] + 1 >= NEW]
for K in (10, 20):
    out = [S.run_c(D, evn, NEW, order="random", seed=sd, K=K) for sd in range(SEEDS)]
    a = np.array([r["eq"][T - 1] - 1 for r in out])
    bn = out[0]["bench"][T - 1] - 1
    print(f"  最多 {K} 檔：{np.median(a)*100:+.0f}%（{np.percentile(a,10)*100:+.0f}～{np.percentile(a,90)*100:+.0f}），"
          f"0050 {bn*100:+.0f}%，贏 {np.mean(a > bn)*100:.0f}%，{np.median([len(r['trades']) for r in out]):.0f} 筆")

print(f"\n四、跟另外兩套（{B_FROM} 起，B 的訊號那時才有）")
sa = S.signals(D)
sb, _ = S.signals_b(D)
ea, eb, ec = S.run(D, sa, B0)["eq"], S.run_b(D, sb, B0)["eq"], S.run_c(D, EV, B0)["eq"]
z = D.b_close


def corr(x, y, step=10):
    rx, ry, rz = (np.diff(np.log(v[B0::step])) for v in (x, y, z))
    return np.corrcoef(rx, ry)[0, 1], np.corrcoef(rx - rz, ry - rz)[0, 1]


print("  10 日報酬相關（原始／減 0050）：C–A %.2f／%.2f、C–B %.2f／%.2f、A–B %.2f／%.2f"
      % (*corr(ec, ea), *corr(ec, eb), *corr(ea, eb)))


def blend(sd, which):
    rs = {"a": lambda: S.run(D, sa, B0, order="random", seed=sd),
          "b": lambda: S.run_b(D, sb, B0, order="random", seed=sd),
          "c": lambda: S.run_c(D, EV, B0, order="random", seed=sd)}
    out = [rs[w]() for w in which]
    return {"eq": sum(r["eq"] for r in out) / len(out), "bench": out[0]["bench"],
            "trades": sum((r["trades"] for r in out), [])}


for lab, w in (("只做 A", "a"), ("只做 B", "b"), ("只做 C", "c"), ("A、B 各一半", "ab"), ("三套各三分之一", "abc")):
    dist(lab, lambda sd, w=w: blend(sd, w), seeds=20, lo=B0)

if "trade" in ARGS:
    print("\n五、每筆交易（每個訊號都買、不受檔數限制，第一天開盤買 → 最後一天收盤賣、扣成本）")
    rows = []
    for e in EV:
        t, k = e["s"] + 1, e["k"]
        if t < START or not np.isfinite(D.AO[t, k]) or D.LIMIT_OPEN[t, k]:
            continue
        r = D.ACf[e["ie"], k] / D.AO[t, k] - 1 - COST
        rows.append((dates[t][:4], r, r - (D.b_close[e["ie"]] / D.b_open[t] - 1), bool(REG[e["s"]]), t >= NEW, e["n"]))
    yy = np.array([x[0] for x in rows])
    r, x = np.array([x[1] for x in rows]), np.array([x[2] for x in rows])
    bl, nw, nn = (np.array([x[j] for x in rows]) for j in (3, 4, 5))
    for lab, m in [("全部", np.ones(len(r), bool)), ("多頭時", bl), ("空頭時", ~bl), ("舊制", ~nw), ("新制", nw),
                   ("第一次處置", nn == 1), ("第二次處置", nn == 2)] + [(y, yy == y) for y in YEARS]:
        v, w = r[m], x[m]
        print(f"  {lab}：{m.sum()} 筆，賺錢 {np.mean(v>0)*100:.0f}%，平均 {v.mean()*100:+.2f}%、中位 {np.median(v)*100:+.2f}%，"
              f"賺的 {v[v>0].mean()*100:+.1f}%／賠的 {v[v<=0].mean()*100:+.1f}%；"
              f"減 0050 平均 {w.mean()*100:+.2f}%、中位 {np.median(w)*100:+.2f}%、贏 {np.mean(w>0)*100:.0f}%")
    v = np.sort(r)
    print(f"  右尾：拿掉最賺的 1% 平均 {v[:int(len(v)*.99)].mean()*100:+.2f}%、拿掉 5% {v[:int(len(v)*.95)].mean()*100:+.2f}%；"
          f"單筆賠超過 20% 的 {np.mean(v < -.2)*100:.1f}%、最差 {v[0]*100:.0f}%、最好 {v[-1]*100:.0f}%")

    print("\n  報酬落在處置期間的哪幾天（個股 − 0050；倒數第 1 天＝處置最後一天，收盤 ÷ 前一天收盤）")
    for lab, ev in (("舊制", [e for e in EV if START <= e["s"] + 1 < NEW]), ("新制", [e for e in EV if e["s"] + 1 >= NEW]),
                    ("對照（漲幅相近、沒被處置）", control(0, [e for e in EV if e["s"] + 1 >= START]))):
        ev = [e for e in ev if e["ie"] + 3 < T and np.isfinite(D.AO[e["s"] + 1, e["k"]])]
        out = []
        for j in range(5, -1, -1):
            v = []
            for e in ev:
                t, k = e["ie"] - j, e["k"]
                if t <= e["s"]:
                    continue
                p0, b0 = (D.AOf[t, k], D.b_open[t]) if t == e["s"] + 1 else (D.ACf[t - 1, k], D.b_close[t - 1])
                v.append(D.ACf[t, k] / p0 - 1 - (D.b_close[t] / b0 - 1))
            out.append(f"倒數第 {j+1} 天 {np.nanmean(v)*100:+.2f}")
        aft = [np.nanmean([D.ACf[e["ie"] + j, e["k"]] / D.ACf[e["ie"] + j - 1, e["k"]]
                           - D.b_close[e["ie"] + j] / D.b_close[e["ie"] + j - 1] for e in ev]) * 100 for j in (1, 2, 3)]
        print(f"  {lab}（{len(ev)} 筆）：" + "、".join(out) + "；出關後第 1／2／3 天 " + "／".join(f"{a:+.2f}" for a in aft))
