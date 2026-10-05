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

## 新循環從哪一族開始

頁面最上面那一張。每個族群算**轉正廣度**：成分股裡，近 3 個月營收年增「剛由負轉正」的比例
（現在 > 0、前三個月裡最低 ≤ 0）。廣度最高的族群，就是新一輪循環正在那裡起頭的地方。

為什麼不用「族群年增率的中位數剛轉正」：試過，官方產業 3 個月只贏 +0.2%（t 0.2），前後兩半正負
相反；「中位數還是負的、但在回升」（即將轉正）也沒有用。廣度才有用——每個月取廣度前 3 名的官方產業
減後 3 名，之後 3 個月 +3.2%（t 2.5），前後兩半 +3.2%／+3.1%（2026-10）。這個檢驗每次重算都會重跑，
結果在 `groupWalk`，前端照它寫。

**股價**：做波段，股價比營收早。單看族群股價動能（月頻）沒有用——近 3 個月漲最多的 3 個官方產業
減最少的 3 個，之後 3 個月 +1.0%（t 0.6）；站上季線的比例也一樣。但跟營收合在一起有用：轉正廣度的
名次加上股價近 3 個月漲幅的名次，之後 1 個月 +1.4%（t 2.6），比只看營收的 +0.8%（t 1.9）好，前後兩半
都是正的。所以頁面的排名用這個綜合分數，另外補近 5／20 日漲跌與站上月線的比例給波段看。測了九種組合
挑最好的，有一點選擇偏誤；但「營收轉好、股價開始確認」是先想好的組合，不是翻出來的。

族群有兩種：官方產業（檢驗用這個，沒有偏誤）與題材子族群（`themes.json`，比較貼近「族群」的說法，
但名單是今天挑的、只收進過成交值前 200 大的，回測會高估，所以只當參考）。

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
GROUP_MIN = 5         # 族群至少幾檔有年增率才排（題材子族群 4 檔）
GROUP_TOP = 3         # 檢驗：每個月前 3 名減後 3 名
PRICE_DAYS = 63       # 股價的「近 3 個月」＝ 63 個交易日
GROUP_SHOW = 6        # 頁面上列前幾個族群


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


def official_groups(industry: dict) -> dict:
    g = {}
    for c, k in industry.items():
        if "金融" not in k:
            g.setdefault(k, []).append(c)
    return g


def theme_groups() -> dict:
    t = twse.read_json(twse.DATA_DIR / "themes.json") or {}
    return {f"{gr['name']}／{s['name']}": s["codes"] for gr in t.get("groups") or [] for s in gr.get("subs") or []}


def turned(ys: list, i: int) -> bool:
    """第 i 個月：近 3 個月營收年增 > 0，而且前三個月裡最低 ≤ 0（剛由負轉正）。"""
    if i < 3 or ys[i] is None or ys[i] <= 0:
        return False
    prev = [v for v in ys[i - 3:i] if v is not None]
    return bool(prev) and min(prev) <= 0


def breadth(codes: list, yoy: dict, i: int, min_n: int):
    """(轉正比例, 有年增率的檔數, 剛轉正的代號)；檔數不夠回 None。"""
    cs = [c for c in codes if c in yoy and yoy[c][i] is not None]
    if len(cs) < min_n:
        return None
    hit = [c for c in cs if turned(yoy[c], i)]
    return len(hit) / len(cs), len(cs), hit


def group_turns(groups: dict, yoy: dict, months: list, names: dict, min_n: int) -> list:
    """最新一個月，每個族群的轉正廣度，由高到低。"""
    i = len(months) - 1
    rows = []
    for g, codes in groups.items():
        b = breadth(codes, yoy, i, min_n)
        if not b:
            continue
        share, n, hit = b
        cs = [c for c in codes if c in yoy and yoy[c][i] is not None]
        med = statistics.median(yoy[c][i] for c in cs)
        prev = [yoy[c][i - 3] for c in cs if yoy[c][i - 3] is not None]
        rows.append({
            "g": g, "n": n, "k": len(hit), "b": round(share * 100),
            "yoy": pct(med), "yoy3": pct(statistics.median(prev)) if prev else None,
            "up": round(sum(yoy[c][i] > 0 for c in cs) / n * 100),
            "hit": sorted(({"c": c, "n": names.get(c), "yoy": pct(yoy[c][i])} for c in hit),
                          key=lambda r: -(r["yoy"] or 0)),
        })
    rows.sort(key=lambda r: (-r["b"], -r["k"]))
    return rows


