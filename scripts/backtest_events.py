"""公司公告事件：財報、自結損益、法說會前後，股價有沒有規律？

    GOOAYE_DATA=<解壓後的長歷史 docs/data> python scripts/backtest_events.py

只印表，不寫檔；結論在 BACKTEST.md「財報、自結與法說會」。事件來自 events/（fetch_events.py）。

## 進場時點

公告有時間戳。進場是「公告之後的第一個開盤」：盤前（09:00 以前）公告當天開盤進，盤中或盤後公告隔個交易日開盤進，
假日公告下一個交易日開盤進。**反應**＝進場開盤 ÷ 公告前最後一個收盤 − 1，就是市場對這則公告的第一個表態。
開盤就漲停的不算（買不到）。股價是還原除權息的。

## 跟誰比

- 減大盤：同一天全市場普通股（同一個進場日、同樣抱法）的平均
- 減對照：同一天、近 60 日漲幅同一個十分位的股票——平均減平均、中位數與「贏」是跟對照組的中位數比。
  個股報酬右偏，平均減中位數一定是正的（全部法說會會變成 +1.5%、t 9），不能混著減。財報季大家都在公布，排除不了「也有公告的」，
  所以這個對照只扣掉動能，不扣掉財報季
- t 值以進場日為單位（同一天的事件高度相關）

## 事件

- 財報（fin）：「財務報告或年度自結財務資訊」制式表。去重、單季淨利年增、進場時點、好／壞訊號的定義
  都在 events.py，頁面（build_events.py）用同一套
- 自結（self）：主旨有「自結」、不是制式表的（金融股每月自結盈餘居多）。沒有方向，只看反應之後會不會延續
- 法說會：一覽表的召開日（`conf_<年>.json`）。召開多在下午，之後的第一個開盤進場；
  會前那一段要市場先知道有法說會——用重大訊息裡的法說會公告日（召開前 60 天內最早的一則），
  公告隔天開盤進、召開日收盤出
"""

from __future__ import annotations

import bisect
import sys
from collections import defaultdict

import numpy as np

import events as E
import strategy as S
from gooaye import SITE

sys.stdout.reconfigure(encoding="utf-8")
HS = (1, 5, 20, 60)
LOOK = 60
SPLIT = "2024-07-01"

D = S.Data(S.stock_dirs())
dates, T, N = D.dates, D.T, D.N
AO, AC = D.AO, D.AC
di = D.di

# R[h][i]：第 i 天收盤後決定、i+1 開盤進、i+h 收盤出
R = {}
for h in HS:
    r = np.full((T, N), np.nan)
    r[:T - h] = AC[h:] / AO[1:T - h + 1] - 1
    r[(r < -0.7) | (r > 3)] = np.nan
    R[h] = r
MKT = {h: np.nanmean(R[h], 1) for h in HS}
up = np.full((T, N), np.nan)
up[LOOK:] = D.ACf[LOOK:] / D.ACf[:-LOOK] - 1
up[~np.isfinite(AC)] = np.nan
dec = np.full((T, N), -1)
for i in range(T):
    u = up[i]
    ok = np.isfinite(u)
    if ok.sum() > 100:
        q = np.nanquantile(u[ok], np.linspace(0, 1, 11)[1:-1])
        dec[i, ok] = np.searchsorted(q, u[ok])
CTL, CTLMED = {}, {}


def decile_ctl(r):
    """每一天、每一個十分位的平均與中位數"""
    mean, med = np.full((T, 10), np.nan), np.full((T, 10), np.nan)
    for i in range(T):
        for k in range(10):
            x = r[i][dec[i] == k]
            x = x[np.isfinite(x)]
            if len(x) >= 10:
                mean[i, k], med[i, k] = x.mean(), np.median(x)
    return mean, med


for h in HS:
    CTL[h], CTLMED[h] = decile_ctl(R[h])


