"""期貨頁的每一個指標，對之後的大盤有沒有預測力？（2018-06 起）

    python scripts/backtest_futures_factors.py

只印表，不寫檔；結論在 BACKTEST.md「期貨籌碼的七個指標」，期貨頁的判讀（build_futures.py 的 VERDICT）從這裡來。
指標的算式在 scripts/futures.py，網站用同一份。

## 方法

- 每個指標每天換成「在近 250 個交易日裡的百分位」（只用當天以前的資料），切五等分
- 之後 h 個交易日加權指數（Yahoo ^TWII，價格指數）的漲跌：t 日收盤 → t+h 收盤。指數本身買不到，
  實際要用期貨或 0050，這裡只問方向
- 看最高一組減最低一組（Q5 − Q1），前段（< 2022-07，含 2018Q4、2020、2022 上半）與後段各算一次，
  **兩段同方向**才算有東西；重疊的持有期沒有修正 t 值，只報量級
- 關卡另外看事件：收盤跌破賣權關卡、站上買權關卡之後 5 日
"""

from __future__ import annotations

import sys

import numpy as np

import futures as F
from backtest_futures import taiex

sys.stdout.reconfigure(encoding="utf-8")
SPLIT = "2022-07-01"
HS = (1, 5, 20)


def main():
    days, s = F.load()
    px = taiex()
    keep = [i for i, d in enumerate(days) if d in px]
    days = [days[i] for i in keep]
    s = {k: v[keep] for k, v in s.items()}
    c = np.array([px[d] for d in days])
    n = len(days)
    sp = next(i for i, d in enumerate(days) if d >= SPLIT)
    fwd = {}
    for h in HS:
        r = np.full(n, np.nan)
        r[:-h] = c[h:] / c[:-h] - 1
        fwd[h] = r

    net = F.foreign_net(s)
    cost, pnl = F.foreign_cost(net, F.fut_price(s))
    bpts, bpct = F.basis(s, c)
    retail = F.retail_ratio(s)
    factors = [
        ("外資淨部位（越高越多）", net),
        ("外資淨部位 20 日變化", F.change(net, 20)),
        ("外資淨部位 5 日變化", F.change(net, 5)),
        ("外資期貨估算損益（億）", pnl),
        ("外資選擇權多空淨額（億）", F.foreign_option(s)),
        ("外資選擇權多空淨額 5 日變化", F.change(F.foreign_option(s), 5)),
        ("散戶多空比（小台，越高散戶越多）", retail),
        ("散戶多空比 5 日變化", F.change(retail, 5)),
        ("前十大特定法人淨部位 %", F.large_net(s, True)),
        ("前十大交易人淨部位 %", F.large_net(s, False)),
        ("前十大特定法人 5 日變化", F.change(F.large_net(s, True), 5)),
        ("P/C 未平倉比", s["opt.pco"]),
        ("P/C 未平倉比 5 日變化", F.change(s["opt.pco"], 5)),
        ("基差 %（正價差越大越高）", bpct),
    ]
    print(f"{days[0]} ～ {days[-1]}，{n} 天；前段 < {SPLIT} ≤ 後段；百分位用近 250 日\n")
    print(f"{'指標':<30} {'h':>3} │ {'Q1':>6} {'Q2':>6} {'Q3':>6} {'Q4':>6} {'Q5':>6} │ {'Q5−Q1 前段':>10} {'後段':>6} │ 同向")
    for name, x in factors:
        rk = F.rolling_rank(x)
        q = np.where(np.isfinite(rk), np.minimum((rk * 5).astype(int), 4), -1)
        for h in HS:
            r = fwd[h]
            cells = []
            for k in range(5):
                m = (q == k) & np.isfinite(r)
                cells.append(r[m].mean() * 100 if m.any() else np.nan)

            def spread(lo, hi):
                a = (q[lo:hi] == 4) & np.isfinite(r[lo:hi])
                b = (q[lo:hi] == 0) & np.isfinite(r[lo:hi])
                return (r[lo:hi][a].mean() - r[lo:hi][b].mean()) * 100 if a.any() and b.any() else np.nan
            f1, f2 = spread(0, sp), spread(sp, n)
            same = "✔" if np.sign(f1) == np.sign(f2) and min(abs(f1), abs(f2)) > (0.15 if h == 1 else 0.4 if h == 5 else 1.0) else ""
            print(f"{name:<30} {h:>3} │ " + " ".join(f"{v:>+6.2f}" for v in cells) + f" │ {f1:>+10.2f} {f2:>+6.2f} │ {same}")
        print()

    # 關卡：收盤跌破賣權最大未平倉履約價、站上買權最大未平倉履約價
    # 跟 build_futures.py 同一個過濾：離指數超過 20% 的不算關卡（到期前幾天冷門的深價外履約價）
    far = lambda w: np.where(np.abs(w / c - 1) <= 0.2, w, np.nan)
    pw, cw = far(s["opt.pw"]), far(s["opt.cw"])
    below = np.zeros(n, bool)
    above = np.zeros(n, bool)
    below[1:] = (c[1:] < pw[1:]) & (c[:-1] >= pw[:-1])
    above[1:] = (c[1:] > cw[1:]) & (c[:-1] <= cw[:-1])
    for name, ev in (("收盤剛跌破賣權關卡", below), ("收盤剛站上買權關卡", above),
                     ("收盤在賣權關卡之下", c < pw), ("收盤在買權關卡之上", c > cw)):
        for h in (5, 20):
            r = fwd[h]
            m = ev & np.isfinite(r)
            if m.sum():
                print(f"{name:<18} {h:>2} 日：{m.sum():>4} 天　平均 {r[m].mean() * 100:+.2f}%　上漲 {(r[m] > 0).mean() * 100:.0f}%"
                      f"　（全部日子 {np.nanmean(r) * 100:+.2f}%、{(r[np.isfinite(r)] > 0).mean() * 100:.0f}%）")
    dist_c = (cw - c) / c * 100
    dist_p = (c - pw) / c * 100
    print(f"\n關卡離收盤多遠（中位數）：買權關卡在上方 {np.nanmedian(dist_c):.1f}%、賣權關卡在下方 {np.nanmedian(dist_p):.1f}%")


if __name__ == "__main__":
    main()
