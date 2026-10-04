"""景氣頁：用月營收找出跟著景氣循環的股票，以及它們現在走到循環的哪一段。

    python scripts/build_cycle.py      -> docs/data/cycle.json

只讀 `value/rev/`（價值頁抓的月營收，2019-05 起）與 `industry.json`。

## 不先假設誰是循環股

教科書會直接說「塑化、鋼鐵、航運、記憶體是循環股」。這裡反過來，讓營收自己說話：

1. **景氣**：每個月取所有非金融公司「近 3 個月營收年增率」的**中位數**。用中位數而不是
   加總，是因為加總會被台積電一家帶著走——那是台積電的循環，不是景氣的寬度。
   近 3 個月合計再算年增，是要把單月的工作天數、出貨時點壓掉。
2. **個股**：拿每一檔的同一個年增率去對景氣，算兩個數：
   - 相關：營收是不是跟著景氣一起上下
   - beta：景氣動 1%，它的營收動幾 %。> 1 是循環來的時候振幅比大家大
3. **前後兩半都要過**：個股層級的雜訊很大——同一檔股票前半段與後半段的 beta 只相關 0.2
   左右（產業中位數是 0.6）。只看全期的話，一段特殊的期間（2021 年的低基期、2024 年起的
   AI）就足以讓一檔股票「看起來」是循環股。所以把景氣指標切成前後兩半，兩半各自都要
   beta ≥ 1.2、相關 ≥ 0.5，而且近 12 個月營收曾經從高點回落 25% 以上——沒真的衰退過的
   不叫循環。這是「嚴格」；只看全期的叫「寬鬆」。
4. **這一輪新跟上的**：前半段完全不跟景氣、後半段才高度同步的（台積電、欣興是典型）。
   比較像這一輪的主角，而不是傳統的循環股，獨立列出來，不混進名單。

## 循環位置

每一檔用兩個軸放進四格：

    營收距高峰（近 12 個月合計 vs 它自己的歷史最高）
    近 3 個月年增率（正在往上還是往下）

              距高峰 > -15%      距高峰 ≤ -15%
    年增 ≥ 0   高峰               復甦
    年增 < 0   退潮               谷底

## 不做的

- **股價**：這一頁只回答營收是不是循環的，股價有沒有跟著走、能不能拿來交易還沒有回測。
- 金融股：金控的月營收跟著投資損益大起大落，不是本業的景氣。
"""

from __future__ import annotations

import math
import statistics
from datetime import datetime

import twse
import valuation

OUT_PATH = twse.DATA_DIR / "cycle.json"

COMPLETE = 0.9        # 一個月要有最多那個月 9 成的公司公布，才算公布完（每月 10 日前才報齊）
MIN_REV = 50_000      # 月營收平均 ≥ 5000 萬（千元）。再小的公司單月一張訂單就是 ±50%
MISSING_REV = 8       # 營收最多缺幾個月
MISSING_YOY = 18      # 年增率最多缺幾個月（前兩個月本來就算不出 3 個月合計）
CLIP = 1.5            # log 年增夾在 ±1.5（約 -78% ～ +348%），一檔轉型股不該拉歪整條回歸
MIN_HALF = 24         # 每一半至少 24 個月

BETA = 1.2
CORR = 0.5
DRAWDOWN = 0.75       # 近 12 個月營收曾經掉到高點的 75% 以下
FRESH_CORR1 = 0.3     # 這一輪新跟上：前半段相關 < 0.3（或 beta < 0.6）
FRESH_BETA1 = 0.6
NEAR_PEAK = 0.85      # 近 12 個月營收在高點的 85% 以上算「接近高峰」
MIN_IND = 5           # 產業至少 5 檔才列


