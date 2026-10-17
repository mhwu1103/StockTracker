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
- 多空（2026-10-18 加入）：0050（還原）收盤在 120 日線之下是空頭——空頭時不買新股（手上的照抱滿 20 天）、
  閒錢放現金；站回 120 日線恢復。t 日收盤判斷、t+1 開盤照做。回測在 BACKTEST.md「多頭與空頭用不同做法」

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
    "regime_ma": 120,    # 0050 收盤在幾日線之下算空頭
    "bear_slots": 0,     # 空頭時最多持有幾檔才繼續買（0 = 不買新股）
    "bear_idle": "cash", # 空頭時閒錢放哪
}
MAXHOLD = 250            # 出場規則沒有固定天數時，最長抱幾天


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
        self._ma = {}

    def ma(self, n):
        """還原收盤的 n 日均線（停牌日沿用前一天的價），算過就記住"""
        if n not in self._ma:
            c = np.cumsum(self.ACf, 0)
            out = np.full_like(self.ACf, np.nan)
            out[n - 1:] = (c[n - 1:] - np.vstack([np.zeros((1, self.N)), c[:-n]])) / n
            self._ma[n] = out
        return self._ma[n]

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
             order="ret20", skip_limit=True, seed=None, rand_n=None, exit=None,
             regime=None, exit_bear=None, K_bear=None, bear_idle="0050"):
    """從第 start 天開盤開始照規則操作（start−1−delay 天的訊號），到第 end−1 天收盤。

    exit 是出場規則（不給就是定案的「抱 hold 天」）。每天收盤後判斷，成立就隔天開盤賣：
      hold   固定抱幾天就賣（None 表示不設上限，最長 MAXHOLD 天）
      min    至少抱幾天，下面的 ma／trail／take 才開始算
      ma     收盤跌破 n 日均線
      trail  從持有期間最高收盤回落這個比例
      take   漲到這個比例停利
      stop   跌到這個比例停損（不受 min 限制）
      ma_stop (n, loss)：收盤跌破 n 日均線「而且」虧損 ≥ loss 才賣（不受 min 限制）
      renew  抱滿 hold 天那天如果又出現新訊號，再抱 hold 天

    多空切換（regime 不給就是一律多頭）：regime[t] 是 t 日收盤後判斷的「多頭」，影響 t+1 開盤的動作——
      exit_bear  空頭時買進的那一筆用這套出場（一筆的出場規則在買進那天就定了）
      K_bear     空頭時最多持有幾檔才繼續買（0 = 空頭不買新股；已經在手上的照原規則出場）
      bear_idle  空頭時閒錢放哪：「0050」或「cash」（現金，不計利息）

    回傳 dict：
      eq      每天收盤的淨值（start 之前是 nan；起點 = 1）
      bench   同期 0050（start 開盤 = 1）
      trades  已出場：[{k, s, e, x, r}]（訊號日、進場日、出場日的索引，r 已扣成本）
      open    還在手上：[{k, s, e, x, amt}]（x 可能 ≥ T，表示還沒到出場日）
      cash    最後一天收盤時的閒錢（0050 或現金）
    rand_n 不是 None 時是隨機對照：每天在流動池裡隨機挑 rand_n[s] 檔當訊號。
    """
    hold = hold or RULE["hold"]
    ex_bull = {"hold": hold, **(exit or {})}
    ex_bear = {"hold": hold, **(exit_bear if exit_bear is not None else (exit or {}))}
    rules = bool(exit) or bool(exit_bear)
    K = K or RULE["slots"]
    T = D.T if end is None else end
    cost = RULE["cost"]
    rng = random.Random(seed)
    units, cashv = 1.0 / D.b_open[start], 0.0           # 起點全部放 0050
    pos, trades, held = [], [], set()
    eq = np.full(D.T, np.nan)
    bench = np.full(D.T, np.nan)
    for t in range(start, T):
        bo = D.b_open[t]
        bull = True if regime is None or t == 0 else bool(regime[t - 1])
        in_cash = not bull and bear_idle == "cash"
        if in_cash and units:                              # 轉進現金
            cashv, units = cashv + units * bo, 0.0
        elif not in_cash and cashv:                        # 轉回 0050
            units, cashv = units + cashv / bo, 0.0
        keep = []
        for p in pos:
            if t >= p["x"]:
                r = D.AOf[t, p["k"]] / D.AOf[p["e"], p["k"]] - 1 - cost
                if in_cash:
                    cashv += p["amt"] * (1 + r)
                else:
                    units += p["amt"] * (1 + r) / bo
                trades.append({**p, "x": t, "r": r})
                held.discard(p["k"])
            else:
                keep.append(p)
        pos = keep
        idle = units * bo + cashv
        mark = idle + sum(p["amt"] * D.AOf[t, p["k"]] / D.AOf[p["e"], p["k"]] for p in pos)
        cap = K if bull or K_bear is None else K_bear
        s = t - 1 - delay
        if s >= 0 and len(pos) < cap:
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
            ex = ex_bull if bull else ex_bear
            for k in cand:
                if len(pos) >= cap:
                    break
                if k in held or np.isnan(D.AO[t, k]) or (skip_limit and D.LIMIT_OPEN[t, k]):
                    continue
                amt = mark / K
                if idle < amt * 0.999:
                    break
                if in_cash:
                    cashv -= amt
                else:
                    units -= amt / bo
                idle -= amt
                x = t + ex["hold"] if ex["hold"] else t + MAXHOLD
                pos.append({"k": k, "s": s, "e": t, "x": x, "amt": amt, "peak": D.AOf[t, k], "ex": ex})
                held.add(k)
        eq[t] = units * D.b_close[t] + cashv + sum(p["amt"] * D.ACf[t, p["k"]] / D.AOf[p["e"], p["k"]] for p in pos)
        bench[t] = D.b_close[t] / D.b_open[start]
        if rules:                                          # 收盤後判斷要不要明天開盤賣
            for p in pos:
                ex = p["ex"]
                k, c = p["k"], D.ACf[t, p["k"]]
                p["peak"] = max(p["peak"], c)
                r = c / D.AOf[p["e"], k] - 1
                d = t - p["e"] + 1
                sell = ex.get("stop") is not None and r <= -ex["stop"]
                if ex.get("ma_stop"):
                    n, loss = ex["ma_stop"]
                    sell |= c < D.ma(n)[t, k] and r <= -loss
                if d >= ex.get("min", 0):
                    sell |= ex.get("ma") is not None and c < D.ma(ex["ma"])[t, k]
                    sell |= ex.get("trail") is not None and c < p["peak"] * (1 - ex["trail"])
                    sell |= ex.get("take") is not None and r >= ex["take"]
                if sell:
                    p["x"] = min(p["x"], t + 1)
                elif ex.get("renew") and p["x"] == t + 1 and sig[t, k]:
                    p["x"] = t + 1 + ex["hold"]
    for p in pos:
        p.pop("ex", None)
    for tr in trades:
        tr.pop("ex", None)
    return {"eq": eq, "bench": bench, "trades": trades, "open": pos,
            "cash": units * D.b_close[T - 1] + cashv}


def regime_ma(D: Data, n: int):
    """0050（還原）收盤在 n 日均線之上 = 多頭。t 日收盤後就知道，用在 t+1 開盤"""
    c = D.b_close
    m = np.convolve(c, np.ones(n) / n, "full")[:len(c)]
    m[:n - 1] = np.nan
    return c > m


def run(D: Data, sig, start: int, **kw):
    """照定案的規則（含多空切換）跑。網站與回測都用這個，壓力測試再用 kw 改其中一項"""
    opts = {"regime": regime_ma(D, RULE["regime_ma"]), "K_bear": RULE["bear_slots"],
            "bear_idle": RULE["bear_idle"], **kw}
    return simulate(D, sig, start, **opts)


def max_drawdown(x):
    x = x[np.isfinite(x)]
    return float((x / np.maximum.accumulate(x) - 1).min()) if len(x) else 0.0


def stock_dirs():
    """長歷史（GOOAYE_DATA）＋網站，給回測用"""
    return [d for d in (os.environ.get("GOOAYE_DATA"), SITE) if d]
