"""外資台指期未平倉能不能當大盤多空開關？（2018-06 起）

    python scripts/backtest_futures.py              # 純擇時（加權指數，Yahoo ^TWII）
    GOOAYE_DATA=<長歷史 docs/data> python scripts/backtest_futures.py --strategy   # 再放進策略跑

只印表，不寫檔；結論在 BACKTEST.md「台指期法人未平倉」。

## 訊號（t 日收盤後，t+1 起生效）

外資「約當大台」淨未平倉 F ＝ 大台淨口數 ＋ 小台淨口數 ÷ 4（futures.json）。外資長年淨空（有一大塊是
現貨的避險），水位本身會漂移，所以都看**相對**：

- **位階**：F 在近 250 個交易日裡的百分位，低於 20%＝空單比平常重
- **變化**：F 近 20 個交易日的變化，低於近 250 日的 20% 分位＝這一個月空單加得特別快
- 跟現行的「跌破 120 日線」組合：任一成立、兩者都成立

## 怎麼比

- **條件報酬**：每個狀態之後 20 個交易日加權指數漲跌（價格指數、不含息）
- **純擇時**：多頭抱指數、空頭抱現金，前段（< 2022-07，含 2018Q4、2020 疫情、2022 上半）與後段
- `--strategy`：把開關換進策略頁的規則，20 種挑股順序（只有 2022-04 起，長歷史的限制）
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime

import numpy as np
import requests

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
FUT = os.path.join(HERE, "..", "docs", "data", "futures.json")
SPLIT = "2022-07-01"
WIN = 250
PCT = float(os.environ.get("FUT_PCT", "0.2"))
CHG = int(os.environ.get("FUT_CHG", "20"))
H = 20


def taiex():
    r = requests.get("https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII",
                     params={"period1": 1514764800, "period2": int(datetime.now().timestamp()), "interval": "1d"},
                     headers={"User-Agent": "Mozilla/5.0"}, timeout=60)
    j = r.json()["chart"]["result"][0]
    q = j["indicators"]["quote"][0]
    return {datetime.utcfromtimestamp(t + 8 * 3600).strftime("%Y-%m-%d"): c
            for t, c in zip(j["timestamp"], q["close"]) if c}


def futures_series():
    f = json.load(open(FUT, encoding="utf-8"))
    out = {}
    for i, d in enumerate(f["d"]):
        a, b = f["tx"]["fo"][i], f["mtx"]["fo"][i]
        if a is not None and b is not None:
            out[d] = a + b / 4
    return out


def rolling_rank(x, win):
    """x[i] 在 x[i-win+1..i] 裡的百分位（0～1）；不滿 win 的是 nan。"""
    out = np.full(len(x), np.nan)
    for i in range(win - 1, len(x)):
        w = x[i - win + 1:i + 1]
        out[i] = (w < x[i]).mean()
    return out


def build(px: dict, fut: dict):
    days = [d for d in sorted(px) if d in fut]
    c = np.array([px[d] for d in days])
    F = np.array([fut[d] for d in days])
    ma = np.full(len(c), np.nan)
    for i in range(119, len(c)):
        ma[i] = c[i - 119:i + 1].mean()
    lvl = rolling_rank(F, WIN)
    chg = np.full(len(F), np.nan)
    chg[CHG:] = F[CHG:] - F[:-CHG]
    chg_rank = rolling_rank(np.nan_to_num(chg, nan=0.0), WIN)
    chg_rank[:CHG + WIN] = np.nan
    return days, c, F, ma, lvl, chg_rank


def report(days, c, bears, start):
    print(f"\n{'開關（空頭＝）':<28} {'空頭天數':>6} {'切換':>5} │ {'全段':>6} {'回落':>5} │ {'前段':>6} {'回落':>5} │ {'後段':>6} {'回落':>5}")
    sp = next(i for i, d in enumerate(days) if d >= SPLIT)

    def run(bear, lo, hi):
        eq = [1.0]
        for t in range(lo + 1, hi):
            eq.append(eq[-1] * (c[t] / c[t - 1] if not bear[t - 1] else 1.0))
        eq = np.array(eq)
        return eq[-1] - 1, (eq / np.maximum.accumulate(eq) - 1).min()

    for name, bear in bears:
        b = bear[start:]
        flips = int(np.sum(b[1:] != b[:-1]))
        a = run(bear, start, len(c))
        f = run(bear, start, sp + 1)
        l_ = run(bear, sp, len(c))
        print(f"{name:<28} {b.mean() * 100:>5.0f}% {flips:>5} │ {a[0] * 100:>+5.0f}% {a[1] * 100:>4.0f}% │ "
              f"{f[0] * 100:>+5.0f}% {f[1] * 100:>4.0f}% │ {l_[0] * 100:>+5.0f}% {l_[1] * 100:>4.0f}%")


def conditional(days, c, states, start):
    print(f"\n之後 {H} 個交易日加權指數（價格指數）：")
    fwd = np.full(len(c), np.nan)
    fwd[:-H] = c[H:] / c[:-H] - 1
    sp = next(i for i, d in enumerate(days) if d >= SPLIT)
    for name, m in states:
        for lab, lo, hi in (("全段", start, len(c)), ("前段", start, sp), ("後段", sp, len(c))):
            sel = m[lo:hi] & np.isfinite(fwd[lo:hi])
            x = fwd[lo:hi][sel]
            if len(x):
                print(f"  {name:<26} {lab}　{len(x):>4} 天　平均 {x.mean() * 100:>+5.2f}%　中位 {np.median(x) * 100:>+5.2f}%"
                      f"　上漲 {(x > 0).mean() * 100:>3.0f}%")


def main():
    px, fut = taiex(), futures_series()
    days, c, F, ma, lvl, chg = build(px, fut)
    start = WIN + CHG
    print(f"加權指數 × 外資約當大台淨未平倉：{days[0]} ～ {days[-1]}，{len(days)} 天；從 {days[start]} 起比")
    below = c < ma
    heavy = lvl < PCT
    fast = chg < PCT
    always = np.zeros(len(c), bool)
    conditional(days, c, [("全部日子", ~always), ("跌破 120 日線", below), ("外資空單位階低 20%", heavy),
                          ("外資空單一個月加最快 20%", fast), ("位階低且跌破 120 日線", heavy & below),
                          ("位階不低且站上 120 日線", ~heavy & ~below)], start)
    report(days, c, [
        ("永遠多頭（買進持有）", always),
        ("跌破 120 日線（現行）", below),
        ("外資空單位階低 20%", heavy),
        ("外資空單一個月加最快 20%", fast),
        ("120 日線 或 位階低", below | heavy),
        ("120 日線 且 位階低", below & heavy),
        ("120 日線 或 加最快", below | fast),
        ("120 日線 且 加最快", below & fast),
    ], start)

    if "--strategy" in sys.argv:
        import strategy as S
        D = S.Data(S.stock_dirs())
        sig = S.signals(D)
        WARM = 130
        di = {d: i for i, d in enumerate(days)}

        def to_bull(bear):
            """futures 的日子 → 策略的交易日；那天沒有期貨資料就沿用前一天"""
            out = np.ones(D.T, bool)
            cur = True
            for t, d in enumerate(D.dates):
                if d in di:
                    cur = not bear[di[d]]
                out[t] = cur
            return out

        base = S.simulate(D, sig, WARM)
        bench = base["bench"]
        sp = next(i for i, d in enumerate(D.dates) if d >= "2024-07-01")
        bf = bench[sp] / bench[WARM] - 1
        bb = bench[-1] / bench[sp] - 1
        print(f"\n## 策略（2022-04 起，20 種挑股順序；0050 前段 {bf * 100:+.0f}%、後段 {bb * 100:+.0f}%）")
        reg120 = S.regime_ma(D, 120)
        for name, reg in [("跌破 120 日線（定案）", reg120), ("120 日線 或 位階低", reg120 & to_bull(heavy)),
                          ("120 日線 或 加最快", reg120 & to_bull(fast)), ("只看位階低", to_bull(heavy)),
                          ("只看加最快", to_bull(fast))]:
            A, B, M = [], [], []
            for sd in range(20):
                r = S.run(D, sig, WARM, regime=reg, order="random", seed=sd)
                e = r["eq"]
                A.append(e[sp] / e[WARM] - 1)
                B.append(e[-1] / e[sp] - 1)
                M.append(S.max_drawdown(e[WARM:]))
            A, B = np.array(A), np.array(B)
            print(f"  {name:<22} 前段 {np.median(A) * 100:+5.0f}%（{np.mean(A > bf) * 100:3.0f}% 贏）　"
                  f"後段 {np.median(B) * 100:+5.0f}%（{np.mean(B > bb) * 100:3.0f}% 贏）　回落 {np.median(M) * 100:.0f}%", flush=True)


if __name__ == "__main__":
    main()