def load():
    """(月份清單, 營收 {代號: {月: 值}}, 去年同月營收 {代號: {月: 值}})。去年同月由年增率反推。"""
    files = sorted(valuation.REV_DIR.glob("*.json"))
    data = [(p.stem, twse.read_json(p) or {}) for p in files]
    most = max(len(d) for _, d in data)
    while data and len(data[-1][1]) < most * COMPLETE:   # 當月還沒公布完的那幾個月先不用
        data.pop()
    rev, ly = {}, {}
    for m, d in data:
        for code, row in d.items():
            v, y = row[0], row[1]
            if v is None or v <= 0:
                continue
            rev.setdefault(code, {})[m] = v
            if y is not None and y > -99.9:
                ly.setdefault(code, {})[m] = v / (1 + y / 100)
    return [m for m, _ in data], rev, ly


def window_sum(series: dict, months: list, i: int, n: int):
    vals = [series.get(m) for m in months[i - n + 1:i + 1]] if i >= n - 1 else [None]
    return None if any(v is None for v in vals) else sum(vals)


def fit(ys: list, xs: list):
    """(beta, 相關)。兩邊都有值的月份才算。"""
    pts = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None]
    if len(pts) < MIN_HALF:
        return None, None
    mx = statistics.fmean(p[0] for p in pts)
    my = statistics.fmean(p[1] for p in pts)
    sxy = sum((x - mx) * (y - my) for x, y in pts)
    sxx = sum((x - mx) ** 2 for x, _ in pts)
    syy = sum((y - my) ** 2 for _, y in pts)
    if not sxx or not syy:
        return None, None
    return sxy / sxx, sxy / math.sqrt(sxx * syy)


def passes(beta, corr):
    return beta is not None and corr is not None and beta >= BETA and corr >= CORR


def pct(logv, digits=1):
    return None if logv is None else round((math.exp(logv) - 1) * 100, digits)


def r2(v, digits=2):
    return None if v is None else round(v, digits)


