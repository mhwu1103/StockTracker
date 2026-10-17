"""策略頁與它的回測共用的算式：動能 ＋ 營收創新高，抱 20 天。

同一個算式寫在兩個地方，遲早會一邊改了、另一邊沒改——回測說成立的規則，網站上跑的就不是
同一個東西了。所以 build_strategy.py 與 backtest_strategy.py 都從這裡拿。

## 規則（2026-10-18 定案，回測與壓力測試在 BACKTEST.md「動能 ＋ 營收創新高」）

- 範圍：普通股，近 20 個交易日至少 10 天在上市＋上櫃成交值前 300 名
- 訊號（t 日收盤後）：還原收盤創 60 個交易日新高 ＋ 最新已公布月營收創 12 個月新高
  （m 月營收從 m+1 月 11 日起才算：10 日前公布，用 11 日才不會偷看）
- t+1 日開盤買；開盤就漲停（≥ 前一天收盤 × 1.095）的跳過——實務上買不到
- 抱 20 個交易日，第 21 天開盤賣
- 最多同時 10 檔，每檔投入當下淨值的 1/10；訊號多於空位時先買 20 日漲幅大的
- 沒用到的錢放 0050（0050 的進出不計成本）；個股來回扣 0.585%（手續費 0.1425% × 2 ＋ 證交稅 0.3%）

## 淨值怎麼算

閒錢記成「0050 的單位數」：開盤賣股的錢買進 0050、開盤買股的錢從 0050 賣出，都用 0050 的開盤價。
每天的淨值用收盤價結算（0050 單位數 × 0050 收盤 ＋ 持股市值）。股價都是還原除權息的。
"""

from __future__ import annotations

import os
import random
from collections import defaultdict

import numpy as np

from gooaye import SITE, Prices, common, dated_files, load

RULE = {
    "high": 60,          # 創幾日新高
    "rev": 12,           # 營收創幾個月新高
    "rev_day": 11,       # m 月營收從 m+1 月幾日起才算
    "liq_top": 300,      # 流動池：成交值前幾名
    "liq_days": 10,      # 近 liq_window 天至少幾天在前 liq_top
    "liq_window": 20,
    "hold": 20,          # 抱幾個交易日
    "slots": 10,         # 最多同時幾檔
    "limit": 1.095,      # 開盤 ≥ 前收 × limit 視為開盤漲停，跳過
    "cost": 0.00585,     # 個股來回成本
}


def nextm(m: str) -> str:
    y, mo = int(m[:4]), int(m[5:]) + 1
    return f"{y + (mo > 12)}-{(mo - 1) % 12 + 1:02d}"


def ffill(x):
    out = x.copy()
    for i in range(1, len(out)):
        m = np.isnan(out[i])
        out[i, m] = out[i - 1, m]
    return out


class Data:
    """策略要用的全部矩陣（日期 × 股票）。dirs 前面的優先，跟 gooaye.Prices 一樣。"""

    def __init__(self, dirs=(SITE,)):
        dirs = [d for d in dirs if d]
        self.P = P = Prices(dirs)
        self.dates, self.T = P.dates, P.N
        self.di = P.di
        self.codes = sorted(c for c in P.C if common(c))
        self.N = N = len(self.codes)
        self.ci = {c: k for k, c in enumerate(self.codes)}
        T = self.T
        AC, AO = np.full((T, N), np.nan), np.full((T, N), np.nan)
        RO, RC = np.full((T, N), np.nan), np.full((T, N), np.nan)
        for k, c in enumerate(self.codes):
            cu = P.cum[c]
            for i, v in P.C[c].items():
                AC[i, k], RC[i, k] = v / cu[i], v
            for i, v in P.O[c].items():
                AO[i, k], RO[i, k] = v / cu[i], v
        self.AC, self.AO, self.RC, self.RO = AC, AO, RC, RO
        self.ACf, self.AOf, self.RCf = ffill(AC), ffill(AO), ffill(RC)

        # 流動池與名稱（排行檔只有前 300 名，名稱也從這裡拿）
        val = np.zeros((T, N))
        self.names = {}
        for sub in ("daily/twse", "daily/tpex"):
            for d, p in sorted(dated_files(sub, dirs).items()):
                if d not in self.di:
                    continue
                for s in load(p)["stocks"]:
                    k = self.ci.get(s["code"])
                    if k is not None:
                        val[self.di[d], k] = s["value"]
                        self.names[s["code"]] = s.get("name") or s["code"]
        top = np.zeros((T, N), bool)
        for i in range(T):
            nz = np.nonzero(val[i])[0]
            top[i, nz[np.argsort(-val[i, nz])[:RULE["liq_top"]]]] = True
        cs = np.cumsum(top, 0)
        w = RULE["liq_window"]
        self.LIQ = (cs - np.vstack([np.zeros((w, N)), cs[:-w]])) >= RULE["liq_days"]
        self.LIQ[:w - 1] = False

        # 創 60 日新高（還原收盤，含當天）
        n = RULE["high"]
        hi = np.full((T, N), np.nan)
        for i in range(n - 1, T):
            hi[i] = np.nanmax(self.ACf[i - n + 1:i + 1], 0)
        self.NEWHI = np.isfinite(AC) & (self.ACf >= hi)
        self.ret20 = np.full((T, N), np.nan)
        self.ret20[20:] = self.ACf[20:] / self.ACf[:-20] - 1

        # 營收創 12 個月新高：m 月營收從 m+1 月 11 日起生效，直到下個月的營收生效
        rev = {m: load(p) for m, p in dated_files("value/rev", [SITE]).items()}
        ms = sorted(rev)
        self.REVHI = np.zeros((T, N), bool)
        self.rev_at = np.full((T, N), -1, int)            # 生效中的是 ms 的第幾個月
        self.rev_months = ms
        self.rev = rev
        for j, m in enumerate(ms):
            s = f"{nextm(m)}-{RULE['rev_day']:02d}"
            i0 = next((i for i, d in enumerate(self.dates) if d >= s), None)
            if i0 is None:
                continue
            self.REVHI[i0:] = False                       # 新的月份生效：上個月的標記作廢
            for c, v in rev[m].items():
                k = self.ci.get(c)
                if k is None:
                    continue
                self.rev_at[i0:, k] = j
                prev = [rev[ms[j - q]].get(c, [None])[0] for q in range(1, RULE["rev"] + 1) if j - q >= 0]
                prev = [x for x in prev if x]
                hit = bool(v[0]) and len(prev) >= RULE["rev"] - 2 and v[0] > max(prev)
                self.REVHI[i0:, k] = hit

        # 開盤漲停（原始價，跟前一個有收盤的日子比）
        self.LIMIT_OPEN = np.zeros((T, N), bool)
        self.LIMIT_OPEN[1:] = RO[1:] >= self.RCf[:-1] * RULE["limit"]

        # 0050（還原）的開盤與收盤，停牌日沿用前一天
        o5 = np.array([P.O["0050"].get(i, np.nan) / P.cum["0050"][i] for i in range(T)])
        c5 = np.array([P.C["0050"].get(i, np.nan) / P.cum["0050"][i] for i in range(T)])
        self.b_open = ffill(o5[:, None])[:, 0]
        self.b_close = ffill(c5[:, None])[:, 0]

    def rev_info(self, k, i):
        """第 i 天生效中的營收：(月份, 營收, 年增率)"""
        j = self.rev_at[i, k]
        if j < 0:
            return None
        m = self.rev_months[j]
        v = self.rev[m].get(self.codes[k])
        return (m, v[0], v[1]) if v else None


