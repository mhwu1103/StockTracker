"""回測 MK 的營收×股價假說（月頻）：照他講的規則挑股，下一個月含息超額報酬。

    python scripts/backtest_gooaye.py         只印出表格，不寫檔；結論整理在 BACKTEST.md

假說出處見 data/gooaye/brain/INSIGHTS.md 第六節（本機檔，repo 不收）。

時間軸：月營收最晚次月 10 日公布，所以「第 t 月底」能用的最新營收是 t−1 月。
訊號在 t 月底成立，報酬＝t+1 月含息報酬（月底收盤 ÷ 上月底收盤 ÷ 當月除權息因子）。
超額＝個股報酬 − 同月全體普通股等權平均；「贏中位」＝報酬高於同月中位數的比例（50% 是沒有鑑別力）。每個月先算訊號股的平均超額，再對各月做 t 檢定
（同月事件高度相關，不能把每一筆當獨立樣本）。另外報 3 個月（t+1～t+3 連乘）供參考。
沒有固定參數要學，所以不做 walk-forward；改成逐年拆開，2022 空頭要單獨站得住才算數。
"""

from __future__ import annotations

import math
import statistics as st
import sys
from collections import defaultdict

sys.path.insert(0, __import__("os").path.dirname(__file__))
import twse  # noqa: E402
import valuation  # noqa: E402

RET_LO, RET_HI = -0.6, 3.0     # 月報酬超出這個範圍視為減資、分割等沒還原的事件，丟掉
MIN_N = 5                      # 一個月至少幾檔訊號股才算那個月
MIN_PRICE = 10                 # 太低價的雞蛋水餃股不算


def common(code: str) -> bool:
    return len(code) == 4 and code.isdigit() and not code.startswith("0")


def load():
    this = twse.taipei_today().strftime("%Y-%m")
    close = defaultdict(dict)
    for mk in ("twse", "tpex"):
        for p in sorted((valuation.PE_DIR / mk).glob("*.json")):
            if p.stem >= this:
                continue
            for code, v in ((twse.read_json(p) or {}).get("c") or {}).items():
                if common(code) and len(v) > 3 and v[3]:
                    close[code][p.stem] = v[3]
    fac = defaultdict(lambda: defaultdict(lambda: 1.0))
    for p in sorted((twse.DATA_DIR / "exright").glob("*.json")):
        for code, ev in (twse.read_json(p) or {}).items():
            for d, f in ev:
                fac[code][d[:7]] *= f
    rev = defaultdict(dict)   # rev[code][月] = (營收, YoY%)
    for p in sorted(valuation.REV_DIR.glob("*.json")):
        for code, row in (twse.read_json(p) or {}).items():
            if common(code) and row and row[0]:
                rev[code][p.stem] = (row[0], row[1])
    months = sorted({m for c in close.values() for m in c})
    return close, fac, rev, months


def prev_month(m: str, k: int = 1) -> str:
    y, mm = int(m[:4]), int(m[5:])
    n = y * 12 + mm - 1 - k
    return f"{n // 12}-{n % 12 + 1:02d}"


