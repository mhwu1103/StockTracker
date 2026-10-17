"""妖股研究：起漲前一天長什麼樣子？抓到之後怎麼抱？

    GOOAYE_DATA=<解壓後的長歷史 docs/data> python scripts/study_monster.py

只印表，不寫檔；結論整理在 BACKTEST.md。

- 妖股起點：t 日收盤後看得到的條件；隔天開盤買進後，60 個交易日內最高收盤 ≥ 買價 × 2
- 大波段：同上，≥ 1.5 倍
- 範圍：所有普通股、收盤 ≥ 10 元（排除雞蛋水餃股）
- 提升倍數：條件成立的日子裡妖股起點的比例 ÷ 全體的比例
- 前段（< 2024-07）挑條件，後段驗證；股價用 exright/ 還原除權息
"""

from __future__ import annotations

import os
import sys
from collections import defaultdict
from itertools import combinations

import numpy as np

from gooaye import SITE, Prices, common, dated_files, load

sys.stdout.reconfigure(encoding="utf-8")
DIRS = [d for d in (os.environ.get("GOOAYE_DATA"), SITE) if d]
SPLIT = "2024-07-01"
W = 60
COST = 0.00585

P = Prices(DIRS)
dates, T = P.dates, P.N
codes = sorted(c for c in P.C if common(c))
N = len(codes)
ci = {c: k for k, c in enumerate(codes)}
RAW = np.full((T, N), np.nan)
AC = np.full((T, N), np.nan)
AO = np.full((T, N), np.nan)
for c in codes:
    k, cu = ci[c], P.cum[c]
    for i, v in P.C[c].items():
        RAW[i, k] = v
        AC[i, k] = v / cu[i]
    for i, v in P.O[c].items():
        AO[i, k] = v / cu[i]
ACf, AOf = AC.copy(), AO.copy()
for i in range(1, T):
    for x in (ACf, AOf):
        m = np.isnan(x[i])
        x[i, m] = x[i - 1, m]


def lag(x, n):
    out = np.full_like(x, np.nan)
    out[n:] = x[:-n]
    return out


def sma(x, n):
    c = np.cumsum(np.nan_to_num(x), 0)
    out = np.full_like(x, np.nan)
    out[n - 1:] = (c[n - 1:] - np.vstack([np.zeros((1, x.shape[1])), c[:-n]])) / n
    return out


def rmax(x, n):
    out = np.full_like(x, np.nan)
    for i in range(n - 1, len(x)):
        out[i] = np.nanmax(x[i - n + 1:i + 1], 0)
    return out


# 未來 60 日最高收盤 ÷ 隔天開盤
fmax = np.full((T, N), np.nan)
for i in range(T - W - 1):
    fmax[i] = np.nanmax(ACf[i + 1:i + 1 + W], 0) / AOf[i + 1] - 1
alive = np.isfinite(AC) & (RAW >= 10) & np.isfinite(fmax)
alive[:130] = False
MON = fmax >= 1.0
BIG = fmax >= 0.5

r1 = ACf / lag(ACf, 1) - 1
MA = {n: sma(ACf, n) for n in (5, 10, 20, 60, 120)}
up, dn = np.clip(np.nan_to_num(r1), 0, None), np.clip(-np.nan_to_num(r1), 0, None)
au, ad = np.zeros_like(r1), np.zeros_like(r1)
for i in range(1, T):
    au[i] = au[i - 1] * 13 / 14 + up[i] / 14
    ad[i] = ad[i - 1] * 13 / 14 + dn[i] / 14
RSI = 100 - 100 / (1 + au / np.maximum(ad, 1e-12))
# 成交值排行（只有前 300 名有值）
top = np.zeros((T, N), bool)
val = np.zeros((T, N))
for sub in ("daily/twse", "daily/tpex"):
    for d, p in dated_files(sub, DIRS).items():
        if d in P.di:
            for s in load(p)["stocks"]:
                if s["code"] in ci:
                    val[P.di[d], ci[s["code"]]] = s["value"]
for i in range(T):
    nz = np.nonzero(val[i])[0]
    top[i, nz[np.argsort(-val[i, nz])[:300]]] = True
