"""期貨頁與它的回測共用的指標算式（futures.json → 每一天一個數字）。

同一個算式寫在兩個地方，遲早會一邊改了另一邊沒改，所以 build_futures.py 與 backtest_futures.py 都從這裡拿。
每一條都只用當天收盤（含）以前的資料。

| 指標 | 算式 | 為什麼這樣算 |
|---|---|---|
| 外資淨部位 | 大台淨口數 ＋ 小台淨口數 ÷ 4（約當大台） | 小台一口是大台的四分之一 |
| 外資成本 | 淨部位加碼時用當天結算價加權平均、減碼時成本不變、翻空翻多時重設 | 跟持股的平均成本同一個算法；只是估算——不知道真正的成交價，也不知道哪些是避險 |
| 外資損益 | 淨部位 × （今天結算 − 成本）× 200 元 | 大台一點 200 元 |
| 外資選擇權 | 買權未平倉淨金額 − 賣權未平倉淨金額（億） | 買買權、賣賣權都是看多；金額比口數好，價外的口數便宜 |
| 散戶多空比 | −（小台三大法人淨口數合計）÷ 小台全部未平倉 | 小台的參與者扣掉三大法人，剩下的幾乎是散戶；正＝散戶偏多 |
| 大額交易人 | （前十大特定法人買方 − 賣方）÷ 全市場未沖銷 | 「特定法人」是期交所定義的那幾家大法人，比三大法人更集中 |
| P/C 比 | 賣權未平倉 ÷ 買權未平倉（%） | 期交所直接公布 |
| 基差 | 台指期近月收盤 − 加權指數收盤（點、%） | 正價差＝期貨比現貨貴；7～8 月除息旺季會被股息壓成逆價差，那不是看空 |
| 關卡 | 最近月契約未平倉最大的買權、賣權履約價 | 常被當成壓力、支撐 |
"""

from __future__ import annotations

import json
import os

import numpy as np

SITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "data")
POINT = 200          # 大台一點幾元


def load(path=None):
    """(日期, {名稱: np.array})；缺的是 nan。"""
    f = json.load(open(path or os.path.join(SITE, "futures.json"), encoding="utf-8"))
    days = f["d"]

    def a(sec, key):
        return np.array([np.nan if v is None else float(v) for v in (f.get(sec) or {}).get(key) or [None] * len(days)])

    s = {f"{sec}.{k}": a(sec, k) for sec in f if sec != "d" for k in f[sec]}
    return days, s


def foreign_net(s):
    return s["tx.fo"] + s["mtx.fo"] / 4


def fut_price(s):
    """近月結算價；到期日那天近月是到期的契約、沒有結算價，用收盤價補。"""
    return np.where(np.isfinite(s["mkt.txs"]), s["mkt.txs"], s["mkt.txc"])


def foreign_cost(net, px):
    """(成本, 損益（億元）)：淨部位同方向加碼時用當天價加權平均，減碼不動，翻向重設。"""
    cost = np.full(len(net), np.nan)
    pnl = np.full(len(net), np.nan)
    c, p = np.nan, 0.0
    for i in range(len(net)):
        q, x = net[i], px[i]
        if not np.isfinite(q) or not np.isfinite(x):
            cost[i] = c
            continue
        if p == 0 or np.sign(q) != np.sign(p) or not np.isfinite(c):
            c = x
        elif abs(q) > abs(p):
            c = (c * abs(p) + x * (abs(q) - abs(p))) / abs(q)
        p = q
        cost[i] = c
        pnl[i] = q * (x - c) * POINT / 1e8
    return cost, pnl


def foreign_option(s):
    """外資台指選擇權多空淨額（億）＝買權未平倉淨金額 − 賣權未平倉淨金額；正＝偏多（買買權、賣賣權）。"""
    return s["fop.cv"] - s["fop.pv"]


def retail_ratio(s):
    inst = s["mtx.fo"] + s["mtx.tr"] + s["mtx.de"]
    with np.errstate(invalid="ignore", divide="ignore"):
        return -inst / s["mkt.mtxoi"] * 100


def large_net(s, special=True):
    b, sl = ("lt.pb10", "lt.ps10") if special else ("lt.b10", "lt.s10")
    with np.errstate(invalid="ignore", divide="ignore"):
        return (s[b] - s[sl]) / s["lt.oi"] * 100


def basis(s, index_close):
    """(點, %)；index_close 與 days 平行。"""
    pts = s["mkt.txc"] - index_close
    with np.errstate(invalid="ignore", divide="ignore"):
        return pts, pts / index_close * 100


def change(x, n):
    out = np.full(len(x), np.nan)
    out[n:] = x[n:] - x[:-n]
    return out


def rolling_rank(x, win=250):
    """x[i] 在近 win 天（含）裡的百分位 0～1；不滿 win 天、或當天是 nan 的是 nan。"""
    out = np.full(len(x), np.nan)
    for i in range(win - 1, len(x)):
        w = x[i - win + 1:i + 1]
        w = w[np.isfinite(w)]
        if np.isfinite(x[i]) and len(w) >= win // 2:
            out[i] = (w < x[i]).mean()
    return out
