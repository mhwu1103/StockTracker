"""低位階放量：股價還在相對低檔、剛站上 20 日線、帶量收在高點附近——之後會漲嗎？

    GOOAYE_DATA=<解壓後的長歷史 docs/data> python scripts/backtest_lowbase.py

只印表，不寫檔；結論在 BACKTEST.md「低位階放量」。

## 條件（t 日收盤後）

- **低位階**：還原收盤在近 120 個交易日高低區間的下面 35%
- **剛站上**：今天收在 20 日線之上、昨天在線下（或線上），而且離 20 日線不到 6%（還沒噴遠）
- **K 棒**：漲 3% 以上，收在當天高低區間的上面 30% 以內
- **放量**：今天進成交值前 300，而且成交值是前 20 日平均的 2 倍以上。前 300 以外的日子沒有成交值，
  用那一天第 300 名的成交值代替（是上限），所以算出來的倍數只會偏低——寧可少算，不可多算

## 跟誰比

t+1 開盤進、t+h 收盤出（還原）。同一天的全市場普通股中位數之外，另有兩組對照，用來拆開每個條件的功勞：

- **不放量**：低位階＋剛站上＋K 棒都符合，但沒有放量
- **高位階**：剛站上＋K 棒＋放量都符合，但不在低位階（區間的上面 35%）

t 值以日為單位（同一天的訊號取平均），持有期重疊沒有修正。
"""

from __future__ import annotations

import sys
from collections import defaultdict

import numpy as np

import strategy as S
from gooaye import dated_files, load

sys.stdout.reconfigure(encoding="utf-8")
HS = (1, 5, 10, 20)
POS_N, POS_LO, POS_HI = 120, 0.35, 0.65
MA_N, MA_GAP = 20, 0.06
UP, CLV = 0.03, 0.7
VOL_N, VOL_X = 20, 2.0
SPLIT = "2024-07-01"

D = S.Data(S.stock_dirs())
dates, T, N = D.dates, D.T, D.N
dirs = S.stock_dirs()

# 當天的高低（原始價，只拿來算收盤落在高低區間的哪裡）
H, L = np.full((T, N), np.nan), np.full((T, N), np.nan)
for sub in ("close/twse", "close/tpex"):
    for d, p in dated_files(sub, dirs).items():
        i = D.di.get(d)
        if i is None:
            continue
        x = load(p)
        for key, M in (("h", H), ("l", L)):
            for code, v in (x.get(key) or {}).items():
                k = D.ci.get(code)
                if k is not None and v:
                    M[i, k] = v

# 成交值：前 300 名有值；其他的用那天第 300 名的值當上限
V = np.full((T, N), np.nan)
floor = np.full(T, np.nan)
for sub in ("daily/twse", "daily/tpex"):
    for d, p in dated_files(sub, dirs).items():
        i = D.di.get(d)
        if i is None:
            continue
        for s in load(p)["stocks"]:
            k = D.ci.get(s["code"])
            if k is not None:
                V[i, k] = s["value"]
for i in range(T):
    v = V[i][np.isfinite(V[i])]
    if len(v) >= 300:
        floor[i] = np.sort(v)[-300]
Vf = np.where(np.isfinite(V), V, floor[:, None])

C = D.ACf
RC = D.RC
ok_today = np.isfinite(D.AC)

hi = np.full((T, N), np.nan)
lo = np.full((T, N), np.nan)
ma = np.full((T, N), np.nan)
vavg = np.full((T, N), np.nan)
for i in range(POS_N - 1, T):
    hi[i] = np.nanmax(C[i - POS_N + 1:i + 1], 0)
    lo[i] = np.nanmin(C[i - POS_N + 1:i + 1], 0)
for i in range(MA_N - 1, T):
    ma[i] = np.nanmean(C[i - MA_N + 1:i + 1], 0)
for i in range(VOL_N, T):
    vavg[i] = np.nanmean(Vf[i - VOL_N:i], 0)

