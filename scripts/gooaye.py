"""MK 頁與它的回測共用的算式：還原股價、營收連續創新高。

同一個算式寫在兩個地方，遲早會一邊改了、另一邊沒改——回測說成立的訊號，
網站上列出來的就不是同一個東西了。所以 build_gooaye.py 與 backtest_gooaye*.py 都從這裡拿。
"""

from __future__ import annotations

import glob
import json
import os
from collections import defaultdict

SITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "data")


def load(p):
    with open(p, encoding="utf8") as f:
        return json.load(f)


def common(code: str) -> bool:
    return len(code) == 4 and code.isdigit() and not code.startswith("0")


def dated_files(sub: str, dirs) -> dict:
    """{日期: 路徑}。dirs 前面的優先（網站的覆蓋長歷史的同一天）。"""
    out = {}
    for d in reversed(dirs):
        for p in glob.glob(os.path.join(d, sub, "*.json")):
            out[os.path.basename(p)[:-5]] = p
    return out


class Prices:
    """全市場每日開盤、收盤，與還原因子。

    還原：除權息日的因子（參考價 ÷ 前收盤）來自 exright/。單日漲跌幅上限是 10%，還原後還差
    超過 ±20% 的，當成分割、減資這類沒寫在除權息表裡的事件，一併還原（0050 在 2025-06 拆 1 為 4，
    停牌五天，所以容許前一筆收盤在 15 個交易日以內）。
    """

    def __init__(self, dirs=(SITE,)):
        dirs = [d for d in dirs if d]
        ctw, ctp = dated_files("close/twse", dirs), dated_files("close/tpex", dirs)
        self.dates = sorted(ctw)
        self.di = {d: i for i, d in enumerate(self.dates)}
        self.N = n = len(self.dates)
        self.O, self.C = defaultdict(dict), defaultdict(dict)
        for i, d in enumerate(self.dates):
            for src in (ctw, ctp):
                if d in src:
                    x = load(src[d])
                    for code, v in x["c"].items():
                        if v:
                            self.C[code][i] = v
                    for code, v in (x.get("o") or {}).items():
                        if v:
                            self.O[code][i] = v
        fac = defaultdict(dict)
        for p in glob.glob(os.path.join(SITE, "exright", "*.json")):
            for code, ev in load(p).items():
                for d, f in ev:
                    if d in self.di:
                        i = self.di[d]
                        fac[code][i] = fac[code].get(i, 1.0) * f
        self.cum = {}
        for code, cs in self.C.items():
            a, out, prev, fc = 1.0, [1.0] * n, None, fac.get(code, {})
            for i in range(n):
                f = fc.get(i, 1.0)
                c = cs.get(i)
                if c and prev and not 0.8 < c / prev[1] / f < 1.25 and i - prev[0] <= 15:
                    f *= c / prev[1] / f
                a *= f
                out[i] = a
                if c:
                    prev = (i, c)
            self.cum[code] = out
        self._adj = {}

    def adj(self, code):
        """還原後收盤的整條序列（沒有收盤的日子是 None）。以最後一天為基準往前除。"""
        if code not in self._adj:
            cs, cu = self.C.get(code, {}), self.cum.get(code)
            self._adj[code] = [cs[i] / cu[i] if i in cs else None for i in range(self.N)]
        return self._adj[code]

    def ret(self, code, i, h):
        """i+1 開盤進場、i+h 收盤出場的還原報酬；超出 −70%～+300% 視為資料問題。"""
        if i + h >= self.N:
            return None
        o, c = self.O[code].get(i + 1), self.C[code].get(i + h)
        if not o or not c:
            return None
        cu = self.cum[code]
        r = c / o / (cu[i + h] / cu[i + 1]) - 1
        return r if -0.7 < r < 3 else None


def roll_prev(xs, n, sign=1):
    """前 n 天（不含當天）的最高（sign=1）或最低（sign=-1）：每天一個 (值, 位置, 有效天數)。
    單調佇列；同值保留最近的那一天。"""
    from collections import deque
    q, out, cnt = deque(), [None] * len(xs), 0
    for i in range(len(xs)):
        while q and q[0] < i - n:
            q.popleft()
        if i - n - 1 >= 0 and xs[i - n - 1] is not None:
            cnt -= 1
        out[i] = (xs[q[0]], q[0], cnt) if q else (None, None, cnt)
        v = xs[i]
        if v is not None:
            cnt += 1
            while q and xs[q[-1]] * sign <= v * sign:
                q.pop()
            q.append(i)
    return out


def ma(xs, n):
    """n 日均線；中間有缺值就重新累積。"""
    out, s, k = [None] * len(xs), 0.0, 0
    for i, v in enumerate(xs):
        if v is None:
            s, k = 0.0, 0
            continue
        s += v
        k += 1
        if k > n:
            s -= xs[i - n]
            k = n
        if k == n:
            out[i] = s / n
    return out


def load_revenue(dirs=(SITE,)) -> dict:
    """rev[代號][月] = (營收, YoY%)，只收普通股。"""
    rev = defaultdict(dict)
    for m, p in sorted(dated_files("value/rev", [d for d in dirs if d]).items()):
        for code, row in load(p).items():
            if common(code) and row and row[0]:
                rev[code][m] = (row[0], row[1])
    return rev


def rev_streaks(rev: dict) -> dict:
    """streak[代號][月] = 營收連續創歷史新高第幾個月（0 = 沒創新高）。至少先有 12 個月才開始算。"""
    out = defaultdict(dict)
    for code, rs in rev.items():
        hi, k = None, 0
        for i, m in enumerate(sorted(rs)):
            v = rs[m][0]
            k = k + 1 if (i >= 12 and v > hi) else 0
            out[code][m] = k
            hi = v if hi is None else max(hi, v)
    return out


def prev_month(m: str, k: int = 1) -> str:
    y, mm = int(m[:4]), int(m[5:])
    n = y * 12 + mm - 1 - k
    return f"{n // 12}-{n % 12 + 1:02d}"