def make(code, d, tm, **kw):
    c = D.ci.get(code)
    e = E.entry(dates, d, tm)
    if c is None or e[1] < 0:
        return None
    s, k = e
    if s + 1 >= T or not np.isfinite(AO[s + 1, c]) or not np.isfinite(D.ACf[k, c]):
        return None
    return {"d": dates[s + 1], "s": s, "c": c, "code": code, "react": AO[s + 1, c] / D.ACf[k, c] - 1, **kw}


rows = E.load_news(SITE)

# ---- 財報：同一家同一期只留第一則；單季淨利跟去年同季比
first = E.first_fin(rows)
QN = E.quarterly(first)
FIN = []
for (code, p0, p1), (d, tm, x) in first.items():
    if p0[5:] != "01-01" or p1[5:7] not in ("03", "06", "09", "12"):
        continue
    e = make(code, d, tm, g=E.growth(QN, code, p1), q=p1[5:7])
    if e:
        FIN.append(e)

SELF = []
seen = set()
for d, tm, code, kind, subj, x in rows:
    if kind == "self" and (code, d) not in seen:
        seen.add((code, d))
        e = make(code, d, tm)
        if e:
            SELF.append(e)

ATTN = []
seen = set()
for d, tm, code, kind, subj, x in rows:
    if kind == "attn" and (code, d) not in seen:
        seen.add((code, d))
        e = make(code, d, tm)
        if e:
            ATTN.append(e)

# ---- 法說會：一覽表的召開日；公告日用重大訊息
ann = defaultdict(list)
for d, tm, code, kind, subj, x in rows:
    if kind == "conf":
        ann[code].append(d)
CONF, PRE = [], []
for code, start, end, tm, note in E.load_conf(SITE):
    host = E.host(note)
    e = make(code, end or start, "14:00", host=host)    # 召開日當天收盤後才知道講了什麼
    if e:
        CONF.append(e)
    # 會前：最早的公告（召開前 60 天內）
    c = D.ci.get(code)
    a = [x for x in ann.get(code, []) if x <= start and (np.datetime64(start) - np.datetime64(x)).astype(int) <= E.CONF_LOOK]
    if c is None or not a:
        continue
    s0, _ = E.entry(dates, min(a), "13:30")
    i1 = bisect.bisect_left(dates, start)
    if i1 >= T or dates[i1] != start or i1 - s0 < 2 or s0 + 1 >= T:
        continue
    if not (np.isfinite(AO[s0 + 1, c]) and np.isfinite(AC[i1, c])) or D.LIMIT_OPEN[s0 + 1, c]:
        continue
    x = AC[i1, c] / AO[s0 + 1, c] - 1
    k = dec[s0, c]
    if k < 0:
        continue
    mk = AC[i1] / AO[s0 + 1] - 1
    mk[(mk < -0.7) | (mk > 3)] = np.nan
    peer = mk[dec[s0] == k]
    peer = peer[np.isfinite(peer)]
    if len(peer) < 10:
        continue
    PRE.append({"d": dates[s0 + 1], "x": x, "ex": x - peer.mean(), "exm": x - np.median(peer),
                "days": i1 - s0, "host": host})


def collect(ev, sel, h):
    out = []
    for e in ev:
        if not sel(e):
            continue
        s, c = e["s"], e["c"]
        if s + h >= T or D.LIMIT_OPEN[s + 1, c]:
            continue
        x = R[h][s, c]
        if not np.isfinite(x):
            continue
        k = dec[s, c]
        if k < 0 or not np.isfinite(CTL[h][s, k]):
            continue
        out.append((e["d"], x, x - CTL[h][s, k], x - MKT[h][s], x - CTLMED[h][s, k]))
    return out


def stats(rows):
    if len(rows) < 10:
        return None
    r = np.array([x[1] for x in rows])
    ex = np.array([x[2] for x in rows])
    em = np.array([x[3] for x in rows])
    exm = np.array([x[4] for x in rows])
    by = defaultdict(list)
    for d, _, e, _, _ in rows:
        by[d].append(e)
    daily = np.array([np.mean(v) for v in by.values()])
    t = daily.mean() / (daily.std(ddof=1) / np.sqrt(len(daily))) if len(daily) > 2 else np.nan
    return {"n": len(r), "avg": r.mean() * 100, "med": np.median(r) * 100, "win": (r > 0).mean() * 100,
            "ex": ex.mean() * 100, "exmed": np.median(exm) * 100, "beat": (exm > 0).mean() * 100,
            "mkt": em.mean() * 100, "t": t}


