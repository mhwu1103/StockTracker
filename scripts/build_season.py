"""景氣頁的「月曆」：照過去每年同一個月的表現，排出 1～12 月的買進與賣出清單。

    python scripts/build_season.py      -> docs/data/season.json

讀 `value/pe/<市場>/`（每月底收盤）、`exright/`（除權息，還原用）、`industry.json` 與
`value/rev/`（只拿來算營收規模）。

## 清單怎麼排

1. 月報酬 = 月底收盤 ÷ 上月底收盤，再除以當月除權息因子的乘積（含息報酬）。沒有還原的話，
   6～9 月的賣出清單會被高殖利率股塞滿——那是發股利，不是季節性。
2. 超額 = 減去當月全體普通股的中位數。比的是「這個月它比別人好還是差」，不是大盤漲跌。
3. 勝率有兩種基準，各排一份清單、各跑一次 walk-forward：
   - **贏大盤**（rel）：超額 > 0。每一年剛好一半的股票會贏，運氣基準是擲公平的銅板。
   - **自己漲跌**（abs）：含息月報酬 > 0。大盤好的那一年大部分股票都漲，所以運氣基準
     每一年各用當年上漲的比例（Poisson-binomial）。
   每一檔、每一個月份，把過去每一年的值排在一起：
   - **買進**：至少 6 年的紀錄、贏的年份 ≥ 8 成、中位數 > 0，依勝率排、同勝率比中位數
   - **賣出**：反過來，輸的年份 ≥ 8 成
   產業也照同樣的方式各排一份（產業成分股超額的中位數）。

## 這份清單沒通過檢驗，頁面上要照實寫

- **運氣基準**：一千多檔股票、每檔 7 年，就算股價完全隨機，7 年贏 6 年以上的機率也有 6%，
  每個月份都會「找到」上百檔。所以每個月份都附上「純靠運氣預期會有幾檔」。
- **walk-forward**：把「今天」換成過去每一年，只用那一年以前的資料照同一條規則挑，看那一年
  同一個月實際的超額（買進減賣出），以及挑出來的那幾檔那一年真的贏（漲）的比例。2026-10：
  贏大盤 +0.77%／月、t 1.06，買進清單下一年真的贏 52%（全體 50%）；自己漲跌 +0.52%／月、t 0.73，
  買進清單下一年真的漲 49%（全體 50%）。
  換參數會正負翻轉——**過去的月份規律延續不到下一年**。數字每次重算都會更新，前端照
  walk-forward 的結果寫結論，不寫死。
- 減資、分割沒有還原（除權息計算結果表不含）。月報酬超過 +300% 或低於 -60% 的直接丟掉。
"""

from __future__ import annotations

import math
import statistics
from datetime import datetime

import twse
import valuation

OUT_PATH = twse.DATA_DIR / "season.json"
EX_DIR = twse.DATA_DIR / "exright"

MIN_YEARS = 6         # 這個月份至少要有幾年的紀錄
HIT = 0.8             # 贏（或輸）的年份至少幾成
TOP = 40              # 每個月每一邊最多列幾檔
IND_TOP = 5           # 產業每一邊列幾個
MIN_IND = 5           # 產業當月至少幾檔才算
WF_FROM = 2021        # walk-forward 從哪一年開始測（前面至少要兩年可以挑）
WF_N = 20             # walk-forward 每一邊取幾檔
RET_LO, RET_HI = -0.6, 3.0


def load_close():
    """{代號: {月: 收盤}}，以及完整月份的清單（這個月還沒過完，不算）。"""
    this = twse.taipei_today().strftime("%Y-%m")
    close, months = {}, set()
    for mk in ("twse", "tpex"):
        for p in sorted((valuation.PE_DIR / mk).glob("*.json")):
            m = p.stem
            if m >= this:
                continue
            months.add(m)
            for code, v in ((twse.read_json(p) or {}).get("c") or {}).items():
                if len(code) == 4 and code.isdigit() and len(v) > 3 and v[3]:
                    close.setdefault(code, {})[m] = v[3]
    return close, sorted(months)


def load_factors():
    """{代號: {月: 當月除權息因子的乘積}}"""
    out = {}
    for p in sorted(EX_DIR.glob("*.json")):
        for code, events in (twse.read_json(p) or {}).items():
            for d, f in events:
                slot = out.setdefault(code, {})
                slot[d[:7]] = slot.get(d[:7], 1.0) * f
    return out


def rev_size():
    """近 12 個月營收（億），最新那幾個月還沒報齊的話照樣加，只是拿來分大小。"""
    files = sorted(valuation.REV_DIR.glob("*.json"))[-13:]
    tot = {}
    for p in files[-12:]:
        for code, row in (twse.read_json(p) or {}).items():
            if row[0]:
                tot[code] = tot.get(code, 0) + row[0]
    return {c: round(v / 1e5, 1) for c, v in tot.items()}