with np.errstate(invalid="ignore", divide="ignore"):
    pos = (C - lo) / (hi - lo)
    gap = C / ma - 1
    prev_below = np.zeros((T, N), bool)
    prev_below[1:] = C[:-1] <= ma[:-1]
    up = np.full((T, N), np.nan)
    up[1:] = C[1:] / C[:-1] - 1
    clv = (RC - L) / (H - L)
    vx = V / vavg

LOW = ok_today & (pos <= POS_LO)
HIGH = ok_today & (pos >= POS_HI)
CROSS = ok_today & (gap > 0) & (gap <= MA_GAP) & prev_below
BAR = ok_today & (up >= UP) & (clv >= CLV)
BURST = np.isfinite(V) & (vx >= VOL_X)
NOBURST = ~BURST

R = {}
for h in HS:
    r = np.full((T, N), np.nan)
    r[:T - h] = D.AC[h:] / D.AO[1:T - h + 1] - 1
    r[(r < -0.7) | (r > 3)] = np.nan
    r[:-1][D.LIMIT_OPEN[1:]] = np.nan          # 隔天開盤就漲停：買不到
    R[h] = r
MED = {h: np.nanmedian(R[h], 1) for h in HS}


def stats(sig, h, lo_d="0000", hi_d="9999"):
    rows = defaultdict(list)
    raw = []
    for i in range(POS_N, T - h):
        if not (lo_d <= dates[i] < hi_d):
            continue
        ks = np.nonzero(sig[i])[0]
        for k in ks:
            x = R[h][i, k]
            if np.isfinite(x):
                raw.append(x)
                rows[i].append(x - MED[h][i])
    if not raw:
        return None
    ex = np.concatenate([np.array(v) for v in rows.values()])
    daily = np.array([np.mean(v) for v in rows.values()])
    t = daily.mean() / (daily.std(ddof=1) / np.sqrt(len(daily))) if len(daily) > 2 else np.nan
    raw = np.array(raw)
    return {"n": len(raw), "days": len(daily), "avg": raw.mean() * 100, "med": np.median(raw) * 100,
            "win": (raw > 0).mean() * 100, "ex": ex.mean() * 100, "exmed": np.median(ex) * 100,
            "beat": (ex > 0).mean() * 100, "t": t}


SIGS = [
    ("低位階放量（全部條件）", LOW & CROSS & BAR & BURST),
    ("對照：不放量", LOW & CROSS & BAR & NOBURST),
    ("對照：高位階放量", HIGH & CROSS & BAR & BURST),
    ("只有剛站上＋K 棒", CROSS & BAR),
]
print(f"{dates[POS_N]} ～ {dates[-1]}；報酬減同一天全市場中位數\n")
for name, sig in SIGS:
    print(f"## {name}")
    print(f"{'h':>3} {'筆':>6} {'天':>5} {'平均':>7} {'中位':>7} {'上漲':>5} │ {'超額':>7} {'中位':>7} {'贏':>5} {'t':>6}")
    for h in HS:
        s = stats(sig, h)
        if s:
            print(f"{h:>3} {s['n']:>6} {s['days']:>5} {s['avg']:>+7.2f} {s['med']:>+7.2f} {s['win']:>4.0f}% │ "
                  f"{s['ex']:>+7.2f} {s['exmed']:>+7.2f} {s['beat']:>4.0f}% {s['t']:>+6.2f}")
    print()

segs = [("2021-10～2022", "0000", "2023"), ("2023", "2023", "2024"), ("2024", "2024", "2025"),
        ("2025", "2025", "2026"), ("2026", "2026", "9999"), (f"前段 <{SPLIT}", "0000", SPLIT), (f"後段 ≥{SPLIT}", SPLIT, "9999")]
for name, sig in SIGS[:3]:
    for h in (5, 20):
        print(f"### {name}，{h} 日，分段")
        for lab, a, b in segs:
            s = stats(sig, h, a, b)
            if s:
                print(f"  {lab:<16} {s['n']:>5} 筆　平均 {s['avg']:>+6.2f}%（中位 {s['med']:>+6.2f}%，上漲 {s['win']:>3.0f}%）　"
                      f"超額 {s['ex']:>+6.2f}%（中位 {s['exmed']:>+6.2f}%，贏 {s['beat']:>3.0f}%，t {s['t']:>+5.2f}）")
        print()