def main():
    months, rev, ly = load()
    ind_map = twse.read_json(twse.DATA_DIR / "industry.json") or {}
    industry, names = ind_map.get("map") or {}, ind_map.get("names") or {}
    nm = len(months)

    yoy, ttm = {}, {}
    for code in rev:
        r, l = rev[code], ly.get(code, {})
        ys, ts = [], []
        for i in range(nm):
            a, b = window_sum(r, months, i, 3), window_sum(l, months, i, 3)
            ys.append(max(-CLIP, min(CLIP, math.log(a / b))) if a and b else None)
            t = window_sum(r, months, i, 12)
            ts.append(t)
        yoy[code], ttm[code] = ys, ts

    ok = [c for c in rev
          if industry.get(c) and "金融" not in industry[c]
          and len(rev[c]) >= nm - MISSING_REV
          and statistics.fmean(rev[c].values()) >= MIN_REV
          and sum(v is not None for v in yoy[c]) >= nm - MISSING_YOY]

    # 景氣：每個月的中位數，以及年增為正的公司佔幾成
    index, share = [], []
    for i in range(nm):
        vals = [yoy[c][i] for c in ok if yoy[c][i] is not None]
        index.append(statistics.median(vals) if len(vals) >= len(ok) / 2 else None)
        share.append(round(sum(v > 0 for v in vals) / len(vals) * 100) if vals and index[-1] is not None else None)
    first = next(i for i, v in enumerate(index) if v is not None)
    mid = first + (nm - first) // 2                    # 前後兩半的分界
    half1 = (first, mid)
    half2 = (mid, nm)

    def sl(xs, h):
        return xs[h[0]:h[1]]

    stocks = []
    for c in ok:
        ys = yoy[c]
        beta, corr = fit(ys, index)
        b1, c1 = fit(sl(ys, half1), sl(index, half1))
        b2, c2 = fit(sl(ys, half2), sl(index, half2))
        lt = [math.log(t) for t in ttm[c] if t]
        peak, dd = -math.inf, 0.0
        for v in lt:
            peak = max(peak, v)
            dd = min(dd, v - peak)
        last_ok = ttm[c][-1] is not None and ys[-1] is not None
        vp = lt[-1] - max(lt) if last_ok else None
        deep = dd <= math.log(DRAWDOWN)
        strict = passes(b1, c1) and passes(b2, c2) and deep
        loose = strict or (passes(beta, corr) and deep)
        fresh = (not strict and passes(b2, c2)
                 and c1 is not None and (c1 < FRESH_CORR1 or b1 < FRESH_BETA1))
        if last_ok:
            near = vp >= math.log(NEAR_PEAK)
            up = ys[-1] >= 0
            phase = ("peak" if up else "ebb") if near else ("recover" if up else "trough")
        else:
            phase = None
        stocks.append({
            "c": c, "n": names.get(c), "ind": industry[c],
            "rev": round(sum(rev[c].get(m, 0) for m in months[-12:]) / 1e5, 1),   # 近 12 個月營收（億）
            "beta": r2(beta), "corr": r2(corr), "b1": r2(b1), "c1": r2(c1), "b2": r2(b2), "c2": r2(c2),
            "dd": pct(dd), "vp": pct(vp), "yoy": pct(ys[-1]) if ys[-1] is not None else None,
            "phase": phase, "strict": strict, "loose": loose, "fresh": fresh,
            "_ys": ys, "_ts": ttm[c],
        })

    # 產業：成分股的中位數
    by_ind = {}
    for s in stocks:
        by_ind.setdefault(s["ind"], []).append(s)
    industries = []
    for ind, ss in by_ind.items():
        if len(ss) < MIN_IND:
            continue
        med = lambda k: statistics.median([s[k] for s in ss if s[k] is not None])  # noqa: E731
        row = {k: round(med(k), 2) for k in ("beta", "corr", "b1", "c1", "b2", "c2")}
        row["halves"] = passes(row["b1"], row["c1"]) + passes(row["b2"], row["c2"])
        row.update(ind=ind, n=len(ss), cyc=sum(s["strict"] for s in ss),
                   yoy=round(med("yoy"), 1))
        industries.append(row)
    industries.sort(key=lambda r: (-r["halves"], -r["beta"]))

    # 只有名單裡的股票帶走勢：嚴格、寬鬆、新跟上，三份的聯集
    out = []
    for s in stocks:
        ys, ts = s.pop("_ys"), s.pop("_ts")
        if s["loose"] or s["fresh"]:
            s["y"] = [pct(v, 0) for v in ys[first:]]
            top = max(t for t in ts if t)                 # 近 12 個月營收，以它自己的高點 = 100
            s["t"] = [None if t is None else round(t / top * 100) for t in ts[first:]]
            out.append(s)
    out.sort(key=lambda s: -(s["beta"] or 0))

    idx = index[first:]
    run = 0
    for k in range(len(idx) - 1, 0, -1):
        step = idx[k] - idx[k - 1]
        if run >= 0 and step > 0:
            run += 1
        elif run <= 0 and step < 0:
            run -= 1
        else:
            break

    payload = {
        "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "revMonth": months[-1],
        "months": months[first:],
        "split": months[mid],
        "sample": len(ok),
        "index": [pct(v) for v in idx],
        "share": share[first:],
        "run": run,
        "rules": {"beta": BETA, "corr": CORR, "drawdown": round((DRAWDOWN - 1) * 100),
                  "nearPeak": round((NEAR_PEAK - 1) * 100), "minRevWan": MIN_REV // 10,
                  "fresh1": FRESH_CORR1},
        "industries": industries,
        "stocks": out,
    }
    twse.write_json(OUT_PATH, payload)
    strict = sum(s["strict"] for s in out)
    print(f"景氣頁：營收 {months[-1]}，樣本 {len(ok)} 檔，嚴格 {strict} 檔、"
          f"寬鬆 {sum(s['loose'] for s in out)} 檔、新跟上 {sum(s['fresh'] for s in out)} 檔 -> {OUT_PATH}")


if __name__ == "__main__":
    main()
