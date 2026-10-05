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

## 旺季與淡季

每一檔：月營收 ÷ 以那個月為中心的 2×12 移動平均（拿掉趨勢與景氣循環，剩下季節），同一個曆月份
取各年的中位數＝季節因子。族群＝成分股季節因子的中位數。**一致性**＝每一年族群成分股比值的中位數
> 1 的年份比例。季節因子 ≥ +5% 而且一致性 ≥ 70% 標成旺季，≤ −5% 而且一致性 ≤ 30% 標成淡季。

2 月幾乎每一族都是淡季（農曆年工作天少），所以另外給一份「扣掉全市場同月」的版本，看得出各族自己的季節。

旺季前布局沒有用：每一年只用以前的資料算季節因子（扣掉全市場），每個月底買下個月季節因子最高的 3 族、
避開最低的 3 族，之後 1 個月 −0.06%（t −0.1），前後兩半 −1.3%／+1.1%（2026-10，2023 起）。季節大家都知道，股價早就反映。
這張時間軸是拿來讀營收的——旺季的營收成長要打折、淡季的衰退不必緊張——不是進場訊號。檢驗結果在
`seasonWalk`，每次重算都會更新。

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

import build_season
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
MONTH_YEARS = 6       # 適合買進的月份：那個月至少要有 6 年的紀錄
GROUP_MIN = 5         # 族群至少幾檔才算季節（題材子族群 4 檔）
GROUP_TOP = 3         # 旺季前布局的檢驗：每個月前 3 族減後 3 族
SEASON_HI = 0.05      # 季節因子 ≥ +5% 算旺季
SEASON_CONS = 0.7     # 而且 ≥ 7 成的年份那個月高於平均（淡季反過來：≤ 3 成）
SEASON_MIN_YEARS = 3  # 每一檔每一個曆月份至少要有 3 年的比值


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


def best_month(r: dict, years: list):
    """過去每年同一個月「自己含息上漲」的勝率最高的月份；同勝率比平均漲幅。
    回傳 (月, [[漲的年數, 年數, 平均%] × 12])；紀錄不滿 MONTH_YEARS 年的月份不參加。"""
    stats, best, key = [], None, None
    for mm in range(1, 13):
        xs = [r[f"{y}-{mm:02d}"] for y in years if f"{y}-{mm:02d}" in r]
        up = sum(x > 0 for x in xs)
        avg = statistics.fmean(xs) if xs else None
        stats.append([up, len(xs), None if avg is None else round(avg * 100, 1)])
        if len(xs) >= MONTH_YEARS:
            k = (up / len(xs), avg)
            if key is None or k > key:
                best, key = mm, k
    return best, stats


def add_buy_months(stocks: list, ret: dict, rm: list) -> dict:
    """每一檔加上 bm（適合買進的月份）與 mon（12 個月的勝率），並做 walk-forward：
    只用那一年以前的資料挑最好的月份，看那一年它在那個月的報酬，是不是比它自己其餘月份的平均好。"""
    years = sorted({m[:4] for m in rm})
    diffs, hits = [], []
    for s in stocks:
        r = ret.get(s["c"], {})
        s["bm"], s["mon"] = best_month(r, years)
        if not s["strict"] and not s["loose"]:
            continue                                   # 檢驗只算循環股
        for y in years:
            train = [t for t in years if t < y]
            if len(train) < 2:
                continue
            bm, _ = best_month(r, train) if len(train) >= MONTH_YEARS else _best_short(r, train)
            mine = f"{y}-{bm:02d}" if bm else None
            rest = [r[f"{y}-{mm:02d}"] for mm in range(1, 13) if mm != bm and f"{y}-{mm:02d}" in r]
            if not mine or mine not in r or len(rest) < 6:
                continue
            d = r[mine] - statistics.fmean(rest)
            diffs.append(d)
            hits.append(d > 0)
    if len(diffs) < 30:
        return {}
    mu, sd = statistics.fmean(diffs), statistics.stdev(diffs)
    return {"n": len(diffs), "diff": round(mu * 100, 2), "t": round(mu / (sd / math.sqrt(len(diffs))), 2),
            "hit": round(sum(hits) / len(hits) * 100)}


