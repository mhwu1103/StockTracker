"""四個市場的題材對照 -> docs/data/cross/index.json。

回答的是「**現在什麼題材在漲**」，而且要四個市場一起回答：同一個題材在美、日、韓、台
同時走強，跟只有一個市場在動，是完全不同的兩件事。前者是真的有需求在後面推，
後者多半是單一市場的資金或消息。

輸入：
    docs/data/{us,jp,kr}/market.json             三個市場的日線（fetch_* 抓的）
    docs/data/kline/{市場}/{代號}/YYYY-MM.json    台股個股日 K 線
    docs/data/{us,jp,kr}_link.json               三份人工對照表（哪一族對哪幾檔）
    docs/data/themes.json                        台股那一邊的族群成分股
    docs/data/index.json                         台股交易日軸（也是這一頁的基準日曆）

## 為什麼不用「各自回推 N 個交易日」

日股／韓股頁是那樣算的，兩個市場時還撐得住。四個市場就不行了：每個市場的假日不一樣，
「回推 63 個交易日」在四份日曆上會落到四個不同的日期，而且愈往回推差愈多。2026-09-24
往回數 63 個交易日，美股落在 06-24、台股落在 06-20 —— 四欄並排看起來像在比同一段，
其實不是。

所以這裡改成**日曆視窗**：拿台股的交易日軸當基準（這是台股的站，問題問的是台股），
算出每一段的起訖**日期**，每個市場各自取「那個日期或之前最後一筆收盤」。四欄量的是
同一段日曆時間，各自用自己最新的那一場。

## 取交集會讓整頁落後一週，所以不取

四個市場**共同**有開盤的交易日，最後一天是 2026-09-18 —— 日本 09-21～23 休、韓國
09-24～25 休（中秋）。一頁叫做「現在什麼題材在漲」的東西落後六個日曆天就沒有意義了。

日曆視窗的代價是各市場的最後一場可能差一兩天（韓股停在 09-23、台股到 09-24）。那個
誤差擋不掉，但**看得見**：每個市場自己的最後一場寫在 markets[].asof，前端印在標頭上。
這與 build_pair.py 兩兩相比時「一起裁到同一天」的作法不同，是有意識的取捨：
兩個市場裁掉一天還看得出當下，四個市場裁下去就只剩上週了。

## 美股那一欄比其他三欄早一場

這不是 bug，是市場本身：美股 09-24 那一場收在台北時間 09-25 清晨，台股 09-24 收盤時
還沒發生。日股與韓股則是台北時間 8:00–14:30，與台股同一場。

所以美股那一欄含的是**台股還沒反映的那一夜**。對「現在什麼題材在漲」來說那是最新的
資訊、不是誤差，但讀的時候要知道它領先一場。頁面上寫著。

## 每一格是中位數，不是加權

一族裡常有一兩檔暴衝，用平均或成交值加權會被它拉著走。與日股／韓股頁同一個理由。

**與排行榜「族群」分頁的數字不一樣，兩邊都沒錯**：那一頁是當日的成交值加權漲跌，
問的是「今天錢往哪一族去」；這一頁是多個期間的中位數，問的是「這一族這一段在不在漲」。

**與日股／韓股頁的台股那一欄也不一樣**：那兩頁的台股是每個子族群取成交值前十檔（它們
要的是配對），這一頁取整族全部有 K 線的成分股（要的是整族的體溫）。

用法：
    python scripts/build_cross.py
    python scripts/build_cross.py --min-n 2   # 一格至少要幾檔才給數字（預設 1）
"""

from __future__ import annotations

import argparse
import bisect
import json
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from statistics import median

import pair
import twse
import us as us_mod

CROSS_DIR = twse.DATA_DIR / "cross"
INDEX_PATH = CROSS_DIR / "index.json"

# 台股大盤。三份 market.json 裡都有一份，取第一份讀得到的。
TW_INDEX = "^TWII"

# 漲跌幅要看的幾段，用**台股交易日**回推。與日股／韓股頁同一組，所以三頁可以互相對照。
# 沒有「年」：台股的 kline 只有半年多。
SPANS = pair.SPANS


@dataclass(frozen=True)
class Side:
    """一個外國市場：資料在哪、對照表那一邊的鍵是什麼、拿哪一個指數當它的底。"""

    key: str
    label: str
    tag: str            # 表格裡那一個字
    index: str
    index_name: str
    currency: str       # 展開個股時收盤價要帶的單位：四個市場四種錢，不能互比
    decimals: int


