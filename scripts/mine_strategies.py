"""排列組合找策略：把現有資料變成約一百個「原子條件」，窮舉 1～3 個條件的交集，
在發現期挑出夠強的，再拿完全沒碰過的驗證期考一次。

    GOOAYE_DATA=<解壓後的長歷史 docs/data> python scripts/mine_strategies.py

只印表，不寫檔；結論整理在 BACKTEST.md。長歷史怎麼取得見 BACKTEST.md「長歷史放在哪裡」。

## 規則長什麼樣子

每天收盤後，同時符合所有條件的股票就是訊號。條件分兩種：
- 橫斷面：某個指標在當天流動池裡排前 20%（高）或後 20%（低）
- 絕對：RSI ≥ 70、營收創 12 個月新高、四線全上……這類本來就有門檻的

## 不偷看未來

- 每個指標只用當天收盤（含）以前看得到的資料；月營收 m 月要到 m+1 月 11 日才用，本益比 m 月底的
  要到 m+1 月第一天才用
- 進出場：訊號日隔天開盤進場，第 h 個交易日收盤出場；股價用 exright/ 還原除權息
- 流動池：近 20 個交易日至少 10 天在上市＋上櫃成交值前 300 名的普通股

## 為什麼要分兩段、還要洗牌

窮舉幾萬組，純粹靠運氣也會冒出 t 值很高的組合。所以：
1. **發現期**（2024-06 以前，含 2022 空頭）挑規則：t ≥ 3、20 日平均超額 ≥ 1%、發現期前後兩半都為正
2. **驗證期**（2024-07 以後）完全不參與挑選，只報告挑出來的規則在那裡還剩多少
3. **洗牌對照**：把「每一天的報酬」整天整天地打亂順序（保留同一天股票之間的相關），
   跑同一套挑選流程，看純雜訊會挑出幾組——這就是「挑出來的有幾成是假的」的基準
"""

from __future__ import annotations

import json
import math
import os
import random
import sys
from collections import defaultdict

import numpy as np

from gooaye import SITE, Prices, common, dated_files, load

sys.stdout.reconfigure(encoding="utf-8")
DIRS = [d for d in (os.environ.get("GOOAYE_DATA"), SITE) if d]
H = int(os.environ.get("MINE_H", "20"))
SPLIT = os.environ.get("MINE_SPLIT", "2024-07-01")
QT = 0.2                     # 橫斷面條件：前／後 20%
MIN_PICKS = 2                # 一天至少幾檔才算這天有訊號
COST = 0.00585

P = Prices(DIRS)
dates, T = P.dates, P.N
# ---------------- 矩陣：只留曾經進過流動池的股票 ----------------
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
top300 = np.zeros((T, N), bool)
for i in range(T):
    nz = np.nonzero(V[i])[0]
    if len(nz):
        top300[i, nz[np.argsort(-V[i, nz])[:300]]] = True
cnt20 = np.cumsum(top300, 0)
cnt20 = cnt20 - np.vstack([np.zeros((20, N)), cnt20[:-20]])
LIQ = cnt20 >= 10

AC = np.full((T, N), np.nan, np.float32)      # 還原收盤
for c in codes:
    a = P.adj(c)
    AC[:, ci[c]] = [x if x else np.nan for x in a]
FWD = np.full((T, N), np.nan, np.float32)     # i+1 開盤進、i+H 收盤出
for c in codes:
    k = ci[c]
    for i in range(T - H):
        r = P.ret(c, i, H)
        if r is not None:
            FWD[i, k] = r


def shift(x, n):
    out = np.full_like(x, np.nan)
    if n > 0:
        out[n:] = x[:-n]
    return out


def rmean(x, n):
    c = np.nancumsum(np.nan_to_num(x), 0)
    k = np.cumsum(np.isfinite(x), 0)
    s = c - np.vstack([np.zeros((n, x.shape[1])), c[:-n]])
    m = k - np.vstack([np.zeros((n, x.shape[1])), k[:-n]])
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(m >= n * 0.8, s / m, np.nan)


def rstd(x, n):
    m = rmean(x, n)
    m2 = rmean(x * x, n)
    return np.sqrt(np.maximum(m2 - m * m, 0))