def _best_short(r: dict, train: list):
    """walk-forward 前幾年訓練期不滿 MONTH_YEARS 年時，放寬到至少 2 年。"""
    best, key = None, None
    for mm in range(1, 13):
        xs = [r[f"{y}-{mm:02d}"] for y in train if f"{y}-{mm:02d}" in r]
        if len(xs) >= 2:
            k = (sum(x > 0 for x in xs) / len(xs), statistics.fmean(xs))
            if key is None or k > key:
                best, key = mm, k
    return best, None


def season_ratios(rev: dict, months: list, codes: list) -> dict:
    """{代號: {月: 營收 ÷ 中心 2×12 移動平均}}。前後各 6 個月不夠的月份沒有比值。"""
    n = len(months)
    out = {}
    for c in codes:
        r = rev[c]
        vals = [r.get(m) for m in months]
        got = {}
        for i in range(6, n - 6):
            win = vals[i - 6:i + 7]
            if vals[i] is None or any(v is None for v in win):
                continue
            cma = (sum(win[:12]) / 12 + sum(win[1:]) / 12) / 2
            got[months[i]] = vals[i] / cma
        out[c] = got
    return out


def season_factors(ratios: dict, codes: list, years: set | None = None) -> dict:
    """{代號: [12 個曆月份的季節因子或 None]}。years 給的話只用那幾年（walk-forward）。"""
    out = {}
    for c in codes:
        by = {}
        for m, v in ratios.get(c, {}).items():
            if years is None or m[:4] in years:
                by.setdefault(int(m[5:]), []).append(v)
        f = [statistics.median(by[mm]) if len(by.get(mm, [])) >= SEASON_MIN_YEARS else None for mm in range(1, 13)]
        if sum(v is not None for v in f) == 12:
            out[c] = f
    return out


def season_groups(groups: dict, ratios: dict, fac: dict, min_n: int) -> dict:
    """每一族 12 個月的季節因子（原始與扣掉全市場）、一致性與旺淡季。"""
    market = [statistics.median(f[mm] for f in fac.values()) for mm in range(12)]
    # 每一年每一月：全市場比值的中位數（扣掉全市場的一致性要用）
    mk_year = {}
    for c, r in ratios.items():
        if c in fac:
            for m, v in r.items():
                mk_year.setdefault(m, []).append(v)
    mk_year = {m: statistics.median(v) for m, v in mk_year.items()}
    rows = []
    for g, codes in groups.items():
        cs = [c for c in codes if c in fac]
        if len(cs) < min_n:
            continue
        raw = [statistics.median(fac[c][mm] for c in cs) for mm in range(12)]
        per = {}
        for c in cs:
            for m, v in ratios[c].items():
                per.setdefault(m, []).append(v)
        cons_raw, cons_rel = [], []
        for mm in range(1, 13):
            ms = [m for m in per if int(m[5:]) == mm and len(per[m]) >= min_n]
            meds = [(statistics.median(per[m]), mk_year[m]) for m in ms]
            cons_raw.append(round(sum(a > 1 for a, _ in meds) / len(meds) * 100) if meds else None)
            cons_rel.append(round(sum(a > b for a, b in meds) / len(meds) * 100) if meds else None)
        rel = [raw[k] - market[k] + 1 for k in range(12)]

        def tag(f, cons):
            out = []
            for k in range(12):
                if cons[k] is None:
                    out.append(0)
                elif f[k] - 1 >= SEASON_HI and cons[k] >= SEASON_CONS * 100:
                    out.append(1)
                elif f[k] - 1 <= -SEASON_HI and cons[k] <= (1 - SEASON_CONS) * 100:
                    out.append(-1)
                else:
                    out.append(0)
            return out

        rows.append({
            "g": g, "n": len(cs),
            "raw": [round((v - 1) * 100, 1) for v in raw], "rel": [round((v - 1) * 100, 1) for v in rel],
            "cr": cons_raw, "cl": cons_rel,
            "tr": tag(raw, cons_raw), "tl": tag(rel, cons_rel),
            "yrs": min(sum(1 for m in per if int(m[5:]) == mm) for mm in range(1, 13)),
        })
    return {"market": [round((v - 1) * 100, 1) for v in market], "rows": rows}