SIDES = (
    Side("us", "美股", "美", "^IXIC", "那斯達克", "美元", 2),
    Side("jp", "日股", "日", "^N225", "日經 225", "円", 0),
    Side("kr", "韓股", "韓", "^KS11", "KOSPI", "韓元", 0),
)

# 一檔的最後一場比它那個市場的大盤舊超過這麼多天，就當它已經不動了（停牌、下市、
# 或對照表裡留著一個換過代號的舊代號）。抓 7 天是因為連假加上一兩天沒成交是正常的，
# 而真的停掉的股票會一路舊下去，差距只會愈拉愈大。
STALE_DAYS = 7

# 大盤列。費半不是任何一個市場的「底」（超額不拿它減），但它是這一頁多數題材真正的
# 景氣指標，擺在大盤列上當參考。
BENCH = (("^IXIC", "那斯達克"), ("^SOX", "費城半導體"), ("^N225", "日經 225"),
         ("^KS11", "KOSPI"), (TW_INDEX, "加權指數"))


def parse_args():
    ap = argparse.ArgumentParser(description="算四個市場的題材對照")
    ap.add_argument("--min-n", type=int, default=1,
                    help="一格至少要幾檔才給數字（預設 1；設 2 可以把單檔代表的格子清掉）")
    return ap.parse_args()


class Series:
    """一份 market.json 攤成「代號 -> 可二分搜尋的 (日期, 收盤)」。

    查的是「這個日期或之前的最後一筆」，不是「剛好那一天」：每個市場的假日不一樣，
    要求剛好落在同一天的話，四個市場永遠對不齊。
    """

    def __init__(self, path):
        payload = json.loads(path.read_text(encoding="utf-8"))
        axis = payload["d"]
        self.names = {}
        self.days: dict[str, list] = {}
        self.vals: dict[str, list] = {}
        for sym, row in payload["items"].items():
            self.names[sym] = row.get("n", sym)
            pairs = [(d, c) for d, c in zip(axis, row.get("c") or []) if c is not None]
            self.days[sym] = [d for d, _ in pairs]
            self.vals[sym] = [c for _, c in pairs]

    def has(self, sym: str) -> bool:
        return bool(self.days.get(sym))

    def at(self, sym: str, date: str):
        """該代號在 date 當天或之前的最後一筆收盤。完全沒有就回 None。"""
        days = self.days.get(sym)
        if not days:
            return None
        i = bisect.bisect_right(days, date) - 1
        return self.vals[sym][i] if i >= 0 else None

    def last_on_or_before(self, sym: str, date: str):
        days = self.days.get(sym)
        if not days:
            return None
        i = bisect.bisect_right(days, date) - 1
        return days[i] if i >= 0 else None


class TwSeries:
    """台股：由 kline/ 拼回來，介面與 Series 的 at() 一樣。一檔只讀一次。"""

    def __init__(self):
        self._cache: dict[str, tuple] = {}

    def _get(self, code: str):
        if code not in self._cache:
            closes = us_mod.tw_closes(code)
            days = sorted(closes)
            self._cache[code] = (days, [closes[d] for d in days])
        return self._cache[code]

    def has(self, code: str) -> bool:
        return bool(self._get(code)[0])

    def at(self, code: str, date: str):
        days, vals = self._get(code)
        i = bisect.bisect_right(days, date) - 1
        return vals[i] if i >= 0 else None

    def last_on_or_before(self, code: str, date: str):
        days, _ = self._get(code)
        i = bisect.bisect_right(days, date) - 1
        return days[i] if i >= 0 else None


def link_members(path, key: str) -> tuple[dict, dict]:
    """對照表 -> ({族群: [代號]}, {(族群, 子族群): [代號]})。去重保留順序。"""
    payload = json.loads(path.read_text(encoding="utf-8"))
    by_group, by_sub = {}, {}
    for group in payload["groups"]:
        name = group["name"]
        seen = []
        for row in group.get(key) or []:
            if row["t"] not in seen:
                seen.append(row["t"])
        for sub in group.get("subs") or []:
            picks = []
            for row in sub.get(key) or []:
                if row["t"] not in picks:
                    picks.append(row["t"])
                if row["t"] not in seen:
                    seen.append(row["t"])
            if picks:
                by_sub[(name, sub["name"])] = picks
        if seen:
            by_group[name] = seen
    return by_group, by_sub