def rmax(x, n):
    out = np.full_like(x, np.nan)
    for i in range(n - 1, len(x)):
        out[i] = np.nanmax(x[i - n + 1:i + 1], 0)
    return out


ACf = np.where(np.isfinite(AC), AC, np.nan)
ACff = ACf.copy()
for i in range(1, T):                                  # 停牌日用前一天
    m = np.isnan(ACff[i])
    ACff[i, m] = ACff[i - 1, m]
r1 = ACff / shift(ACff, 1) - 1
X = {}                                                 # 名稱 -> T×N
for n in (5, 20, 60, 120):
    X[f"漲幅{n}日"] = ACff / shift(ACff, n) - 1
for n in (5, 20, 60, 120):
    X[f"距MA{n}"] = ACff / rmean(ACff, n) - 1
X["距一年高點"] = ACff / rmax(ACff, 250) - 1
X["波動20日"] = rstd(r1, 20)
up = np.clip(r1, 0, None)
dn = np.clip(-r1, 0, None)
au, ad = np.zeros_like(r1), np.zeros_like(r1)          # RSI14（Wilder）
for i in range(1, T):
    u, d_ = np.nan_to_num(up[i]), np.nan_to_num(dn[i])
    au[i] = au[i - 1] * 13 / 14 + u / 14
    ad[i] = ad[i - 1] * 13 / 14 + d_ / 14
RSI = 100 - 100 / (1 + au / np.maximum(ad, 1e-9))
RSI[:30] = np.nan
X["RSI14"] = RSI
V20 = rmean(np.where(V > 0, V, np.nan), 20)
X["成交值20日"] = V20
X["量增(5日/60日)"] = rmean(np.where(V > 0, V, np.nan), 5) / rmean(np.where(V > 0, V, np.nan), 60)
X["今日量/20日均"] = np.where(V > 0, V, np.nan) / V20
# 法人
FL = {k: np.zeros((T, N), np.float32) for k in ("外資", "投信", "自營")}
for d, p in dated_files("insti/daily", DIRS).items():
    if d not in P.di:
        continue
    i = P.di[d]
    for mk in load(p)["stocks"].values():
        for c, r in mk.items():
            if c in ci and r[4]:
                FL["外資"][i, ci[c]] = r[1] * r[4]
                FL["投信"][i, ci[c]] = r[2] * r[4]
                FL["自營"][i, ci[c]] = r[3] * r[4]
for k, f in FL.items():
    for n in (5, 20):
        X[f"{k}{n}日買超/成交值"] = rmean(f, n) / V20
    pos = (f > 0).astype(np.float32) - (f < 0)
    X[f"{k}近10日買超天數"] = rmean(pos, 10) * 10
# 月頻：營收、本益比
rev = {}
for m, p in dated_files("value/rev", [SITE]).items():
    rev[m] = load(p)
pe = defaultdict(dict)
for mk in ("twse", "tpex"):
    for m, p in dated_files(f"value/pe/{mk}", [SITE]).items():
        for c, v in load(p)["c"].items():
            if len(v) >= 4:
                pe[m][c] = v


def nextm(m, k=1):
    y, mo = int(m[:4]), int(m[5:]) + k
    while mo > 12:
        y, mo = y + 1, mo - 12
    return f"{y}-{mo:02d}"


def monthly(tbl, day):
    """tbl: {月份: {代號: 值}} -> T×N，m 月的值從 m+1 月 day 日起生效、往後沿用"""
    out = np.full((T, N), np.nan, np.float32)
    starts = []
    for m in sorted(tbl):
        s = f"{nextm(m)}-{day:02d}"
        i0 = next((i for i, d in enumerate(dates) if d >= s), None)
        if i0 is not None:
            starts.append((i0, tbl[m]))
    for j, (i0, row) in enumerate(starts):
        i1 = starts[j + 1][0] if j + 1 < len(starts) else T
        vec = np.full(N, np.nan, np.float32)
        for c, v in row.items():
            if c in ci and v is not None:
                vec[ci[c]] = v
        out[i0:i1] = vec
    return out


