"""動能進場、跌破均線出場：不固定持有天數，讓趨勢自己決定抱多久。

    GOOAYE_DATA=<解壓後的長歷史 docs/data> python scripts/backtest_momentum_exit.py

只印表，不寫檔；結論整理在 BACKTEST.md。長歷史怎麼取得見 BACKTEST.md「長歷史放在哪裡」。

- 進場：訊號日收盤成立 → 隔天開盤買。同一檔已經在場內就不重複進
- 出場：收盤跌破 N 日均線（還原後收盤 < 還原後 N 日均）→ 隔天開盤賣；最長抱 250 個交易日
- 股價用 exright/ 還原除權息；單筆報酬扣來回 0.585%
- 每筆跟同一段時間（同進同出的開盤價）的 0050 與流動池等權比
- 組合模擬：最多同時 K 檔、每檔下單時投入當下淨值的 1/K；當天訊號多於空位時挑 20 日漲幅大的；
  沒用到的錢放 0050（0050 的進出不計成本，近似）
- 流動池：近 20 個交易日至少 10 天在上市＋上櫃成交值前 300 名的普通股
"""

from __future__ import annotations

import os
import sys
from collections import defaultdict

import numpy as np

from gooaye import SITE, Prices, common, dated_files, load

sys.stdout.reconfigure(encoding="utf-8")
DIRS = [d for d in (os.environ.get("GOOAYE_DATA"), SITE) if d]
SPLIT = "2024-07-01"
COST = 0.00585
MAXHOLD = 250
K = 10

P = Prices(DIRS)
dates, T = P.dates, P.N
val = defaultdict(dict)
for sub in ("daily/twse", "daily/tpex"):
    for d, p in dated_files(sub, DIRS).items():
        if d in P.di:
            for s in load(p)["stocks"]:
                if common(s["code"]):
                    val[s["code"]][P.di[d]] = s["value"]
codes = sorted(val)
N = len(codes)
ci = {c: k for k, c in enumerate(codes)}
V = np.zeros((T, N), np.float32)
for c, m in val.items():
    for i, v in m.items():
        V[i, ci[c]] = v
top = np.zeros((T, N), bool)
for i in range(T):
    nz = np.nonzero(V[i])[0]
    top[i, nz[np.argsort(-V[i, nz])[:300]]] = True
cs = np.cumsum(top, 0)
LIQ = (cs - np.vstack([np.zeros((20, N)), cs[:-20]])) >= 10

# 還原收盤、還原開盤（同一個因子尺度）
AC = np.full((T, N), np.nan)
AO = np.full((T, N), np.nan)
for c in codes:
    k, cu = ci[c], P.cum[c]
    for i, v in P.C[c].items():
        AC[i, k] = v / cu[i]
    for i, v in P.O[c].items():
        AO[i, k] = v / cu[i]
ACf = AC.copy()
AOf = AO.copy()                     # 停牌日沿用前一天，只拿來算市值
for i in range(1, T):
    m = np.isnan(ACf[i])
    ACf[i, m] = ACf[i - 1, m]
    m = np.isnan(AOf[i])
    AOf[i, m] = AOf[i - 1, m]


def sma(x, n):
    c = np.cumsum(np.nan_to_num(x), 0)
    out = np.full_like(x, np.nan)
    out[n - 1:] = (c[n - 1:] - np.vstack([np.zeros((1, x.shape[1])), c[:-n]])) / n
    return out


MA = {n: sma(ACf, n) for n in (5, 10, 20, 60, 120)}
ret20 = ACf / np.vstack([np.full((20, N), np.nan), ACf[:-20]]) - 1
hi60 = np.full((T, N), np.nan)
for i in range(59, T):
    hi60[i] = np.nanmax(ACf[i - 59:i + 1], 0)
r1 = ACf / np.vstack([np.full((1, N), np.nan), ACf[:-1]]) - 1
up, dn = np.clip(np.nan_to_num(r1), 0, None), np.clip(-np.nan_to_num(r1), 0, None)
au, ad = np.zeros_like(r1), np.zeros_like(r1)
for i in range(1, T):
    au[i] = au[i - 1] * 13 / 14 + up[i] / 14
    ad[i] = ad[i - 1] * 13 / 14 + dn[i] / 14
RSI = 100 - 100 / (1 + au / np.maximum(ad, 1e-12))
RSI[:30] = np.nan

