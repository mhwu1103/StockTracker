"""回測 MK 的大盤規則：用 2000 年起的加權指數（Yahoo ^TWII，價格指數、不含息）。

    python scripts/backtest_gooaye_market.py              每次從 Yahoo 抓
    python scripts/backtest_gooaye_market.py twii.json    用存好的檔（{"d","o","c"}）

他講過、看起來互相矛盾的三條：
  1. 2022：大盤跌破季線就不做多，季線轉正才回來（擇時）
  2. 2023–24：加權指數跌破年線就閉眼分批買（左側）
  3. 指數高檔出長黑 K 就先降槓桿
另外是幾條總經規則（VIX、油價、初領失業金），資料來自 FRED。
網站自己的資料只到 2021-10，季線、年線的狀態幾乎都落在多頭裡，所以另外用長歷史測。
訊號用收盤判斷，隔天開盤換手。只印表，不寫檔；結論整理在 BACKTEST.md。
"""

from __future__ import annotations

import json
import statistics as st
import sys
from datetime import datetime

import requests


def fetch():
    r = requests.get("https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII",
                     params={"period1": 946684800, "period2": int(datetime.now().timestamp()), "interval": "1d"},
                     headers={"User-Agent": "Mozilla/5.0"}, timeout=60)
    j = r.json()["chart"]["result"][0]
    q = j["indicators"]["quote"][0]
    rows = [(datetime.utcfromtimestamp(t + 8 * 3600).strftime("%Y-%m-%d"), o, c)
            for t, o, c in zip(j["timestamp"], q["open"], q["close"]) if o and c]
    return {"d": [r[0] for r in rows], "o": [r[1] for r in rows], "c": [r[2] for r in rows]}


def ma(xs, n, i):
    return st.fmean(xs[i - n + 1:i + 1]) if i >= n - 1 else None


def main():
    x = json.load(open(sys.argv[1])) if len(sys.argv) > 1 else fetch()
    d, o, c = x["d"], x["o"], x["c"]
    n = len(d)
    print(f"加權指數 {d[0]} ~ {d[-1]}，{n} 天")
    state = {}
    for i in range(250, n):
        m60, m240 = ma(c, 60, i), ma(c, 240, i)
        hi = max(c[i - 250:i + 1])
        state[i] = {"b60": c[i] < m60, "b240": c[i] < m240, "m60up": m60 > ma(c, 60, i - 5),
                    "black": c[i] / c[i - 1] - 1 <= -0.025 and c[i - 1] >= 0.95 * hi}

    def fwd(i, h):
        return c[i + h] / o[i + 1] - 1 if i + h < n else None

    print("\n=== 之後 20／60 日報酬（隔天開盤進場） ===")
    conds = [("全部日子", lambda s: True), ("在季線下", lambda s: s["b60"]), ("在季線上", lambda s: not s["b60"]),
             ("在年線下", lambda s: s["b240"]), ("在年線上", lambda s: not s["b240"]),
             ("高檔長黑（跌 ≥2.5%、前一天離 250 日高 5% 內）", lambda s: s["black"])]
    for lab, f in conds:
        for h in (20, 60, 120):
            rs = [r for i, s in state.items() if f(s) and (r := fwd(i, h)) is not None]
            if rs:
                print(f"  {lab:<36}{h:>4} 日  n={len(rs):>5}  平均 {st.fmean(rs) * 100:+6.2f}%  "
                      f"中位 {st.median(rs) * 100:+6.2f}%  上漲 {st.fmean(r > 0 for r in rs) * 100:3.0f}%  "
                      f"最差 {min(rs) * 100:+6.1f}%")

    # 擇時：在線上就持有指數，跌破就空手（收盤判斷、隔天開盤換手）
    print("\n=== 擇時（收盤判斷、隔天開盤換手；空手時報酬 0，不扣交易成本） ===")
    def run(rule, start=250):
        eq, peak, mdd, inside, trades = 1.0, 1.0, 0.0, None, 0
        curve = []
        for i in range(start, n - 1):
            want = rule(i)
            if inside is None:
                inside = want
            # i 收盤決定，i+1 開盤換手：i→i+1 這一段的報酬分成 收盤→開盤（舊部位）與 開盤→收盤（新部位）
            r = 0.0
            if inside:
                r += o[i + 1] / c[i] - 1
            if want != inside:
                trades += 1
            inside = want
            if inside:
                r = (1 + r) * (c[i + 1] / o[i + 1]) - 1
            eq *= 1 + r
            peak = max(peak, eq)
            mdd = min(mdd, eq / peak - 1)
            curve.append(eq)
        yrs = (n - 1 - start) / 245
        return eq, eq ** (1 / yrs) - 1, mdd, trades

    # 他的原話：跌破季線就不做多，季線轉正才回來 → 有遲滯的狀態機，先算好每天要不要持有
    lit, inside = {}, True
    for i in sorted(state):
        s = state[i]
        if inside and s["b60"]:
            inside = False
        elif not inside and s["m60up"] and not s["b60"]:
            inside = True
        lit[i] = inside
    rules = [("買進持有", lambda i: True),
             ("他的原話：破季線出、季線上揚且站回才進", lambda i: lit[i]),
             ("季線上才持有", lambda i: not state[i]["b60"]),
             ("季線上、或季線還在往上才持有", lambda i: not state[i]["b60"] or state[i]["m60up"]),
             ("年線上才持有", lambda i: not state[i]["b240"]),
             ("高檔長黑後空手 20 天", None)]
    for lab, f in rules:
        if f is None:
            black = [i for i, s in state.items() if s["black"]]
            out = set()
            for i in black:
                out.update(range(i, i + 20))
            f = lambda i, out=out: i not in out
        eq, cagr, mdd, tr = run(f)
        print(f"  {lab:<28} 年化 {cagr * 100:+6.2f}%  最大回落 {mdd * 100:6.1f}%  換手 {tr:>4} 次  終值 {eq:6.2f} 倍")
    print("\n分段：")
    for a, b in (("2000", "2008"), ("2009", "2019"), ("2020", "2026")):
        idx = [i for i in state if a <= d[i][:4] <= b]
        s0 = idx[0]
        for lab, f in rules[:5]:
            def g(i, f=f, hi=idx[-1]):
                return f(i) if i <= hi else False
            eq, cagr, mdd, tr = run_seg(c, o, s0, idx[-1], f)
            print(f"  {a}–{b} {lab:<28} 年化 {cagr * 100:+6.2f}%  最大回落 {mdd * 100:6.1f}%")
    macro(d, o, c)