ms = sorted(rev)
yoy = {m: {c: v[1] for c, v in rev[m].items()} for m in ms}
amt = {m: {c: v[0] for c, v in rev[m].items()} for m in ms}
yoy3, acc, newhi = {}, {}, {}
for j, m in enumerate(ms):
    if j < 12:
        continue
    y3 = {}
    for c in yoy[m]:
        xs = [yoy[ms[j - k]].get(c) for k in range(3)]
        if all(x is not None for x in xs):
            y3[c] = sum(xs) / 3
    yoy3[m] = y3
    if j >= 15:
        ac = {}
        for c, v in y3.items():
            xs = [yoy[ms[j - k]].get(c) for k in range(3, 6)]
            if all(x is not None for x in xs):
                ac[c] = v - sum(xs) / 3
        acc[m] = ac
    nh = {}
    for c, a in amt[m].items():
        prev = [amt[ms[j - k]].get(c) for k in range(1, 13)]
        prev = [x for x in prev if x]
        if a and len(prev) >= 10:
            nh[c] = float(a > max(prev))
    newhi[m] = nh
X["營收年增(近3月)"] = monthly(yoy3, 11)
X["營收年增加速"] = monthly(acc, 11)
REVHI = monthly(newhi, 11)
X["本益比倒數"] = monthly({m: {c: (1 / v[0] if v[0] and 0 < v[0] <= 150 else None) for c, v in pe[m].items()} for m in pe}, 1)
X["殖利率"] = monthly({m: {c: v[1] for c, v in pe[m].items()} for m in pe}, 1)
X["股淨比"] = monthly({m: {c: v[2] for c, v in pe[m].items()} for m in pe}, 1)
# 產業
ind = load(os.path.join(SITE, "industry.json"))["map"]
grp = np.array([ind.get(c, "NA") for c in codes])
x20 = X["漲幅20日"]
g20 = np.full_like(x20, np.nan)
for g in set(grp):
    k = grp == g
    with np.errstate(all="ignore"):
        g20[:, k] = np.nanmean(np.where(LIQ[:, k], x20[:, k], np.nan), 1, keepdims=True)
X["所屬產業20日漲幅"] = g20
X["相對產業20日"] = x20 - g20

# ---------------- 原子條件 ----------------
def xrank(x):
    """每天在流動池內的百分位（0～1），池外是 nan"""
    out = np.full_like(x, np.nan)
    for i in range(T):
        m = LIQ[i] & np.isfinite(x[i])
        if m.sum() >= 30:
            v = x[i, m]
            out[i, m] = v.argsort().argsort() / (len(v) - 1)
    return out


ATOM = {}
for k, x in X.items():
    rk = xrank(x)
    ATOM[f"{k} 高"] = rk >= 1 - QT
    ATOM[f"{k} 低"] = rk <= QT
ma = {n: rmean(ACff, n) for n in (5, 20, 60, 120)}
ATOM["RSI ≥ 70"] = RSI >= 70
ATOM["RSI ≤ 30"] = RSI <= 30
ATOM["RSI 50～70"] = (RSI >= 50) & (RSI < 70)
ATOM["營收創 12 個月新高"] = REVHI >= 1
ATOM["四線全上"] = (ACff > ma[5]) & (ma[5] > ma[20]) & (ma[20] > ma[60]) & (ma[60] > ma[120])
ATOM["四線全下"] = (ACff < ma[5]) & (ma[5] < ma[20]) & (ma[20] < ma[60]) & (ma[60] < ma[120])
ATOM["剛站上 MA20"] = (ACff > ma[20]) & (shift(ACff, 1) <= shift(ma[20], 1))
ATOM["剛跌破 MA20"] = (ACff < ma[20]) & (shift(ACff, 1) >= shift(ma[20], 1))
ATOM["創 60 日新高"] = ACff >= rmax(ACff, 60)
ATOM["外資連買 ≥ 5 天"] = X["外資近10日買超天數"] >= 5
ATOM["投信連買 ≥ 5 天"] = X["投信近10日買超天數"] >= 5
ATOM["今日爆量收紅"] = (X["今日量/20日均"] >= 2) & (r1 > 0)
names = list(ATOM)
AM = np.stack([ATOM[k] & LIQ for k in names])         # 原子數 × T × N
print(f"資料 {dates[0]} ~ {dates[-1]}（{T} 天），股票 {N} 檔，原子條件 {len(names)} 個，持有 {H} 日，"
      f"發現期 < {SPLIT} ≤ 驗證期", flush=True)