def signals(D: Data):
    """T × N：t 日收盤後成立的訊號"""
    return D.NEWHI & D.REVHI & D.LIQ


def simulate(D: Data, sig, start: int, end: int | None = None, hold=None, K=None, delay=0,
             order="ret20", skip_limit=True, seed=None, rand_n=None):
    """從第 start 天開盤開始照規則操作（start−1−delay 天的訊號），到第 end−1 天收盤。

    回傳 dict：
      eq      每天收盤的淨值（start 之前是 nan；起點 = 1）
      bench   同期 0050（start 開盤 = 1）
      trades  已出場：[{k, s, e, x, r}]（訊號日、進場日、出場日的索引，r 已扣成本）
      open    還在手上：[{k, s, e, x, amt}]（x 可能 ≥ T，表示還沒到出場日）
      cash    最後一天收盤時放在 0050 的金額
    rand_n 不是 None 時是隨機對照：每天在流動池裡隨機挑 rand_n[s] 檔當訊號。
    """
    hold = hold or RULE["hold"]
    K = K or RULE["slots"]
    T = D.T if end is None else end
    cost = RULE["cost"]
    rng = random.Random(seed)
    units = 1.0 / D.b_open[start]                      # 起點全部放 0050
    pos, trades, held = [], [], set()
    eq = np.full(D.T, np.nan)
    bench = np.full(D.T, np.nan)
    for t in range(start, T):
        bo = D.b_open[t]
        keep = []
        for p in pos:
            if t >= p["x"]:
                r = D.AOf[t, p["k"]] / D.AOf[p["e"], p["k"]] - 1 - cost
                units += p["amt"] * (1 + r) / bo
                trades.append({**p, "x": t, "r": r})
                held.discard(p["k"])
            else:
                keep.append(p)
        pos = keep
        mark = units * bo + sum(p["amt"] * D.AOf[t, p["k"]] / D.AOf[p["e"], p["k"]] for p in pos)
        s = t - 1 - delay
        if s >= 0:
            if rand_n is not None:
                pool = list(np.nonzero(D.LIQ[s])[0])
                cand = rng.sample(pool, min(int(rand_n[s]), len(pool)))
            else:
                cand = list(np.nonzero(sig[s])[0])
                if order == "ret20":
                    cand.sort(key=lambda k: -np.nan_to_num(D.ret20[s, k]))
                elif order == "random":
                    rng.shuffle(cand)
                elif order == "weak":
                    cand.sort(key=lambda k: np.nan_to_num(D.ret20[s, k]))
            for k in cand:
                if len(pos) >= K:
                    break
                if k in held or np.isnan(D.AO[t, k]) or (skip_limit and D.LIMIT_OPEN[t, k]):
                    continue
                amt = mark / K
                if units * bo < amt * 0.999:
                    break
                units -= amt / bo
                pos.append({"k": k, "s": s, "e": t, "x": t + hold, "amt": amt})
                held.add(k)
        eq[t] = units * D.b_close[t] + sum(p["amt"] * D.ACf[t, p["k"]] / D.AOf[p["e"], p["k"]] for p in pos)
        bench[t] = D.b_close[t] / D.b_open[start]
    return {"eq": eq, "bench": bench, "trades": trades, "open": pos, "cash": units * D.b_close[T - 1]}


def max_drawdown(x):
    x = x[np.isfinite(x)]
    return float((x / np.maximum.accumulate(x) - 1).min()) if len(x) else 0.0


def stock_dirs():
    """長歷史（GOOAYE_DATA）＋網站，給回測用"""
    return [d for d in (os.environ.get("GOOAYE_DATA"), SITE) if d]