def main():
    close, fac, rev, months = load()
    # 月報酬（含息）
    ret = defaultdict(dict)
    for code, s in close.items():
        for m, c in s.items():
            p = s.get(prev_month(m))
            if p:
                r = c / p / fac[code][m] - 1
                if RET_LO < r < RET_HI:
                    ret[code][m] = r
    med, avg = {}, {}
    for m in months:
        xs = [ret[c][m] for c in ret if m in ret[c]]
        if len(xs) > 200:
            med[m], avg[m] = st.median(xs), st.fmean(xs)
    # 超額減的是等權平均（全體對照才會是 0）；贏不贏另外跟中位數比
    exc = {c: {m: r - avg[m] for m, r in s.items() if m in avg} for c, s in ret.items()}
    beat = {c: {m: r > med[m] for m, r in s.items() if m in med} for c, s in ret.items()}
    mexc = {c: {m: r - med[m] for m, r in s.items() if m in med} for c, s in ret.items()}

    def exc3(code, m):
        """t 月底進場，持有 3 個月的超額（各月超額相加，近似）。"""
        xs = [exc[code].get(m2) for m2 in (nxt(m, 1), nxt(m, 2), nxt(m, 3))]
        return sum(xs) if all(x is not None for x in xs) else None

    def nxt(m, k):
        return prev_month(m, -k)

    # 連續創歷史新高第幾個月（歷史＝資料起點以來，至少要先有 12 個月）
    streaks = defaultdict(dict)
    for code, rs in rev.items():
        hi, k = None, 0
        for i, m in enumerate(sorted(rs)):
            v = rs[m][0]
            k = k + 1 if (i >= 12 and v > hi) else 0
            streaks[code][m] = k
            hi = v if hi is None else max(hi, v)

    # 營收衍生量，以「t 月底能看到的最新一個月 L = t−1」為準
    def feats(code, t):
        L = prev_month(t)
        rs = rev.get(code, {})
        if L not in rs:
            return None
        hist = [rs[m][0] for m in sorted(rs) if m <= L]
        if len(hist) < 25:
            return None
        cur, yoy = rs[L]
        if yoy is None:
            return None
        yoys = [rs[prev_month(L, k)][1] for k in range(0, 12)
                if prev_month(L, k) in rs and rs[prev_month(L, k)][1] is not None]
        streak = streaks[code].get(L, 0)
        ma = lambda n: st.fmean(hist[-n:])
        ma_prev = lambda n: st.fmean(hist[-n - 1:-1])
        pc = close.get(code, {})
        p_t, p_L = pc.get(t), pc.get(L)
        hi12 = [pc[prev_month(t, k)] for k in range(0, 12) if prev_month(t, k) in pc]
        hi12_prev = [pc[prev_month(t, k)] for k in range(1, 13) if prev_month(t, k) in pc]
        r6 = None
        if p_t and pc.get(prev_month(t, 6)):
            r6 = p_t / pc[prev_month(t, 6)] - 1
        return {
            "yoy": yoy,
            "yoy_peak": len(yoys) >= 12 and yoy == max(yoys),
            "streak": streak,
            "ath": streak >= 1,
            "near_hi": cur >= 0.9 * max(hist[-25:-1]),
            "ma_up": ma(3) > ma(6) > ma(12),
            "ma_up_new": ma(3) > ma(6) > ma(12) and not (ma_prev(3) > ma_prev(6) > ma_prev(12)),
            "yoy3": [rs[prev_month(L, k)][1] for k in range(3)
                     if prev_month(L, k) in rs and rs[prev_month(L, k)][1] is not None],
            "mom_t": (p_t / p_L - 1 - med.get(t, 0)) if p_t and p_L else None,   # 公布那個月股價相對表現
            "brk12": bool(p_t and len(hi12_prev) >= 11 and p_t > max(hi12_prev)),
            "r6": r6,
            "price": p_t,
        }

    groups = defaultdict(lambda: defaultdict(list))   # groups[名稱][t] = [(超額1M, 超額3M)]
    univ_r6 = {}
    for t in months:
        if nxt(t, 1) not in med:
            continue
        rows = {}
        for code in rev:
            if not (close.get(code, {}).get(t) and close[code][t] >= MIN_PRICE):
                continue
            f = feats(code, t)
            if f and nxt(t, 1) in exc.get(code, {}):
                rows[code] = f
        if not rows:
            continue
        r6s = sorted(f["r6"] for f in rows.values() if f["r6"] is not None)
        univ_r6[t] = st.median(r6s) if r6s else 0

        def add(name, code):
            groups[name][t].append((exc[code][nxt(t, 1)], exc3(code, t), beat[code][nxt(t, 1)],
                                    mexc[code][nxt(t, 1)]))

        for code, f in rows.items():
            add("全體（對照）", code)
            y = f["yoy"]
            # H1 營收高峰反指標
            if f["yoy_peak"] and y > 20:
                add("H1 YoY 是近 12 個月最高（且 >20%）", code)
            if f["ath"]:
                k = min(f["streak"], 4)
                add(f"H1 營收創歷史新高，連續第 {k}{'+' if k == 4 else ''} 個月", code)
            # H2 營收好但股價不漲
            if f["ath"] and y > 20 and f["mom_t"] is not None:
                add("H2 營收創新高＋YoY>20%，公布月股價跑輸" if f["mom_t"] < 0 else
                    "H2 營收創新高＋YoY>20%，公布月股價跑贏", code)
            # H3 營收均線依序翻揚、股價還在低位
            if f["ma_up_new"] and f["r6"] is not None:
                add("H3 營收 3>6>12 月均剛翻揚，股價 6 個月落後" if f["r6"] < univ_r6[t] else
                    "H3 營收 3>6>12 月均剛翻揚，股價 6 個月領先", code)
            # H4 營收加速＋股價突破
            if f["brk12"]:
                yy = f["yoy3"]
                accel = len(yy) == 3 and yy[0] > yy[1] > yy[2] and yy[0] > 0
                add("H4 股價創 12 個月新高＋營收 YoY 連 2 月加速" if accel else
                    "H4 股價創 12 個月新高，營收沒有加速", code)
            # H5 低基期陷阱
            if y > 30:
                add("H5 YoY>30% 且營收創歷史新高" if f["ath"] else
                    ("H5 YoY>30% 但營收離近兩年高點還遠（<90%，低基期）" if not f["near_hi"] else
                     "H5 YoY>30%，營收接近高點但沒創新高"), code)

    report(groups)