ctop = np.cumsum(top, 0)
top20 = ctop - np.vstack([np.zeros((20, N)), ctop[:-20]])
top60 = ctop - np.vstack([np.zeros((60, N)), ctop[:-60]])
# 法人
FO, TR = np.zeros((T, N)), np.zeros((T, N))
for d, p in dated_files("insti/daily", DIRS).items():
    if d in P.di:
        for mk in load(p)["stocks"].values():
            for c, r in mk.items():
                if c in ci:
                    FO[P.di[d], ci[c]], TR[P.di[d], ci[c]] = r[1], r[2]


def streak(x):
    out = np.zeros((T, N), int)
    for i in range(T):
        out[i] = np.where(x[i] > 0, (out[i - 1] + 1) if i else 1, 0)
    return out


fos, trs = streak(FO), streak(TR)
# 營收
def nextm(m):
    y, mo = int(m[:4]), int(m[5:]) + 1
    return f"{y + (mo > 12)}-{(mo - 1) % 12 + 1:02d}"


rev = {m: load(p) for m, p in dated_files("value/rev", [SITE]).items()}
ms = sorted(rev)
YOY = np.full((T, N), np.nan)
REVHI = np.zeros((T, N), bool)
YOYUP = np.zeros((T, N), bool)
for j, m in enumerate(ms):
    if j < 12:
        continue
    i0 = next((i for i, d in enumerate(dates) if d >= f"{nextm(m)}-11"), None)
    if i0 is None:
        continue
    i1 = next((i for i, d in enumerate(dates) if d >= f"{nextm(ms[j + 1])}-11"), T) if j + 1 < len(ms) else T
    for c, v in rev[m].items():
        if c not in ci:
            continue
        k = ci[c]
        y = v[1]
        if y is not None:
            YOY[i0:i1, k] = y
            yp = rev[ms[j - 1]].get(c, [None, None])[1]
            if yp is not None and y > yp + 20:
                YOYUP[i0:i1, k] = True
        prev = [rev[ms[j - q]].get(c, [None])[0] for q in range(1, 13)]
        prev = [x for x in prev if x]
        if v[0] and len(prev) >= 10 and v[0] > max(prev):
            REVHI[i0:i1, k] = True

hi250 = rmax(ACf, 250)
hi60 = rmax(ACf, 60)
lo250 = -rmax(-ACf, 250)
ret20 = ACf / lag(ACf, 20) - 1
ret60 = ACf / lag(ACf, 60) - 1
limit = r1 >= 0.095
lim5 = sma(limit.astype(float), 5) * 5
four = (ACf > MA[5]) & (MA[5] > MA[20]) & (MA[20] > MA[60]) & (MA[60] > MA[120])
rng = (rmax(ACf, 60) / -rmax(-ACf, 60) - 1)            # 60 日高低區間寬度
COND = {
    "今天漲停": limit,
    "近 5 日漲停 ≥ 2 次": lim5 >= 2,
    "創 60 日新高": ACf >= hi60,
    "創一年新高": ACf >= hi250,
    "距一年低點 < 30%": ACf / lo250 - 1 < 0.3,
    "20 日漲幅 ≥ 30%": ret20 >= 0.3,
    "20 日漲幅 < 10%": ret20 < 0.1,
    "60 日漲幅 ≥ 50%": ret60 >= 0.5,
    "四線全上": four,
    "剛站上 120 日線": (ACf > MA[120]) & (lag(ACf, 1) <= lag(MA[120], 1)),
    "60 日區間 < 25%（整理）": rng < 0.25,
    "RSI ≥ 70": RSI >= 70,
    "RSI 剛升破 70": (RSI >= 70) & (lag(RSI, 1) < 70),
    "今天進成交值前 300": top,
    "剛擠進前 300（前 60 日 ≤ 3 天）": top & (lag(top60.astype(float), 1) <= 3),
    "不在前 300（冷門）": ~top,
    "外資連買 ≥ 3 天": fos >= 3,
    "投信連買 ≥ 3 天": trs >= 3,
    "投信今天買超": TR > 0,
    "營收創 12 月新高": REVHI,
    "營收年增 ≥ 50%": YOY >= 50,
    "營收年增比上月跳升 > 20 點": YOYUP,
    "股價 < 50 元": RAW < 50,
    "股價 ≥ 200 元": RAW >= 200,
}
names = list(COND)
disc = np.array([d < SPLIT for d in dates])[:, None] & alive
test = np.array([d >= SPLIT for d in dates])[:, None] & alive
base = {k: (MON[m].mean(), BIG[m].mean()) for k, m in (("前段", disc), ("後段", test))}
print(f"資料 {dates[0]} ~ {dates[-1]}，普通股 {N} 檔（收盤 ≥ 10 元）")
print(f"基準：60 日內翻倍的機率 前段 {base['前段'][0]*100:.2f}%／後段 {base['後段'][0]*100:.2f}%；"
      f"漲 50% 前段 {base['前段'][1]*100:.2f}%／後段 {base['後段'][1]*100:.2f}%")