def rank_pct(vals: list) -> list:
    """每個值在這一群裡的百分位（0～1，同值取平均名次）。"""
    order = sorted(range(len(vals)), key=lambda k: vals[k])
    out = [0.0] * len(vals)
    k = 0
    while k < len(order):
        j = k
        while j + 1 < len(order) and vals[order[j + 1]] == vals[order[k]]:
            j += 1
        for q in range(k, j + 1):
            out[order[q]] = ((k + j) / 2 + 1) / len(vals)
        k = j + 1
    return out


def group_backtest(groups: dict, yoy: dict, months: list, ret: dict, rm: list, min_n: int) -> dict:
    """每個月底（營收用到上個月、股價用到當月底）把族群排名，取前 GROUP_TOP 名減後 GROUP_TOP 名，
    看成分股之後 1／3 個月的含息報酬（減全體平均）。兩種排名各算一次：
      rev    只看營收轉正廣度
      combo  轉正廣度的名次 ＋ 股價近 3 個月漲幅的名次（各自是百分位，相加）
    """
    idx = {m: k for k, m in enumerate(months)}
    out = {}
    rows_by_t = []
    for j, t in enumerate(rm):
        y, mo = int(t[:4]), int(t[5:])
        prev = f"{y - (mo == 1)}-{(mo - 2) % 12 + 1:02d}"       # t 月底看得到的是 t-1 月的營收
        if prev not in idx or j < 2 or j + 1 >= len(rm):
            continue
        i = idx[prev]
        back = rm[j - 2:j + 1]                                  # 到 t 月底為止的 3 個月
        fwd = {}
        for h in (1, 3):
            ahead = rm[j + 1:j + 1 + h]
            if len(ahead) < h:
                continue
            got = {c: math.prod(1 + r[m] for m in ahead) - 1 for c, r in ret.items() if all(m in r for m in ahead)}
            if got:
                mean = statistics.fmean(got.values())
                fwd[h] = {c: v - mean for c, v in got.items()}
        rows = []
        for g, codes in groups.items():
            b = breadth(codes, yoy, i, min_n)
            past = [math.prod(1 + ret[c][m] for m in back) - 1 for c in codes if c in ret and all(m in ret[c] for m in back)]
            if not b or len(past) < min_n:
                continue
            f = {h: [fv[c] for c in codes if c in fv] for h, fv in fwd.items()}
            rows.append({"rb": b[0], "m3": statistics.fmean(past),
                         **{f"f{h}": statistics.fmean(v) for h, v in f.items() if len(v) >= min_n}})
        if len(rows) < 2 * GROUP_TOP:
            continue
        r1, r2 = rank_pct([r["rb"] for r in rows]), rank_pct([r["m3"] for r in rows])
        for r, a1, a2 in zip(rows, r1, r2):
            r["combo"] = a1 + a2
            r["rev"] = r["rb"]
        rows_by_t.append((t, rows))

    for key in ("rev", "combo"):
        for h in (1, 3):
            sp = []
            for t, rows in rows_by_t:
                rr = sorted((r for r in rows if f"f{h}" in r), key=lambda r: r[key])
                if len(rr) < 2 * GROUP_TOP:
                    continue
                top = statistics.fmean(r[f"f{h}"] for r in rr[-GROUP_TOP:])
                bot = statistics.fmean(r[f"f{h}"] for r in rr[:GROUP_TOP])
                sp.append((t, top - bot))
            if len(sp) < 12:
                continue
            xs = [v for _, v in sp]
            mu, sd = statistics.fmean(xs), statistics.stdev(xs)
            half = len(xs) // 2
            out[f"{key}{h}"] = {
                "n": len(xs), "from": sp[0][0], "to": sp[-1][0], "h": h, "k": GROUP_TOP,
                "spread": round(mu * 100, 2),
                "t": round(mu / (sd / math.sqrt(len(xs))) / math.sqrt(h), 2),   # 持有期重疊，粗略除以 √h
                "win": round(sum(x > 0 for x in xs) / len(xs) * 100),
                "h1": round(statistics.fmean(xs[:half]) * 100, 2), "h2": round(statistics.fmean(xs[half:]) * 100, 2),
            }
    return out


