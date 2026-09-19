"""統計「新進榜之後通常怎麼走」-> docs/data/entry.json。

    新進榜 ＝ 成交值名次進入前 200，而前一個交易日不在前 200。

一天平均有 33 檔新進榜。這一支把過去每一次進榜之後 +1／+5／+20 個交易日的價格變化
收集起來，算成分布（中位數與四分位），再依「站穩幾天」「進榜名次」「市場」切幾組。

## 這是描述，不是訊號

⚠️ 整頁只講「歷史上這一群後來怎麼走」，不講「所以該買」。有兩件事讓它**不能**被
當成預測用：

1. **「站穩幾天」是事後才知道的。** 「站穩 5 天以上的那一群 +20 日中位數比較高」是
   一句成立的歷史敘述，但進榜當天你不知道它會不會站穩 —— 拿這個分組去做決策等於
   用了未來的資訊。所以那一組在畫面上一定要標出這件事。
2. **價格沒有還原權值。** 收盤價就是收盤價，除權息當天的跳空算進報酬裡。台股的
   除權息集中在 7~8 月，而本站的價格資料正好涵蓋那一段，所以這個偏差是**系統性
   偏負**的。中位數比平均數耐得住一些，但擋不掉整群同時除息。

## 價格資料只有 119 天，不是 498 天

名次序列從 2024-08-16 就有（498 個交易日、16,647 次進榜），但全市場收盤價
（`docs/data/close/`）是後來才開始存的，只有 2026-03-16 起的 119 天。一檔「一日
行情」的股票隔天就掉出前 300，`daily/` 從此沒有它的價，所以**價格一定要讀
`close/`**，而那份的起點就是這份統計的起點。

實際可用的樣本：+1 日 3,395 筆、+5 日 3,282 筆、+20 日 2,899 筆。

用法：
    python scripts/build_entry.py
"""

from __future__ import annotations

import json
import sys
from datetime import datetime

import twse

ENTRY_PATH = twse.DATA_DIR / "entry.json"

# 檔案格式版號。欄位一改就加一。
ENTRY_VERSION = 1

# 進榜的門檻，與前端的 TOP 一致
TOP = 200

# 要看進榜之後幾個交易日
HORIZONS = (1, 5, 20)

# 「站穩幾天」分組的邊界：只待 1 天（一日行情）、2~4 天、5 天以上
STAY_BUCKETS = ((1, 1, "只待 1 天"), (2, 4, "站穩 2~4 天"), (5, None, "站穩 5 天以上"))

# 進榜名次分組
RANK_BUCKETS = ((1, 50, "進榜名次 1~50"), (51, 100, "51~100"),
                (101, 150, "101~150"), (151, 200, "151~200"))

# 一組至少要有幾筆才給統計。低於這個數的分布沒有意義，寧可留白
MIN_SAMPLE = 30


def load_ranks(dates: list) -> dict:
    """{代號: {交易日序號: 名次}}。名次序列涵蓋全期間，比價格長得多。"""
    at = {d: i for i, d in enumerate(dates)}
    ranks = {}
    for year in sorted(twse.HISTORY_DIR.glob("all/*.json")):
        payload = json.loads(year.read_text(encoding="utf-8"))
        base = payload["dates"]
        for code, record in payload["stocks"].items():
            series = ranks.setdefault(code, {})
            for offset, rank, _value in record["p"]:
                series[at[base[offset]]] = rank
    return ranks


def load_closes(dates: list) -> tuple:
    """({交易日序號: {代號: 收盤價}}, {代號: 市場})。只有 close/ 有的那幾天。"""
    closes = {}
    market = {}
    for i, date_iso in enumerate(dates):
        table = {}
        for scope in ("twse", "tpex"):
            path = twse.close_path(date_iso, scope)
            if not path.exists():
                continue
            for code, close in (json.loads(path.read_text(encoding="utf-8")).get("c") or {}).items():
                table[code] = close
                market[code] = scope
        if table:
            closes[i] = table
    return closes, market


def stay_days(series: dict, start: int, cap: int = 60) -> int:
    """從進榜當天起，連續留在前 TOP 的天數。cap 是為了不讓長青股拖慢統計。"""
    days = 0
    while days < cap and series.get(start + days, 10 ** 9) <= TOP:
        days += 1
    return days


def collect(dates: list, ranks: dict, closes: dict, market: dict) -> list:
    """每一次新進榜 -> {at, code, market, rank, stay, ret{}}。

    只收「進榜當天有收盤價」的那些；各個 horizon 分別看有沒有價，
    所以 +1 日算得出來、+20 日算不出來的那些，仍然會進 +1 日那一組。
    """
    out = []
    for code, series in ranks.items():
        for at_day, rank in series.items():
            if rank > TOP or series.get(at_day - 1, 10 ** 9) <= TOP:
                continue                       # 不是新進榜
            base = (closes.get(at_day) or {}).get(code)
            if not base:
                continue                       # 進榜當天沒有價，整筆不要
            rets = {}
            for horizon in HORIZONS:
                later = (closes.get(at_day + horizon) or {}).get(code)
                if later:
                    rets[horizon] = (later / base - 1) * 100
            if not rets:
                continue
            out.append({
                "at": at_day,
                "code": code,
                "market": market.get(code, "twse"),
                "rank": rank,
                "stay": stay_days(series, at_day),
                "ret": rets,
            })
    return out