def tail(ps: list, k: int) -> float:
    """P(X ≥ k)，X 是各年「贏」的次數，每一年贏的機率各自是 ps[i]（Poisson-binomial）。"""
    dist = [1.0]
    for p in ps:
        nxt = [0.0] * (len(dist) + 1)
        for i, q in enumerate(dist):
            nxt[i] += q * (1 - p)
            nxt[i + 1] += q * p
        dist = nxt
    return sum(dist[k:])


def raw_stats(r: dict, mm: int, years: list) -> dict:
    xs = [r[f"{y}-{mm:02d}"] for y in years if f"{y}-{mm:02d}" in r]
    return {"up": sum(x > 0 for x in xs), "avg": round(statistics.fmean(xs) * 100, 1) if xs else None}


def pick(stats: dict, side: str, min_years: int):
    """stats: {代號: [超額...]}。回傳依強度排好的 [(代號, 中位數, 贏, 年數)]。"""
    out = []
    for c, xs in stats.items():
        n = len(xs)
        if n < min_years:
            continue
        win = sum(x > 0 for x in xs)
        med = statistics.median(xs)
        if side == "buy" and win >= HIT * n and med > 0:
            out.append((c, med, win, n))
        elif side == "sell" and n - win >= HIT * n and med < 0:
            out.append((c, med, win, n))
    # 勝率（贏或輸的年份比例）高的先，同勝率再比超額中位數。前端也照這個順序。
    out.sort(key=lambda r: (-(r[2] if side == "buy" else r[3] - r[2]) / r[3], -abs(r[1])))
    return out


def build_basis(key, series, p_win, ret, exc, med, avg, rm, years, industry, names, size):
    """一種勝率基準的 12 個月清單、產業與 walk-forward。series 是 {代號: {月: 值}}，值 > 0 算贏。"""

    def by_month(mm: int, ys=None):
        tag = f"-{mm:02d}"
        return {c: [s[f"{y}{tag}"] for y in (ys or years) if f"{y}{tag}" in s] for c, s in series.items()}

    # 產業：成分股的中位數
    ind_s = {}
    for m in rm:
        g = {}
        for c, s in series.items():
            if m in s:
                g.setdefault(industry[c], []).append(s[m])
        for k, xs in g.items():
            if len(xs) >= MIN_IND:
                ind_s.setdefault(k, {})[m] = statistics.median(xs)

    cal = []
    for mm in range(1, 13):
        st = by_month(mm)
        yrs = [y for y in years if f"{y}-{mm:02d}" in med]
        row = {"m": mm, "years": yrs}
        # 純靠運氣（每一年照當年的贏面擲銅板），每一邊預期有幾檔
        lb = ls = 0.0
        for c, s in series.items():
            ps = [p_win[f"{y}-{mm:02d}"] for y in yrs if f"{y}-{mm:02d}" in s]
            n = len(ps)
            if n >= MIN_YEARS:
                k = math.ceil(HIT * n)
                lb += tail(ps, k)
                ls += tail([1 - p for p in ps], k)
        row["luckBuy"], row["luckSell"] = round(lb), round(ls)
        for side in ("buy", "sell"):
            got = pick(st, side, MIN_YEARS)
            row[f"{side}N"] = len(got)
            row[side] = [{
                "c": c, "n": names.get(c), "ind": industry[c], "rev": size.get(c),
                "med": round(m_ * 100, 1), "win": w, "yrs": n,
                # 兩種勝率都帶：主欄顯示 basis 那一種，底下一行顯示另一種
                **raw_stats(ret[c], mm, yrs),
                "rw": sum(exc[c][f"{y}-{mm:02d}"] > 0 for y in yrs if f"{y}-{mm:02d}" in exc[c]),
                "y": {y: round(series[c][f"{y}-{mm:02d}"] * 100, 1) for y in yrs if f"{y}-{mm:02d}" in series[c]},
            } for c, m_, w, n in got[:TOP]]
        ist = {k: [s[f"{y}-{mm:02d}"] for y in years if f"{y}-{mm:02d}" in s] for k, s in ind_s.items()}
        irank = sorted(((statistics.fmean(xs), sum(x > 0 for x in xs), len(xs), k) for k, xs in ist.items()
                        if len(xs) >= MIN_YEARS), reverse=True)
        fmt = lambda r: {"ind": r[3], "avg": round(r[0] * 100, 2), "win": r[1], "yrs": r[2]}  # noqa: E731
        row["indUp"] = [fmt(r) for r in irank[:IND_TOP]]
        row["indDown"] = [fmt(r) for r in irank[::-1][:IND_TOP]]
        cal.append(row)

    # walk-forward：只用那一年以前的資料挑，看那一年同一個月
    wf, wf_month = [], {mm: [] for mm in range(1, 13)}
    for y in years:
        if int(y) < WF_FROM:
            continue
        train = [t for t in years if t < y]
        for mm in range(1, 13):
            m = f"{y}-{mm:02d}"
            if m not in med:
                continue
            st = by_month(mm, train)
            need = min(MIN_YEARS, len(train))
            b = [r[0] for r in pick(st, "buy", need) if m in ret[r[0]]][:WF_N]
            s = [r[0] for r in pick(st, "sell", need) if m in ret[r[0]]][:WF_N]
            if len(b) < 5 or len(s) < 5:
                continue
            wf.append({
                "buy": statistics.fmean(ret[c][m] for c in b) - avg[m],
                "sell": statistics.fmean(ret[c][m] for c in s) - avg[m],
                # 挑出來的那幾檔，那一年真的贏（或漲）的比例，對照全體
                "buyHit": statistics.fmean(series[c][m] > 0 for c in b),
                "sellHit": statistics.fmean(series[c][m] <= 0 for c in s),
                "allHit": p_win[m],
                "m": m,
            })
            wf_month[mm].append(wf[-1]["buy"] - wf[-1]["sell"])
    spread = [w["buy"] - w["sell"] for w in wf]
    mu = statistics.fmean(spread)
    sd = statistics.stdev(spread)
    mean = lambda k: statistics.fmean(w[k] for w in wf)  # noqa: E731
    walk = {
        "n": len(wf), "from": wf[0]["m"] if wf else None,
        "buy": round(mean("buy") * 100, 2), "sell": round(mean("sell") * 100, 2),
        "spread": round(mu * 100, 2), "t": round(mu / (sd / math.sqrt(len(spread))), 2),
        "win": round(sum(x > 0 for x in spread) / len(spread) * 100),
        "buyHit": round(mean("buyHit") * 100), "sellHit": round(mean("sellHit") * 100),
        "allHit": round(mean("allHit") * 100),
        "byMonth": {mm: (round(statistics.fmean(v) * 100, 2) if v else None) for mm, v in wf_month.items()},
        "byMonthN": {mm: len(v) for mm, v in wf_month.items()},
    }
    return {"walk": walk, "months": cal}