# 外資連買、營收
fo = np.zeros((T, N))
for d, p in dated_files("insti/daily", DIRS).items():
    if d in P.di:
        for mk in load(p)["stocks"].values():
            for c, r in mk.items():
                if c in ci:
                    fo[P.di[d], ci[c]] = r[1]
fobuy = np.zeros((T, N), int)
for i in range(T):
    fobuy[i] = np.where(fo[i] > 0, (fobuy[i - 1] + 1) if i else 1, 0)


def nextm(m):
    y, mo = int(m[:4]), int(m[5:]) + 1
    return f"{y + (mo > 12)}-{(mo - 1) % 12 + 1:02d}"


rev = {m: load(p) for m, p in dated_files("value/rev", [SITE]).items()}
ms = sorted(rev)
YOY = np.full((T, N), np.nan)
REVHI = np.zeros((T, N), bool)
for j, m in enumerate(ms):
    if j < 12:
        continue
    s = f"{nextm(m)}-11"
    i0 = next((i for i, d in enumerate(dates) if d >= s), None)
    if i0 is None:
        continue
    nx = f"{nextm(ms[j + 1])}-11" if j + 1 < len(ms) else "9999"
    i1 = next((i for i, d in enumerate(dates) if d >= nx), T)
    for c, v in rev[m].items():
        if c not in ci:
            continue
        ys = [rev[ms[j - k]].get(c, [None, None])[1] for k in range(3)]
        if all(y is not None for y in ys):
            YOY[i0:i1, ci[c]] = sum(ys) / 3
        prev = [rev[ms[j - k]].get(c, [None])[0] for k in range(1, 13)]
        prev = [x for x in prev if x]
        if v[0] and len(prev) >= 10 and v[0] > max(prev):
            REVHI[i0:i1, ci[c]] = True
yoyq = np.full((T, N), False)
for i in range(T):
    m = LIQ[i] & np.isfinite(YOY[i])
    if m.sum() > 30:
        cut = np.quantile(YOY[i, m], 0.8)
        yoyq[i] = m & (YOY[i] >= cut)
r20q = np.zeros((T, N), bool)
for i in range(T):
    m = LIQ[i] & np.isfinite(ret20[i])
    if m.sum() > 30:
        r20q[i] = m & (ret20[i] >= np.quantile(ret20[i, m], 0.8))

prev = lambda x: np.vstack([np.zeros((1, N), bool), x[:-1]])
four = (ACf > MA[5]) & (MA[5] > MA[20]) & (MA[20] > MA[60]) & (MA[60] > MA[120])
ENTRY = {
    "創 60 日新高": ACf >= hi60,
    "剛變四線全上": four & ~prev(four),
    "RSI 剛升破 70": (RSI >= 70) & ~prev(RSI >= 70),
    "20 日漲幅前 20%": r20q,
    "四線全上且剛站上 10 日線": four & (ACf > MA[10]) & ~prev(ACf > MA[10]),
}
FILT = {
    "（不加）": np.ones((T, N), bool),
    "營收年增前 20%": yoyq,
    "營收創 12 月新高": REVHI,
    "外資連買 ≥ 5 天": fobuy >= 5,
    "營收創高＋外資連買": REVHI & (fobuy >= 5),
}

# 0050 與流動池等權的開盤指數
b0 = np.array([P.O["0050"].get(i, np.nan) / P.cum["0050"][i] for i in range(T)])
for i in range(1, T):
    if np.isnan(b0[i]):
        b0[i] = b0[i - 1]
with np.errstate(all="ignore"):
    oo = AO / np.vstack([np.full((1, N), np.nan), AO[:-1]]) - 1
    ewd = np.nanmean(np.where(LIQ & (np.abs(oo) < 0.5), oo, np.nan), 1)
ew = np.cumprod(1 + np.nan_to_num(ewd))
WARM = 130


