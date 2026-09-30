"""價值頁的回測：過去每個月底，照這一頁的規則判出來的「便宜／昂貴」，之後真的比較會漲嗎？

    python scripts/build_value_backtest.py      -> docs/data/value_backtest.json

規則照搬 build_value.py（同一個 band()、level()、同一組門檻），只是把「今天」換成過去的
每一個月底，然後看之後 3／6／12 個月的報酬。

## 不偷看未來

回測最容易錯、而且錯了看不出來的，是用到那個時間點還不知道的資料。這裡的三條：

- **本益比區間只用那個月底以前的樣本**：band() 吃的是截到 t 的序列，不是整段五年。
- **月營收晚一個月**：t 月的營收要到 t+1 月 10 日才公布，所以在 t 月底，「近三月營收」
  是 t−1、t−2、t−3 三個月。直接用 t 月的話，每一筆都偷看了十天後的數字。
- **範圍是全市場，不是 themes.json**：題材清單是今天才整理的，裡面自然偏向這兩年漲起來的
  AI 族群；拿它回測等於先挑了贏家再問贏家有沒有贏。這裡用 t 月底有本益比資料的所有普通股。

## 報酬怎麼算

    報酬 = t+h 月底收盤 ÷ t 月底收盤 − 1 + t 月底的殖利率 × h / 12

收盤價沒有還原權息。現金股利用當時的殖利率補回來（假設一年配一次、平均攤在持有期間）；
**股票股利與分割補不回來**，配股多的（金融股、部分營建）與分割的（緯穎）會被算成下跌。
所以只看中位數，不看平均數——幾檔分割不會拉動中位數，卻能把平均數拉走一大截。

## 比什麼

每一組跟「同一個月底、全市場所有普通股的報酬中位數」比（等權的市場）。不跟加權指數比：
加權指數是市值加權而且不含股利，跟這裡「等權、含現金股利」的算法不是同一把尺。

## 樣本的限制

- 本益比從 2021-09 起，區間要滿三年才評價，所以第一個可評價的月底約在 2024 年初。
  12 個月的報酬只有一年多的起點，而且整段幾乎都是 AI 多頭——**多頭裡「便宜」可能輸，
  空頭裡才看得出它的保護力**，這一段資料回答不了後者。
- 每個月都重新判一次、持有期又重疊，同一檔會連續好幾個月被算進同一組。樣本數是
  「檔 × 月」，不是獨立的次數，看起來比實際上可靠。
- 下市、合併的公司在 t+h 沒有價格，會被排除：存活者偏誤，每一組都偏高一點。
"""

from __future__ import annotations

import statistics
import sys
from collections import defaultdict
from datetime import datetime

import build_value as bv
import twse
import valuation

OUT_PATH = twse.DATA_DIR / "value_backtest.json"
HORIZONS = (3, 6, 12)
REV_LAG = 1                  # t 月底看得到的最新營收是 t−1 月

# 要回報的組。trap／solid 是把便宜與相對便宜再依業績切開，驗證「便宜的前提是業績沒問題」。
GROUPS = ("cheap", "below", "above", "pricey", "solid", "trap", "digest")


def month_index(months: list, m: str) -> int:
    return months.index(m)


def load():
    """{代號: {月份: [本益比, 殖利率, 股淨比, 收盤]}}、全部月份（由舊到新）、營收 {月份: {代號: 年增率}}。"""
    table = defaultdict(dict)
    months = set()
    for market in valuation.MARKETS:
        folder = valuation.PE_DIR / market
        for path in sorted(folder.glob("*.json")):
            payload = twse.read_json(path)
            months.add(path.stem)
            for code, vals in payload["c"].items():
                if len(vals) >= 4:
                    table[code][path.stem] = vals
    rev = {}
    for path in sorted(valuation.REV_DIR.glob("*.json")):
        rev[path.stem] = {c: v[1] for c, v in twse.read_json(path).items()}
    return table, sorted(months), rev


def prev_months(months_all: list, m: str, n: int, lag: int) -> list:
    """m 往前 lag 個月開始、連續 n 個月的月份字串（不管那些月份有沒有本益比檔）。"""
    y, mo = int(m[:4]), int(m[5:])
    out = []
    for k in range(lag, lag + n):
        yy, mm = y, mo - k
        while mm <= 0:
            yy, mm = yy - 1, mm + 12
        out.append(f"{yy}-{mm:02d}")
    return out