def total_returns(industry: dict):
    """含息月報酬 {代號: {月: 報酬}} 與報酬的月份清單。景氣頁的「適合買進月份」也用這一支。"""
    close, months = load_close()
    fac = load_factors()
    ret = {}
    for code, s in close.items():
        if not industry.get(code):
            continue
        f = fac.get(code, {})
        for a, b in zip(months, months[1:]):
            if a in s and b in s:
                r = s[b] / s[a] / f.get(b, 1.0) - 1
                if RET_LO < r < RET_HI:
                    ret.setdefault(code, {})[b] = r
    return ret, months[1:]


def main():
    ind_map = twse.read_json(twse.DATA_DIR / "industry.json") or {}
    industry, names = ind_map.get("map") or {}, ind_map.get("names") or {}
    size = rev_size()

    # 含息月報酬與超額
    ret, rm = total_returns(industry)
    med = {m: statistics.median([ret[c][m] for c in ret if m in ret[c]]) for m in rm}
    avg = {m: statistics.fmean([ret[c][m] for c in ret if m in ret[c]]) for m in rm}
    exc = {c: {m: r - med[m] for m, r in s.items()} for c, s in ret.items()}
    years = sorted({m[:4] for m in rm})

    # 兩種勝率基準：
    #   rel  贏大盤：減去當月全市場中位數之後 > 0（每一年剛好一半的股票會贏）
    #   abs  自己漲跌：含息月報酬 > 0（大盤好的那一年大部分股票都漲，所以「贏」的機率每年不同）
    up_share = {m: sum(ret[c][m] > 0 for c in ret if m in ret[c]) / sum(m in ret[c] for c in ret) for m in rm}
    bases = {"rel": (exc, {m: 0.5 for m in rm}), "abs": (ret, up_share)}
    out = {key: build_basis(key, series, p_win, ret, exc, med, avg, rm, years, industry, names, size)
           for key, (series, p_win) in bases.items()}

    payload = {
        "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "from": rm[0], "to": rm[-1], "years": years,
        "sample": len(exc),
        "rules": {"minYears": MIN_YEARS, "hit": HIT, "wfN": WF_N, "top": TOP},
        "upShare": {mm: round(statistics.fmean(up_share[m] for m in rm if m.endswith(f"-{mm:02d}")) * 100)
                    for mm in range(1, 13)},
        "bases": out,
    }
    twse.write_json(OUT_PATH, payload)
    for key, label in (("rel", "贏大盤"), ("abs", "自己漲跌")):
        w = out[key]["walk"]
        print(f"月曆［{label}］：walk-forward 買減賣 {w['spread']:+.2f}%／月（t {w['t']}，{w['n']} 個月），"
              f"買進清單下一年真的{'贏' if key == 'rel' else '漲'}的比例 {w['buyHit']}%（全體 {w['allHit']}%）")
    print(f"  {rm[0]} ~ {rm[-1]}，{len(exc)} 檔 -> {OUT_PATH}")


if __name__ == "__main__":
    main()