def trades_for(sig, exit_n, fixed=None):
    out = []
    for k in range(N):
        i = WARM
        col = sig[:, k] & LIQ[:, k]
        while i < T - 2:
            if not col[i]:
                i += 1
                continue
            e = i + 1
            if np.isnan(AO[e, k]):
                i += 1
                continue
            x = None
            for t in range(e, min(T - 1, e + MAXHOLD)):
                if fixed:
                    if t - e + 1 >= fixed:
                        x = t + 1
                        break
                elif ACf[t, k] < MA[exit_n][t, k]:
                    x = t + 1
                    break
            if x is None:
                break                                   # 還沒出場（抱到資料結束），不算
            while x < T and np.isnan(AO[x, k]):
                x += 1
            if x >= T:
                break
            r = AO[x, k] / AO[e, k] - 1 - COST
            if -0.9 < r < 5:
                out.append((dates[i], r, x - e, b0[x] / b0[e] - 1, ew[x - 1] / ew[e - 1] - 1, e, x, k, ret20[i, k]))
            i = x
    return out


def tstats(tr, lo, hi):
    t = [x for x in tr if lo <= x[0] < hi]
    if len(t) < 20:
        return None
    r = np.array([x[1] for x in t])
    w, l = r[r > 0], r[r <= 0]
    return dict(n=len(t), win=(r > 0).mean() * 100, avg=r.mean() * 100, med=np.median(r) * 100,
                pay=(w.mean() / -l.mean()) if len(w) and len(l) else np.nan,
                hold=np.mean([x[2] for x in t]), ex0=np.mean([x[1] - x[3] for x in t]) * 100,
                exew=np.mean([x[1] - x[4] for x in t]) * 100)


def portfolio(tr, lo, hi):
    """最多 K 檔；訊號依 20 日漲幅排序；閒錢放 0050。回傳 總報酬、最大回落、0050 總報酬"""
    i0 = next(i for i, d in enumerate(dates) if d >= lo)
    i1 = next((i for i, d in enumerate(dates) if d >= hi), T - 1)
    byday = defaultdict(list)
    for x in tr:
        if i0 <= x[5] < i1:
            byday[x[5]].append(x)
    cash, pos, eq = 1.0, [], []
    for t in range(i0, i1):
        if t > i0:
            cash *= b0[t] / b0[t - 1]
        keep = []
        for p in pos:                                   # p = [買進淨值, 交易]
            if p[1][6] == t:
                cash += p[0] * (1 + p[1][1])
            else:
                keep.append(p)
        pos = keep
        mark = cash + sum(p[0] * AOf[t, p[1][7]] / AOf[p[1][5], p[1][7]] for p in pos)
        for x in sorted(byday.get(t, []), key=lambda x: -np.nan_to_num(x[8])):
            if len(pos) >= K:
                break
            amt = mark / K
            if cash >= amt:
                cash -= amt
                pos.append([amt, x])
        eq.append(cash + sum(p[0] * AOf[t, p[1][7]] / AOf[p[1][5], p[1][7]] for p in pos))
    eq = np.array(eq)
    dd = (eq / np.maximum.accumulate(eq) - 1).min()
    return eq[-1] - 1, dd, b0[i1 - 1] / b0[i0] - 1


if __name__ == "__main__":
    ranges = (("前段 2022-04～2024-06", dates[WARM], SPLIT), ("後段 2024-07～", SPLIT, "9999"))
    print(f"資料 {dates[0]} ~ {dates[-1]}，最多同時 {K} 檔，閒錢放 0050")
    for exit_n, fixed, title in ((10, None, "跌破 10 日線出場"), (5, None, "跌破 5 日線出場"),
                                 (20, None, "跌破 20 日線出場"), (0, 20, "固定抱 20 天（對照）")):
        print(f"\n======== {title} ========")
        for en, emask in ENTRY.items():
            for fn, fmask in FILT.items():
                tr = trades_for(emask & fmask, exit_n, fixed)
                cells = []
                for rn, lo, hi in ranges:
                    s = tstats(tr, lo, hi)
                    if not s:
                        cells.append(f"{rn}：筆數不足")
                        continue
                    tot, dd, b = portfolio(tr, lo, hi)
                    cells.append(f"{rn}：{s['n']:>4} 筆 勝率 {s['win']:4.1f}% 平均 {s['avg']:+5.2f}% 賺賠比 {s['pay']:4.2f} "
                                 f"抱 {s['hold']:4.1f} 天 每筆贏0050 {s['ex0']:+5.2f}% 贏等權 {s['exew']:+5.2f}% ｜ "
                                 f"組合 {tot*100:+6.1f}% 回落 {dd*100:5.1f}% vs 0050 {b*100:+6.1f}%")
                print(f"{en} ＋ {fn}\n    " + "\n    ".join(cells), flush=True)