def table(title, ev, groups):
    print(f"## {title}")
    print(f"{'':<14} {'h':>3} {'筆':>6} {'平均':>7} {'中位':>7} {'上漲':>5} │ {'減對照':>7} {'中位':>7} {'贏':>5} {'t':>6} │ {'減大盤':>7}")
    for lab, sel in groups:
        for h in HS:
            s = stats(collect(ev, sel, h))
            if s:
                print(f"{lab:<14} {h:>3} {s['n']:>6} {s['avg']:>+7.2f} {s['med']:>+7.2f} {s['win']:>4.0f}% │ {s['ex']:>+7.2f}"
                      f" {s['exmed']:>+7.2f} {s['beat']:>4.0f}% {s['t']:>+6.2f} │ {s['mkt']:>+7.2f}")
        print()


def split(title, ev, sel, h=20):
    print(f"### {title}，{h} 日，分段")
    for lab, a, b in [("2021-10～2022", "0000", "2023"), ("2023", "2023", "2024"), ("2024", "2024", "2025"),
                      ("2025", "2025", "2026"), ("2026", "2026", "9999"),
                      (f"前段 <{SPLIT}", "0000", SPLIT), (f"後段 ≥{SPLIT}", SPLIT, "9999")]:
        s = stats(collect(ev, lambda e: sel(e) and a <= e["d"] < b, h))
        if s:
            print(f"  {lab:<16} {s['n']:>5} 筆　平均 {s['avg']:>+6.2f}%（中位 {s['med']:>+6.2f}%）　減對照 {s['ex']:>+6.2f}%"
                  f"（中位 {s['exmed']:>+6.2f}%，贏 {s['beat']:>3.0f}%，t {s['t']:>+5.2f}）")
    print()


def react_groups(lo=-0.05, mid_lo=-0.02, mid_hi=0.02, hi=0.05):
    return [("反應 ≤ −5%", lambda e: e["react"] <= lo), ("−5～−2%", lambda e: lo < e["react"] <= mid_lo),
            ("−2～+2%", lambda e: mid_lo < e["react"] < mid_hi), ("+2～+5%", lambda e: mid_hi <= e["react"] < hi),
            ("反應 ≥ +5%", lambda e: e["react"] >= hi)]


num = lambda g: isinstance(g, float)
print(f"財報 {len(FIN)} 則（有去年同季可比 {sum(e['g'] is not None for e in FIN)}），自結 {len(SELF)}，注意股公布 {len(ATTN)}，"
      f"法說會 {len(CONF)}（會前可測 {len(PRE)}）；{min(e['d'] for e in FIN)} ～ {max(e['d'] for e in FIN)}\n")