def daily_prices(n: int):
    """最近 n 個交易日的收盤 {代號: {日: 收盤}}，與除權息事件 {代號: [(日, 因子)]}。"""
    dates = sorted(set(twse.existing_close_dates("twse")) | set(twse.existing_close_dates("tpex")))[-n:]
    px = {}
    for d in dates:
        for mk in ("twse", "tpex"):
            for c, v in ((twse.read_json(twse.close_path(d, mk)) or {}).get("c") or {}).items():
                if v:
                    px.setdefault(c, {})[d] = v
    ev = {}
    for p in sorted(build_season.EX_DIR.glob("*.json")):
        for c, events in (twse.read_json(p) or {}).items():
            ev.setdefault(c, []).extend((d, f) for d, f in events if d > dates[0])
    return dates, px, ev


def adj_change(c: str, d0: str, d1: str, px: dict, ev: dict):
    """d0 收盤到 d1 收盤的含息漲跌（除以中間的除權息因子）。"""
    p = px.get(c, {})
    if d0 not in p or d1 not in p:
        return None
    f = math.prod(x for d, x in ev.get(c, []) if d0 < d <= d1)
    return p[d1] / p[d0] / f - 1


def group_prices(groups: dict, rows: list, names: dict) -> None:
    """把股價那幾欄補進 group_turns 的每一列，並照「營收廣度名次 ＋ 股價 3 個月名次」重排。
    3 個月 = 63 個交易日，跟檢驗用的月底 3 個月是同一件事，只是用到最新一天。"""
    dates, px, ev = daily_prices(PRICE_DAYS + 1)
    last = dates[-1]
    at = lambda k: dates[-1 - k] if len(dates) > k else None  # noqa: E731
    for r in rows:
        codes = groups[r["g"]]
        for key, k in (("m3", PRICE_DAYS), ("d20", 20), ("d5", 5)):
            vals = [v for c in codes if (v := adj_change(c, at(k), last, px, ev)) is not None]
            r[key] = round(statistics.fmean(vals) * 100, 1) if len(vals) >= 3 else None
        above = []
        for c in codes:
            p = px.get(c, {})
            closes = [p[d] for d in dates[-20:] if d in p]
            if len(closes) == 20:
                above.append(closes[-1] > statistics.fmean(closes))
        r["ma20"] = round(sum(above) / len(above) * 100) if above else None
        for h in r["hit"]:
            v = adj_change(h["c"], at(20), last, px, ev)
            h["d20"] = None if v is None else round(v * 100, 1)
    ok = [r for r in rows if r["m3"] is not None]
    for r, a1, a2 in zip(ok, rank_pct([r["b"] for r in ok]), rank_pct([r["m3"] for r in ok])):
        r["score"] = round((a1 + a2) * 50)                       # 0～100
    rows.sort(key=lambda r: (-(r.get("score") or 0), -r["b"]))
    return last


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
    turns = {k: group_turns(g, yoy, months, names, GROUP_MIN if k == "ind" else GROUP_MIN - 1) for k, g in groups.items()}
    price_day = None
    for k, g in groups.items():
        price_day = group_prices(g, turns[k], names)
    group_walk = {k: group_backtest(g, yoy, months, ret, rm, GROUP_MIN if k == "ind" else GROUP_MIN - 1)
                  for k, g in groups.items()}

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
        "groups": turns,
        "groupWalk": group_walk,
        "priceDay": price_day,
    }
    twse.write_json(OUT_PATH, payload)
    strict = sum(s["strict"] for s in out)
    print(f"景氣頁：營收 {months[-1]}，樣本 {len(ok)} 檔，嚴格 {strict} 檔、"
          f"寬鬆 {sum(s['loose'] for s in out)} 檔、新跟上 {sum(s['fresh'] for s in out)} 檔 -> {OUT_PATH}")


if __name__ == "__main__":
    main()