def main() -> int:
    args = parse_args()

    # 基準日曆：台股的交易日，而且只取 kline 涵蓋得到的那一段
    index = json.loads(twse.INDEX_PATH.read_text(encoding="utf-8"))
    kline = index.get("kline") or {}
    floor = min((kline[m]["from"] for m in kline), default="")
    tw_dates = [d for d in index["dates"] if d >= floor] if floor else list(index["dates"])
    if len(tw_dates) <= max(span for span, _ in SPANS):
        print(f"台股 K 線只有 {len(tw_dates)} 個交易日，撐不起最長那一段")
        return 1

    end = tw_dates[-1]
    # 每一段的起算日，用台股的交易日回推。四個市場拿同一組日期去查自己的收盤。
    starts = [tw_dates[-1 - span] for span, _ in SPANS]

    series = {}
    for side in SIDES:
        path = twse.DATA_DIR / side.key / "market.json"
        if not path.exists():
            print(f"找不到 {path.relative_to(twse.ROOT)}，先跑 fetch_pair.py／fetch_us.py")
            return 1
        series[side.key] = Series(path)
    tw = TwSeries()

    def fresh_floor(src, index_sym: str) -> str | None:
        """這個市場的個股最後一場不能比這一天更舊。以它自己的大盤為準。"""
        last = src.last_on_or_before(index_sym, end)
        return (date.fromisoformat(last) - timedelta(days=STALE_DAYS)).isoformat() if last else None

    fresh = {s.key: fresh_floor(series[s.key], s.index) for s in SIDES}
    fresh["tw"] = (date.fromisoformat(end) - timedelta(days=STALE_DAYS)).isoformat()

    def chg_of(src, sym, fresh: str | None = None) -> list:
        """一檔在各段的漲跌幅（%）。缺哪一段就是 None。

        fresh 是「這一檔的最後一場不能比這一天更舊」。取的是**當天或之前最後一筆**，
        所以停牌或下市的個股不會缺席 —— 它會拿三個月前的收盤一路算到底，畫面上跟
        其他檔並排，看不出那幾個數字已經不動了。給了 fresh 就把它們擋在外面。
        """
        end_day = src.last_on_or_before(sym, end)
        if end_day is None or (fresh and end_day < fresh):
            return [None] * len(SPANS)
        now = src.at(sym, end)
        out = []
        for start in starts:
            start_day = src.last_on_or_before(sym, start)
            # 起算日解析到的是同一場（那之前根本沒有資料，多半是新上市）：
            # 算出來會是 0%，而 0% 在這一頁看起來像「這一段沒動」
            if start_day is None or start_day == end_day:
                out.append(None)
                continue
            out.append(pair.pct(now, src.at(sym, start)))
        return out

    # 個股列按市場各存一份，**不寫進每一格**：同一檔會被好幾格用到（台積電在三族裡、
    # 信越化學橫跨四族），寫進去就是同一份資料抄十幾遍。格子裡只留代號，前端再查。
    # 這是 us/index.json 的頂層 tw 那一招，同一個理由。
    stocks: dict[str, dict] = {m: {} for m in [s.key for s in SIDES] + ["tw"]}

    def med_cell(src, syms, fresh, mk: str, name_of, dp: int) -> dict | None:
        """一格：一組代號在各段的中位數，加上真的算進去的那幾檔。

        「真的算進去」是有意義的過濾：沒有資料、或最後一場太舊的那幾檔會被擋掉，
        所以格子裡的代號數才是中位數的分母，不是對照表上的筆數。
        """
        rows = []
        for sym in syms:
            if not src.has(sym):
                continue
            chg = chg_of(src, sym, fresh)
            if not any(v is not None for v in chg):
                continue
            rows.append((sym, chg))
        if len(rows) < max(1, args.min_n):
            return None
        med = []
        for i in range(len(SPANS)):
            vals = [r[1][i] for r in rows if r[1][i] is not None]
            med.append(round(median(vals), 2) if vals else None)
        if all(v is None for v in med):
            return None
        for sym, chg in rows:
            if sym not in stocks[mk]:
                px = src.at(sym, end)
                stocks[mk][sym] = {"n": name_of(sym),
                                   "px": round(px, dp) if px is not None else None,
                                   "chg": chg}
        return {"med": med, "codes": [s for s, _ in rows]}

    themes = pair.load_themes()
    stock_names = (json.loads((twse.DATA_DIR / "industry.json").read_text(encoding="utf-8"))
                   .get("names") or {})
    tw_group_codes = pair.theme_codes(themes)
    tw_sub_codes = pair.theme_sub_codes(themes)

    links = {}
    for side in SIDES:
        links[side.key] = link_members(twse.DATA_DIR / f"{side.key}_link.json", side.key)

    # 每個市場自己的大盤，超額要拿它減。台股的 ^TWII 三份 market.json 裡都有，取讀得到的。
    markets = []
    for side in SIDES:
        src = series[side.key]
        markets.append({
            "k": side.key, "label": side.label, "tag": side.tag,
            "index": side.index, "indexName": side.index_name,
            "asof": src.last_on_or_before(side.index, end) or "",
            "cur": side.currency, "dp": side.decimals,
            "chg": chg_of(src, side.index),
        })
    tw_src = next((series[s.key] for s in SIDES if series[s.key].has(TW_INDEX)), None)
    if tw_src is None:
        print("三份 market.json 裡都沒有 ^TWII，算不出台股那一欄的底")
        return 1
    markets.append({
        "k": "tw", "label": "台股", "tag": "台",
        "index": TW_INDEX, "indexName": "加權指數",
        "asof": end,
        "cur": "元", "dp": pair.TW_DECIMALS,
        "chg": chg_of(tw_src, TW_INDEX),
    })

    bench = []
    for sym, name in BENCH:
        src = next((series[s.key] for s in SIDES if series[s.key].has(sym)), None)
        if src is None:
            continue
        bench.append({"t": sym, "n": name, "px": src.at(sym, end),
                      "asof": src.last_on_or_before(sym, end), "chg": chg_of(src, sym)})

    groups = []
    for group in themes["groups"]:
        name = group["name"]

        def cells(sub: str | None) -> dict:
            out = {}
            for side in SIDES:
                by_group, by_sub = links[side.key]
                src = series[side.key]
                syms = by_sub.get((name, sub)) if sub else by_group.get(name)
                cell = med_cell(src, syms or [], fresh[side.key], side.key,
                                lambda s, src=src: src.names.get(s, s), side.decimals)
                if cell:
                    out[side.key] = cell
            codes = (tw_sub_codes.get(name, {}).get(sub) if sub
                     else tw_group_codes.get(name)) or []
            cell = med_cell(tw, codes, fresh["tw"], "tw",
                            lambda c: stock_names.get(c, c), pair.TW_DECIMALS)
            if cell:
                out["tw"] = cell
            return out

        subs = []
        for sub in group["subs"]:
            c = cells(sub["name"])
            # 只有台股一欄的子族群不必列：這一頁的內容是「幾個市場一起動」，
            # 一個市場的那一格在排行榜的族群分頁就看得到了
            if len(c) >= 2:
                subs.append({"name": sub["name"], "cells": c})

        c = cells(None)
        if len(c) < 2:
            continue
        groups.append({"name": name, "cells": c, "subs": subs})

    payload = {
        "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "end": end,
        "from": tw_dates[0],
        "spans": [label for _, label in SPANS],
        "spanDays": [span for span, _ in SPANS],
        "starts": starts,
        "markets": markets,
        "bench": bench,
        "groups": groups,
        "stocks": stocks,
    }
    twse.write_json(INDEX_PATH, payload)

    kb = INDEX_PATH.stat().st_size / 1024
    print(f"{len(groups)} 族 / {sum(len(g['subs']) for g in groups)} 個子族群"
          f" / 可展開的個股 " + "、".join(f"{m} {len(v)}" for m, v in stocks.items())
          + f" -> {INDEX_PATH.relative_to(twse.ROOT)}（{kb:.0f} KB）")
    print(f"基準日曆是台股：{end}，各段起算日 "
          + "、".join(f"{lab} {s}" for (_, lab), s in zip(SPANS, starts)))
    print("各市場最後一場：" + "、".join(f"{m['label']} {m['asof']}" for m in markets))

    # 眼睛掃一下：四市都在漲的前五名。整頁就是要回答這件事，數字怪就是哪裡接錯了。
    def weakest(g, i=1):
        vals = [c["med"][i] for c in g["cells"].values() if c["med"][i] is not None]
        return min(vals) if len(vals) >= 3 else None

    ranked = sorted((g for g in groups if weakest(g) is not None),
                    key=lambda g: -weakest(g))
    print("\n週漲跌：最弱的那一市也在漲的前五名")
    for g in ranked[:5]:
        cols = "  ".join(
            f"{m['tag']} {g['cells'][m['k']]['med'][1]:+.1f}%" if m["k"] in g["cells"]
            and g["cells"][m["k"]]["med"][1] is not None else f"{m['tag']}   —  "
            for m in markets)
        print(f"  {g['name']:<22} 最弱 {weakest(g):+.1f}%   {cols}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