def lift(mask):
    out = []
    for per, sel in (("前段", disc), ("後段", test)):
        m = mask & sel
        n = m.sum()
        out.append((n, MON[m].mean() if n else np.nan, BIG[m].mean() if n else np.nan))
    return out


def show(title, items):
    print(f"\n{title}")
    print(f"{'條件':<44} 前段：樣本 翻倍率(倍數) 漲50%率 | 後段：樣本 翻倍率(倍數) 漲50%率")
    for name, (a, b) in items:
        print(f"{name:<44} {a[0]:>7} {a[1]*100:5.2f}%({a[1]/base['前段'][0]:4.1f}x) {a[2]*100:5.1f}% | "
              f"{b[0]:>7} {b[1]*100:5.2f}%({b[1]/base['後段'][0]:4.1f}x) {b[2]*100:5.1f}%")


single = [(k, lift(COND[k])) for k in names]
show("單一條件（依前段倍數排序）", sorted(single, key=lambda x: -x[1][0][1]))
pairs = []
for a, b in combinations(names, 2):
    m = COND[a] & COND[b]
    L = lift(m)
    if L[0][0] >= 300 and L[1][0] >= 100:
        pairs.append((f"{a} ＋ {b}", L, m))
pairs.sort(key=lambda x: -x[1][0][1])
show("兩個條件（前段樣本 ≥ 300，依前段翻倍率排序，前 25）", [(n, L) for n, L, _ in pairs[:25]])

# 抓到之後怎麼抱：用前段排名前 5 的組合，在後段實際交易
MA20 = MA[20]


def trade(mask, lo, hi, rule):
    rs, holds = [], []
    for k in range(N):
        i = 130
        col = mask[:, k]
        while i < T - 2:
            if not (col[i] and lo <= dates[i] < hi and RAW[i, k] >= 10):
                i += 1
                continue
            e = i + 1
            if np.isnan(AO[e, k]):
                i += 1
                continue
            peak, x = ACf[e, k], None
            for t in range(e, min(T - 1, e + 250)):
                peak = max(peak, ACf[t, k])
                if rule == "抱 20 天" and t - e + 1 >= 20:
                    x = t + 1
                elif rule == "抱 60 天" and t - e + 1 >= 60:
                    x = t + 1
                elif rule == "跌破 20 日線" and ACf[t, k] < MA20[t, k]:
                    x = t + 1
                elif rule == "從高點回落 20%" and ACf[t, k] < peak * 0.8:
                    x = t + 1
                if x:
                    break
            if x is None or x >= T:
                break
            r = AOf[x, k] / AOf[e, k] - 1 - COST
            rs.append(r)
            holds.append(x - e)
            i = x
    r = np.array(rs)
    if len(r) < 10:
        return None
    return len(r), (r > 0).mean() * 100, r.mean() * 100, np.median(r) * 100, (r >= 1).mean() * 100, np.mean(holds), np.percentile(r, 90) * 100


print("\n抓到之後怎麼抱（每筆：勝率、平均、中位數、抱到翻倍的比例、平均抱幾天、前 10% 那筆的報酬）")
for name, L, m in pairs[:5] + [(n, lift(COND[n]), COND[n]) for n in ("創一年新高", "近 5 日漲停 ≥ 2 次")]:
    print(f"\n{name}")
    for per, lo, hi in (("前段", dates[130], SPLIT), ("後段", SPLIT, "9999")):
        for rule in ("抱 20 天", "抱 60 天", "跌破 20 日線", "從高點回落 20%"):
            s = trade(m, lo, hi, rule)
            if s:
                print(f"  {per} {rule:<8} {s[0]:>5} 筆 勝率 {s[1]:4.1f}% 平均 {s[2]:+6.2f}% 中位 {s[3]:+6.2f}% "
                      f"翻倍 {s[4]:4.1f}% 抱 {s[5]:5.1f} 天 前10% {s[6]:+6.1f}%")