def quantile(values: list, q: float) -> float:
    """線性內插的分位數。values 必須先排序。"""
    if not values:
        return 0.0
    pos = (len(values) - 1) * q
    low = int(pos)
    high = min(low + 1, len(values) - 1)
    return values[low] + (values[high] - values[low]) * (pos - low)


def describe(rets: list) -> dict:
    """一組報酬的分布。樣本太少就回 None —— 十幾筆的中位數只是噪音。"""
    if len(rets) < MIN_SAMPLE:
        return None
    ordered = sorted(rets)
    return {
        "n": len(ordered),
        "pos": round(sum(1 for r in ordered if r > 0) / len(ordered) * 100, 1),
        "p25": round(quantile(ordered, 0.25), 2),
        "med": round(quantile(ordered, 0.50), 2),
        "p75": round(quantile(ordered, 0.75), 2),
    }


def bucket(events: list, label: str, key: str, keep) -> dict:
    """一組（依 keep 篩出來的事件）在三個 horizon 上的分布。"""
    picked = [e for e in events if keep(e)]
    cells = {}
    for horizon in HORIZONS:
        cells[str(horizon)] = describe([e["ret"][horizon] for e in picked if horizon in e["ret"]])
    return {"key": key, "label": label, "n": len(picked), "h": cells}


def build(dates: list, events: list, first: str, last: str) -> dict:
    groups = [
        {"key": "all", "label": "全部", "rows": [
            bucket(events, "全部新進榜", "all", lambda e: True)]},
        {"key": "stay", "label": "依站穩幾天", "rows": [
            bucket(events, label, f"stay{lo}",
                   lambda e, lo=lo, hi=hi: e["stay"] >= lo and (hi is None or e["stay"] <= hi))
            for lo, hi, label in STAY_BUCKETS]},
        {"key": "rank", "label": "依進榜名次", "rows": [
            bucket(events, label, f"rank{lo}",
                   lambda e, lo=lo, hi=hi: lo <= e["rank"] <= hi)
            for lo, hi, label in RANK_BUCKETS]},
        {"key": "market", "label": "依市場", "rows": [
            bucket(events, twse.SCOPE_NAMES[scope], scope,
                   lambda e, scope=scope: e["market"] == scope)
            for scope in ("twse", "tpex")]},
    ]
    return {
        "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "v": ENTRY_VERSION,
        "top": TOP,
        "horizons": list(HORIZONS),
        # 這份統計涵蓋的價格區間。名次序列比它長得多，畫面上要講清楚是哪一段
        "first": first,
        "last": last,
        "days": len({e["at"] for e in events}),
        "n": len(events),
        "min": MIN_SAMPLE,
        "groups": groups,
    }


def main() -> int:
    index = json.loads((twse.DATA_DIR / "index.json").read_text(encoding="utf-8"))
    dates = index["dates"]

    ranks = load_ranks(dates)
    closes, market = load_closes(dates)
    if not closes:
        print("docs/data/close/ 沒有任何檔案，算不出進榜後的價格變化。")
        print("請先執行 python scripts/backfill.py --days 30")
        return 1

    events = collect(dates, ranks, closes, market)
    if not events:
        print("找不到任何「進榜當天有收盤價」的新進榜事件。")
        return 1

    span = sorted(closes)
    first, last = dates[span[0]], dates[span[-1]]
    payload = build(dates, events, first, last)
    twse.write_json(ENTRY_PATH, payload)

    total = sum(1 for code, series in ranks.items() for at_day, rank in series.items()
                if rank <= TOP and not series.get(at_day - 1, 10 ** 9) <= TOP)
    print(f"新進榜事件：全期間 {total} 筆（{len(dates)} 個交易日）")
    print(f"  其中進榜當天有收盤價的 {len(events)} 筆 —— 價格資料只有 "
          f"{first} ~ {last} 共 {len(closes)} 天")
    for horizon in HORIZONS:
        cell = payload["groups"][0]["rows"][0]["h"][str(horizon)]
        if cell:
            print(f"  +{horizon:>2} 日：{cell['n']:>5} 筆，中位數 {cell['med']:+.2f}%、"
                  f"上漲 {cell['pos']:.0f}%、四分位 {cell['p25']:+.2f}% ~ {cell['p75']:+.2f}%")
    print(f"已寫入 {ENTRY_PATH.relative_to(twse.ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