# ---------------- 報酬：減掉當天流動池等權平均 ----------------
ok = LIQ & np.isfinite(FWD)
with np.errstate(all="ignore"):
    bench = np.nanmean(np.where(ok, FWD, np.nan), 1)
EX = np.where(ok, FWD - bench[:, None], 0).astype(np.float32)
OKf = ok.astype(np.float32)
WARM = 260
disc = np.array([WARM <= i < T - H and dates[i] < SPLIT for i in range(T)])
test = np.array([dates[i] >= SPLIT and i < T - H for i in range(T)])
dlist = np.nonzero(disc)[0]
half = dlist[len(dlist) // 2]


def nw_t(x, lag):
    n = len(x)
    if n < 20:
        return 0.0
    m = x.mean()
    e = x - m
    var = (e * e).mean()
    for l in range(1, min(lag, n - 1) + 1):
        var += 2 * (1 - l / (lag + 1)) * (e[l:] * e[:-l]).mean()
    return m / math.sqrt(var / n) if var > 0 else 0.0


def daily(mask, ex):
    """mask: T×N bool -> 每天的平均超額（訊號不足的日子 nan）"""
    m = mask & ok
    k = m.sum(1)
    s = (ex * m).sum(1)
    return np.where(k >= MIN_PICKS, s / np.maximum(k, 1), np.nan), k


def score(dv, sel):
    x = dv[sel]
    x = x[np.isfinite(x)]
    if len(x) < 100:
        return None
    return x.mean(), nw_t(x, H - 1), len(x)


def mine(ex, label):
    """窮舉 1、2 個條件，再對前 300 名的兩條件各加一個（beam）。回傳通過發現期門檻的規則。"""
    res = {}
    def ev(key, mask):
        dv, k = daily(mask, ex)
        s = score(dv, disc)
        if not s:
            return
        a = score(dv, disc & (np.arange(T) < half))
        b = score(dv, disc & (np.arange(T) >= half))
        res[key] = (s, a, b, dv, k)
    for j in range(len(names)):
        ev((j,), AM[j])
    pairs = []
    for j in range(len(names)):
        for k in range(j + 1, len(names)):
            if names[j].rsplit(" ", 1)[0] == names[k].rsplit(" ", 1)[0]:
                continue
            m = AM[j] & AM[k]
            if m[disc].sum() < 300:
                continue
            ev((j, k), m)
            if (j, k) in res:
                pairs.append(((j, k), res[(j, k)][0][1]))
    pairs.sort(key=lambda x: -x[1])
    for (j, k), _ in pairs[:300]:
        m2 = AM[j] & AM[k]
        for l in range(len(names)):
            if l in (j, k):
                continue
            key = tuple(sorted((j, k, l)))
            if key in res:
                continue
            m = m2 & AM[l]
            if m[disc].sum() < 300:
                continue
            ev(key, m)
    passed = {key: v for key, v in res.items()
              if v[0][1] >= 3 and v[0][0] >= 0.01 and v[1] and v[2] and v[1][0] > 0 and v[2][0] > 0}
    print(f"[{label}] 試了 {len(res)} 組，發現期通過 {len(passed)} 組", flush=True)
    return res, passed


real, passed = mine(EX, "真實")
# 對調對照：把股票的報酬整條隨機對調（A 股的條件配 B 股的報酬，整段期間固定同一組對調）。
# 每條報酬序列的時間結構、同一天的橫斷面分布都保留，只打斷「這檔的條件」與「這檔的報酬」的關係
null_pass = []
for seed in (1, 2, 3):
    pm = np.random.RandomState(seed).permutation(N)
    EXs, ok_backup = EX[:, pm], ok
    ok = ok_backup[:, pm]
    _, ps = mine(EXs, f"對調 {seed}")
    null_pass.append(len(ps))
    ok = ok_backup
passed_s = [0] * int(round(np.mean(null_pass)))
lab = lambda key: " ＋ ".join(names[j] for j in key)
rows = []
for key, (s, a, b, dv, k) in passed.items():
    t_ = score(dv, test)
    rows.append((key, s, a, b, t_, np.nanmean(k[disc])))
rows.sort(key=lambda r: -r[1][1])
surv = [r for r in rows if r[4] and r[4][0] > 0]
print(f"\n通過發現期的 {len(rows)} 組裡，驗證期仍為正的 {len(surv)} 組；"
      f"驗證期 t ≥ 2 的 {sum(1 for r in rows if r[4] and r[4][1] >= 2)} 組。"
      f"對調對照在發現期平均通過 {len(passed_s)} 組（{null_pass}，純雜訊的基準）")
print(f"\n{'規則':<60} 發現期超額(t) [前半/後半]  平均檔數 | 驗證期超額(t) 天數")
for key, s, a, b, t_, kk in rows[:40]:
    tt = f"{t_[0]*100:+5.2f}%({t_[1]:+4.1f}) {t_[2]:>4}" if t_ else "—"
    print(f"{lab(key):<60} {s[0]*100:+5.2f}%({s[1]:+4.1f}) [{a[0]*100:+.1f}/{b[0]*100:+.1f}] {kk:5.1f} | {tt}")
print("\n驗證期表現最好的 15 組（從通過發現期的裡面挑）：")
for key, s, a, b, t_, kk in sorted([r for r in rows if r[4]], key=lambda r: -r[4][1])[:15]:
    print(f"{lab(key):<60} 發現 {s[0]*100:+5.2f}%({s[1]:+4.1f}) | 驗證 {t_[0]*100:+5.2f}%({t_[1]:+4.1f}) {t_[2]} 天")

# ---------------- 把驗證期最穩的幾組變成實際的交易 ----------------
A0050 = np.array([x if x else np.nan for x in P.adj("0050")], np.float32)
for i in range(1, T):
    if np.isnan(A0050[i]):
        A0050[i] = A0050[i - 1]
O0050 = {i: P.O["0050"].get(i) for i in range(T)}


def simulate(mask, start, end):
    """每天把 1/H 的資金投入當天的訊號股（等權），持有 H 日；沒訊號的那份放 0050。
    回傳每筆（檔次）報酬、組合淨值、同期 0050 淨值。"""
    trades, cohort = [], []
    for i in range(start, min(end, T - H)):
        picks = np.nonzero(mask[i] & ok[i])[0]
        r0050 = P.ret("0050", i, H)
        if len(picks) >= MIN_PICKS:
            rs = FWD[i, picks] - COST
            trades += list(rs)
            cohort.append((float(np.mean(rs)), r0050 or 0.0, float(bench[i])))
        else:
            cohort.append(((r0050 or 0.0) - 0.0, r0050 or 0.0, float(bench[i])))
    c = np.array(cohort)
    # H 份資金輪流進出：總報酬 ≈ 各份資金的平均複利
    lanes = [np.prod(1 + c[j::H, 0]) for j in range(H)]
    lanes_b = [np.prod(1 + c[j::H, 1]) for j in range(H)]
    lanes_e = [np.prod(1 + c[j::H, 2]) for j in range(H)]
    tr = np.array(trades)
    return (np.mean(lanes) - 1, np.mean(lanes_b) - 1, np.mean(lanes_e) - 1,
            (tr > 0).mean() if len(tr) else float("nan"), len(tr), (c[:, 0] > c[:, 1]).mean())


i_test = int(np.argmax(test))
print(f"\n照規則實際交易（驗證期 {dates[i_test]} 起；每天 1/{H} 資金買當天訊號股、持有 {H} 日、扣來回成本；"
      f"沒訊號的那份放 0050）")
for title, pick in (("發現期 t 值前 10 名（事前就挑得出來）", rows[:10]),):
    print(f"\n【{title}】")
    for key, *_ in pick:
        m = np.ones((T, N), bool)
        for j in key:
            m &= AM[j]
        tot, b_, e_, win, n_, beat = simulate(m, i_test, T)
        tot0, b0, e0, win0, n0, _ = simulate(m, WARM, i_test)
        print(f"{lab(key):<58} 驗證期 {tot*100:+6.1f}% vs 0050 {b_*100:+6.1f}% 等權池 {e_*100:+6.1f}% 每筆勝率 {win*100:4.1f}%（{n_} 筆）"
              f" ｜ 發現期 {tot0*100:+6.1f}% vs 0050 {b0*100:+6.1f}% 勝率 {win0*100:4.1f}%")