def tstat(xs):
    if len(xs) < 3:
        return float("nan")
    sd = st.stdev(xs)
    return st.fmean(xs) / (sd / math.sqrt(len(xs))) if sd else float("nan")


def report(groups):
    years = ["2019", "2020", "2021", "2022", "2023", "2024", "2025", "2026"]
    print(f"{'訊號':<44}{'月數':>5}{'平均檔':>7}{'1M超額':>8}{'t':>6}{'贏中位':>7}{'中位超額':>8}{'t':>6}{'3M超額':>8}  " +
          "".join(f"{y:>7}" for y in years))
    for name in sorted(groups, key=lambda s: (s[:2], s)):
        g = groups[name]
        ms = sorted(m for m, v in g.items() if len(v) >= MIN_N)
        if not ms:
            continue
        m1 = [st.fmean(x[0] for x in g[m]) for m in ms]
        m3 = [st.fmean(x[1] for x in g[m] if x[1] is not None) for m in ms
              if any(x[1] is not None for x in g[m])]
        beat = st.fmean(st.fmean(x[2] for x in g[m]) for m in ms)
        mm = [st.median(x[3] for x in g[m]) for m in ms]
        ny = {}
        for y in years:
            v = [a for m, a in zip(ms, m1) if m.startswith(y)]
            ny[y] = f"{st.fmean(v) * 100:+.2f}" if v else "—"
        print(f"{name:<44}{len(ms):>5}{st.fmean(len(g[m]) for m in ms):>7.0f}"
              f"{st.fmean(m1) * 100:>+8.2f}{tstat(m1):>6.1f}{beat * 100:>6.0f}%"
              f"{st.fmean(mm) * 100:>+8.2f}{tstat(mm):>6.1f}"
              f"{(st.fmean(m3) * 100 if m3 else float('nan')):>+8.2f}  " +
              "".join(f"{ny[y]:>7}" for y in years))
    print("\n年份欄＝該年各月 1M 平均超額（%）。2019 只有下半年；訊號月 t 歸在 t 那一年。")


if __name__ == "__main__":
    main()