# ---------------------------------------------------------------------------
# 總經規則（FRED，免金鑰）：美國的數字一律只用台股那一天開盤前已經公布的值
# ---------------------------------------------------------------------------
FRED = "https://fred.stlouisfed.org/graph/fredgraph.csv?id="
LAG = {"ICSA": 5, "CPIAUCSL": 45}       # 週資料的週末 → 週四公布；CPI 次月中公布


def fred(series_id):
    from datetime import date, timedelta
    txt = requests.get(FRED + series_id, timeout=60).text
    out = []
    for line in txt.splitlines()[1:]:
        d, _, v = line.partition(",")
        if v and v != ".":
            day = date.fromisoformat(d) + timedelta(days=LAG.get(series_id, 1))   # 日資料：美國收盤 → 台股隔天
            out.append((day.isoformat(), float(v)))
    return out


def asof(series, dates):
    """每個台股交易日能看到的最新值。"""
    out, k = [], -1
    for d in dates:
        while k + 1 < len(series) and series[k + 1][0] <= d:
            k += 1
        out.append(series[k][1] if k >= 0 else None)
    return out


def macro(d, o, c):
    n = len(d)

    def fwd(i, h):
        return c[i + h] / o[i + 1] - 1 if i + h < n else None

    def show(lab, idx):
        print(f"  {lab}（{len(idx)} 次）")
        for h in (20, 60, 120):
            rs = [r for i in idx if (r := fwd(i, h)) is not None]
            if rs:
                print(f"    {h:>3} 日  n={len(rs):>4}  平均 {st.fmean(rs) * 100:+6.2f}%  中位 {st.median(rs) * 100:+6.2f}%  "
                      f"上漲 {st.fmean(r > 0 for r in rs) * 100:3.0f}%  最差 {min(rs) * 100:+6.1f}%")

    def crosses(xs, lvl, gap=20):
        """第一次站上 lvl（之前 gap 天都在下面）"""
        return [i for i in range(gap, n) if xs[i] is not None and xs[i] >= lvl
                and all(x is not None and x < lvl for x in xs[i - gap:i])]

    print("\n=== 總經規則：之後加權指數的報酬（全部日子：20 日 +0.74%、60 日 +2.52%、120 日 +5.43%） ===")
    vix = asof(fred("VIXCLS"), d)
    show("VIX 第一次站上 30（前 20 天都在 30 以下）", crosses(vix, 30))
    show("VIX 第一次站上 40", crosses(vix, 40))
    show("VIX 在 30 以上的每一天", [i for i in range(n) if vix[i] and vix[i] >= 30])
    oil = asof(fred("DCOILBRENTEU"), d)
    show("布蘭特第一次站上 120 美元", crosses(oil, 120))
    show("布蘭特在 120 美元以上的每一天", [i for i in range(n) if oil[i] and oil[i] >= 120])
    show("布蘭特在 90～110 美元（他說的承平區）", [i for i in range(n) if oil[i] and 90 <= oil[i] < 110])
    ic = fred("ICSA")
    # 四週平均的年增：初領失業金比去年同期多兩成以上
    ic4 = [(ic[k][0], st.fmean(v for _, v in ic[k - 3:k + 1])) for k in range(3, len(ic))]
    ic_yoy = [(ic4[k][0], ic4[k][1] / ic4[k - 52][1] - 1) for k in range(52, len(ic4))]
    yy = asof(ic_yoy, d)
    show("初領失業金四週平均比去年多 20% 以上", [i for i in range(n) if yy[i] is not None and yy[i] >= 0.2])
    show("同上，第一次轉成多 20%", crosses(yy, 0.2))


def run_seg(c, o, s, e, rule):
    eq, peak, mdd, inside = 1.0, 1.0, 0.0, None
    for i in range(s, e):
        want = rule(i)
        if inside is None:
            inside = want
        r = o[i + 1] / c[i] - 1 if inside else 0.0
        inside = want
        if inside:
            r = (1 + r) * (c[i + 1] / o[i + 1]) - 1
        eq *= 1 + r
        peak = max(peak, eq)
        mdd = min(mdd, eq / peak - 1)
    yrs = (e - s) / 245
    return eq, eq ** (1 / yrs) - 1, mdd, 0


if __name__ == "__main__":
    main()