def season_walk(groups: dict, ratios: dict, codes: list, ret: dict, rm: list, min_n: int) -> dict:
    """旺季前布局：t 月底，只用 t 年以前的比值算各族的季節因子（扣掉全市場），
    買下個月因子最高的 GROUP_TOP 族、避開最低的，之後 1 個月含息報酬（減全體平均）。"""
    years = sorted({m[:4] for r in ratios.values() for m in r})
    sp = []
    for Y in years:
        train = {y for y in years if y < Y}
        if len(train) < 2:
            continue
        fac = season_factors(ratios, codes, train)
        if len(fac) < 50:
            continue
        market = [statistics.median(f[mm] for f in fac.values()) for mm in range(12)]
        gf = {}
        for g, cs in groups.items():
            cs = [c for c in cs if c in fac]
            if len(cs) >= min_n:
                gf[g] = [statistics.median(fac[c][mm] for c in cs) - market[mm] for mm in range(12)]
        for j, t in enumerate(rm):
            if t[:4] != Y or j + 1 >= len(rm):
                continue
            nxt = int(t[5:]) % 12                       # 下個月的 index（0～11）
            ahead = rm[j + 1]
            got = {c: r[ahead] for c, r in ret.items() if ahead in r}
            mean = statistics.fmean(got.values())
            sc = []
            for g, f in gf.items():
                xs = [got[c] - mean for c in groups[g] if c in got]
                if len(xs) >= min_n:
                    sc.append((f[nxt], statistics.fmean(xs)))
            if len(sc) < 2 * GROUP_TOP:
                continue
            sc.sort(key=lambda r: r[0])
            sp.append((t, statistics.fmean(x for _, x in sc[-GROUP_TOP:]) - statistics.fmean(x for _, x in sc[:GROUP_TOP])))
    if len(sp) < 12:
        return {}
    xs = [v for _, v in sp]
    mu, sd = statistics.fmean(xs), statistics.stdev(xs)
    half = len(xs) // 2
    return {"n": len(xs), "from": sp[0][0], "spread": round(mu * 100, 2),
            "t": round(mu / (sd / math.sqrt(len(xs))), 2), "win": round(sum(x > 0 for x in xs) / len(xs) * 100),
            "h1": round(statistics.fmean(xs[:half]) * 100, 2), "h2": round(statistics.fmean(xs[half:]) * 100, 2)}


def official_groups(industry: dict) -> dict:
    g = {}
    for c, k in industry.items():
        if "金融" not in k:
            g.setdefault(k, []).append(c)
    return g


def theme_groups() -> dict:
    t = twse.read_json(twse.DATA_DIR / "themes.json") or {}
    return {f"{gr['name']}／{s['name']}": s["codes"] for gr in t.get("groups") or [] for s in gr.get("subs") or []}


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

    ret, rm = build_season.total_returns(industry)
    best_walk = add_buy_months(out, ret, rm)
    groups = {"ind": official_groups(industry), "theme": theme_groups()}
    ratios = season_ratios(rev, months, ok)
    sfac = season_factors(ratios, ok)
    seasons = {k: season_groups(g, ratios, sfac, GROUP_MIN if k == "ind" else GROUP_MIN - 1) for k, g in groups.items()}
    season_wf = season_walk(groups["ind"], ratios, ok, ret, rm, GROUP_MIN)

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
        "bestWalk": best_walk,
        "seasons": seasons,
        "seasonWalk": season_wf,
        "seasonRules": {"hi": round(SEASON_HI * 100), "cons": round(SEASON_CONS * 100)},
    }
    twse.write_json(OUT_PATH, payload)
    strict = sum(s["strict"] for s in out)
    print(f"景氣頁：營收 {months[-1]}，樣本 {len(ok)} 檔，嚴格 {strict} 檔、"
          f"寬鬆 {sum(s['loose'] for s in out)} 檔、新跟上 {sum(s['fresh'] for s in out)} 檔 -> {OUT_PATH}")


if __name__ == "__main__":
    main()