def summarize(rows: list) -> dict:
    """rows: [(報酬, 超額)] -> 中位數、上漲比例、贏市場比例。"""
    if not rows:
        return {"n": 0}
    rets = [r for r, _ in rows]
    ex = [e for _, e in rows]
    return {
        "n": len(rows),
        "med": round(statistics.median(rets), 2),
        "medEx": round(statistics.median(ex), 2),
        "up": round(sum(1 for r in rets if r > 0) / len(rets) * 100, 1),
        "beat": round(sum(1 for e in ex if e > 0) / len(ex) * 100, 1),
    }


def main() -> int:
    table, months, rev = load()
    if not months:
        print("! value/pe/ 是空的，先跑 fetch_value.py 回補")
        return 1
    industry = (twse.read_json(twse.DATA_DIR / "industry.json") or {}).get("map") or {}

    # 每一檔的本益比序列（給 band 用），跟 build_value 同一套清理
    series = {code: [(m, (v[0] if v[0] and 0 < v[0] <= bv.PE_MAX else None)) for m, v in sorted(by_m.items())]
              for code, by_m in table.items()}

    buckets = {h: defaultdict(list) for h in HORIZONS}          # h -> 組 -> [(報酬, 超額)]
    by_year = {h: defaultdict(lambda: defaultdict(list)) for h in HORIZONS}
    periods = {h: [] for h in HORIZONS}
    first_rated = None

    common = [c for c in table if not c.startswith("00") and c[:4].isdigit()]   # 只看普通股
    for i, t in enumerate(months):
        if i + min(HORIZONS) >= len(months):
            break
        rev_months = prev_months(months, t, 3, REV_LAG)

        # t 月底的判斷，三種持有期共用
        labels = {}
        for code in common:
            a = table[code].get(t)
            if not a or not a[3]:
                continue
            pe = a[0] if a[0] and 0 < a[0] <= bv.PE_MAX else None
            band = bv.band([x for x in series[code] if x[0] <= t])
            lv = bv.level(pe, band)
            if not lv:
                continue
            # 近三月營收：t−1、t−2、t−3（見 docstring 的「營收晚一個月」）
            yoys = [rev.get(m, {}).get(code) for m in rev_months]
            yoy3 = statistics.mean(yoys) if all(y is not None for y in yoys) else None
            tags = [lv]
            if lv in ("cheap", "below") and yoy3 is not None:
                tags.append("trap" if yoy3 < 0 else "solid")
            if (lv in ("above", "pricey") and yoy3 is not None
                    and bv.GROWTH_MIN <= yoy3 <= bv.GROWTH_MAX and industry.get(code) != bv.FIN_INDUSTRY
                    and pe / (1 + yoy3 / 100) <= band["avg"]):
                tags.append("digest")
            labels[code] = tags
        if not labels:
            continue

        for h in HORIZONS:
            if i + h >= len(months):
                continue
            end = months[i + h]
            rets = {}
            for code in common:
                a, b = table[code].get(t), table[code].get(end)
                if a and b and a[3] and b[3]:
                    rets[code] = (b[3] / a[3] - 1) * 100 + (a[1] or 0) * h / 12
            labels_h = {c: tags for c, tags in labels.items() if c in rets}
            if not labels_h:
                continue
            first_rated = first_rated or t
            bench = statistics.median(rets.values())
            periods[h].append(t)
            for code, tags in labels_h.items():
                r = rets[code]
                for g in tags:
                    buckets[h][g].append((r, r - bench))
                    by_year[h][g][t[:4]].append(r - bench)

    out_groups = {h: {g: summarize(buckets[h][g]) for g in GROUPS} for h in HORIZONS}
    out_years = {h: {g: {y: round(statistics.median(v), 2) for y, v in sorted(ys.items())}
                     for g, ys in by_year[h].items()} for h in HORIZONS}

    twse.write_json(OUT_PATH, {
        "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "dataFrom": months[0],
        "firstRated": first_rated,
        "lastMonth": months[-1],
        "horizons": list(HORIZONS),
        "periods": {h: {"n": len(p), "from": p[0] if p else None, "to": p[-1] if p else None}
                    for h, p in periods.items()},
        "groups": out_groups,
        "byYear": out_years,
    })

    print(f"本益比 {months[0]} ~ {months[-1]}，第一個可評價的月底 {first_rated} -> {OUT_PATH.relative_to(twse.ROOT)}")
    for h in HORIZONS:
        p = periods[h]
        print(f"  持有 {h:2} 個月（{len(p)} 個起點 {p[0] if p else '-'} ~ {p[-1] if p else '-'}）")
        for g in GROUPS:
            s = out_groups[h][g]
            if s["n"]:
                print(f"    {g:7} n={s['n']:6}  中位數 {s['med']:7.2f}%  超額 {s['medEx']:7.2f}%"
                      f"  上漲 {s['up']:5.1f}%  贏市場 {s['beat']:5.1f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