ALL = lambda e: True
table("財報：單季淨利年增", FIN, [
    ("全部", ALL),
    ("年增 ≥ +100%", lambda e: num(e["g"]) and e["g"] >= 1),
    ("+30～+100%", lambda e: num(e["g"]) and 0.3 <= e["g"] < 1),
    ("0～+30%", lambda e: num(e["g"]) and 0 <= e["g"] < 0.3),
    ("−30～0%", lambda e: num(e["g"]) and -0.3 <= e["g"] < 0),
    ("年減 > 30%", lambda e: num(e["g"]) and e["g"] < -0.3),
    ("轉盈", lambda e: e["g"] == "轉盈"),
    ("轉虧", lambda e: e["g"] == "轉虧"),
    ("續虧", lambda e: e["g"] == "續虧"),
])
table("財報：公布後的第一個反應", FIN, react_groups())
table("財報：大好 × 反應", FIN, [
    ("年增≥30%且漲≥2%", lambda e: (e["g"] == "轉盈" or num(e["g"]) and e["g"] >= 0.3) and e["react"] >= 0.02),
    ("年增≥30%但跌≤-2%", lambda e: (e["g"] == "轉盈" or num(e["g"]) and e["g"] >= 0.3) and e["react"] <= -0.02),
    ("年減>30%且跌≤-2%", lambda e: (e["g"] == "轉虧" or num(e["g"]) and e["g"] < -0.3) and e["react"] <= -0.02),
    ("年減>30%但漲≥2%", lambda e: (e["g"] == "轉虧" or num(e["g"]) and e["g"] < -0.3) and e["react"] >= 0.02),
])
table("自結損益（非制式表）", SELF, [("全部", ALL)] + react_groups(-0.03, -0.01, 0.01, 0.03))
table("達注意標準而公布財務", ATTN, [("全部", ALL)] + react_groups())
table("法說會：召開之後", CONF, [("全部", ALL), ("自辦", lambda e: e["host"] == "自辦"), ("受邀", lambda e: e["host"] == "受邀")]
      + react_groups(-0.04, -0.015, 0.015, 0.04))

print("## 法說會：會前（公告隔天開盤 → 召開日收盤）")
for lab, sel in [("全部", ALL), ("自辦", lambda e: e["host"] == "自辦"), ("受邀", lambda e: e["host"] == "受邀")]:
    xs = [e for e in PRE if sel(e)]
    if len(xs) < 10:
        continue
    x = np.array([e["x"] for e in xs])
    ex = np.array([e["ex"] for e in xs])
    exm = np.array([e["exm"] for e in xs])
    by = defaultdict(list)
    for e in xs:
        by[e["d"]].append(e["ex"])
    daily = np.array([np.mean(v) for v in by.values()])
    t = daily.mean() / (daily.std(ddof=1) / np.sqrt(len(daily)))
    print(f"  {lab:<4} {len(xs):>5} 筆，平均 {np.median([e['days'] for e in xs]):.0f} 個交易日：原始 {x.mean() * 100:+.2f}%"
          f"（中位 {np.median(x) * 100:+.2f}%），減對照 {ex.mean() * 100:+.2f}%（中位 {np.median(exm) * 100:+.2f}%，"
          f"贏 {(exm > 0).mean() * 100:.0f}%，t {t:+.2f}）")
print("### 會前，分段")
for lab, a, b in [("2021-10～2022", "0000", "2023"), ("2023", "2023", "2024"), ("2024", "2024", "2025"),
                  ("2025", "2025", "2026"), ("2026", "2026", "9999")]:
    xs = [e for e in PRE if a <= e["d"] < b]
    if xs:
        ex, exm = np.array([e["ex"] for e in xs]), np.array([e["exm"] for e in xs])
        print(f"  {lab:<14} {len(xs):>5} 筆　減對照 {ex.mean() * 100:+.2f}%（中位 {np.median(exm) * 100:+.2f}%，"
              f"贏 {(exm > 0).mean() * 100:.0f}%）")
print()

GOOD = lambda e: E.signal(e["g"], e["react"]) == "good"
BAD = lambda e: E.signal(e["g"], e["react"]) == "bad"
split("財報 年增≥30%且漲≥2%", FIN, GOOD)
split("財報 年增≥30%且漲≥2%", FIN, GOOD, 5)
split("財報 年減>30%且跌≤-2%", FIN, BAD)
split("財報 轉虧", FIN, lambda e: e["g"] == "轉虧")
split("財報 反應 +2～+5%", FIN, lambda e: 0.02 <= e["react"] < 0.05)
split("財報 反應 ≥ +5%", FIN, lambda e: e["react"] >= 0.05)
split("財報 反應 ≤ −5%", FIN, lambda e: e["react"] <= -0.05)
split("財報 年增 ≥ +100%", FIN, lambda e: num(e["g"]) and e["g"] >= 1)
split("法說會 全部", CONF, ALL, 5)
