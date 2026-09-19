"""由美股日線與台股日 K 線算出「美股 → 台股」的連動 -> docs/data/us/index.json。

輸入：
    docs/data/us/market.json    美股日線（fetch_us.py 抓的）
    docs/data/kline/{市場}/{代號}/YYYY-MM.json   台股個股日 K 線
    docs/data/us_link.json      人工對照表（哪一檔美股要對哪一批台股）

輸出一份給前端直接讀的表：每一檔美股的漲跌幅，加上它對照的台股各自的相關性百分比。

相關性的定義、對齊方式與資料範圍的限制寫在 us.py 的 docstring 裡，改之前先讀那一段。

用法：
    python scripts/build_us.py
    python scripts/build_us.py --top 30     # 每檔美股最多列幾檔台股（預設 20）
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from statistics import median

import twse
import us

# 漲跌幅要看的幾段（交易日）。1 日是「昨晚」，其餘是拿來判斷這一檔在什麼位置。
CHG_SPANS = (("d1", 1), ("w1", 5), ("m1", 20), ("y1", 250))


def parse_args():
    ap = argparse.ArgumentParser(description="算美股與台股的連動")
    ap.add_argument("--top", type=int, default=20, help="每檔美股最多輸出幾檔台股")
    return ap.parse_args()


def pct(new, old):
    return None if not old else round((new / old - 1) * 100, 2)


def changes(closes: list) -> dict:
    """由收盤序列算各段漲跌幅。序列不夠長的那一段就留 None。"""
    vals = [c for c in closes if c is not None]
    if len(vals) < 2:
        return {}
    out = {}
    for key, span in CHG_SPANS:
        if len(vals) > span:
            out[key] = pct(vals[-1], vals[-1 - span])
        elif key == "y1" and len(vals) >= 2:
            out[key] = pct(vals[-1], vals[0])      # 上市未滿一年就用「有資料以來」
    return out


def excess(series: dict, base: dict) -> dict:
    """個股報酬扣掉自己市場的大盤報酬。大盤那天沒資料就整天不算。"""
    return {d: v - base[d] for d, v in series.items() if d in base}


def main() -> int:
    args = parse_args()
    market = json.loads(us.MARKET_PATH.read_text(encoding="utf-8"))
    axis = market["d"]
    closes = {sym: {d: c for d, c in zip(axis, row["c"]) if c is not None}
              for sym, row in market["items"].items()}
    names = {sym: row["n"] for sym, row in market["items"].items()}

    index = json.loads(twse.INDEX_PATH.read_text(encoding="utf-8"))
    kline = index.get("kline") or {}
    floor = min((kline[m]["from"] for m in kline), default="")
    tw_dates = [d for d in index["dates"] if d >= floor] if floor else list(index["dates"])
    if len(tw_dates) < us.MIN_POINTS:
        print("台股 K 線的涵蓋範圍太短，算不出相關性")
        return 1

    # 美股自己的交易日軸用 ^IXIC：個股缺一天就讓報酬鏈在那裡斷掉，
    # 不要把停牌三天的漲幅當成一天的日報酬
    us_axis = sorted(closes.get(us.US_INDEX) or {})
    if not us_axis:
        print(f"沒有 {us.US_INDEX} 的資料，無法建立美股的交易日軸")
        return 1

    twii = us.returns(closes.get(us.TW_INDEX) or {}, tw_dates)
    ixic = us.returns(closes[us.US_INDEX], us_axis)

    link = us.load_link()
    themes = us.load_themes()
    pairs = us.pairs_of(link, themes)
    stock_names = (json.loads((twse.DATA_DIR / "industry.json").read_text(encoding="utf-8"))
                   .get("names") or {})

    # 台股那一邊只算一次：同一檔會被好幾檔美股配到
    need = {code for rows in pairs.values() for code, *_ in rows}
    tw_ret, tw_exc, missing = {}, {}, []
    for code in sorted(need):
        series = us.returns(us.tw_closes(code), tw_dates)
        if len(series) < us.MIN_POINTS:
            missing.append(code)
            continue
        tw_ret[code] = series
        tw_exc[code] = excess(series, twii)

    labels, label_id = [], {}
    def label_of(group: str, sub: str) -> int:
        text = f"{group} › {sub}" if sub else group
        if text not in label_id:
            label_id[text] = len(labels)
            labels.append(text)
        return label_id[text]

    items, dropped = [], 0
    for sym in sorted(pairs):
        if sym not in closes:
            continue
        series = us.returns(closes[sym], us_axis)
        exc = excess(series, ixic)
        rows = []
        for code, group, sub, strength in pairs[sym]:
            if code not in tw_ret:
                dropped += 1
                continue
            aligned = us.align(series, tw_ret[code], tw_dates)
            if len(aligned) < us.MIN_POINTS:
                dropped += 1
                continue
            aligned_x = us.align(exc, tw_exc[code], tw_dates)
            row = [code, stock_names.get(code, code), label_of(group, sub), strength]
            for span in us.SPANS:
                row.append(us.corr_pct(aligned, span))
                row.append(us.corr_pct(aligned_x, span))
            row.append(len(aligned))
            rows.append(row)
        if not rows:
            continue
        # 排序用中段的原始相關（r60）：短窗太跳、長窗受限於 kline 的起點
        mid = us.SPANS.index(60) * 2 + 4
        rows.sort(key=lambda r: (r[mid] is None, -(r[mid] or 0)))
        scores = [r[mid] for r in rows if r[mid] is not None]
        # ★★★ 的配對一律留著，不管排第幾名：那正是這一頁要驗證的東西。
        # NVDA 橫跨六族、配對池兩百多檔，不這樣做的話台積電會被排名截掉。
        must = [r for r in rows if r[3] == 3]
        rest = [r for r in rows if r[3] != 3]
        keep = must + rest[:max(0, args.top - len(must))]
        keep.sort(key=lambda r: (r[mid] is None, -(r[mid] or 0)))
        items.append({
            "t": sym,
            "n": names.get(sym, sym),
            "last": (closes[sym][sorted(closes[sym])[-1]]),
            "chg": changes([closes[sym].get(d) for d in us_axis]),
            "mid": round(median(scores)) if scores else None,
            "pairs": len(rows),
            "links": keep,
        })

    # 大盤層級的參考：它們不配個股，只跟台股加權對一次
    bench = []
    for row in link.get("benchmarks") or []:
        sym = row["t"]
        if sym not in closes:
            continue
        series = us.returns(closes[sym], us_axis if sym != us.TW_INDEX else tw_dates)
        aligned = us.align(series, twii, tw_dates)
        bench.append({
            "t": sym,
            "n": row["n"],
            "why": row["why"],
            "last": closes[sym][sorted(closes[sym])[-1]],
            "chg": changes([closes[sym].get(d) for d in us_axis]),
            "twr": [us.corr_pct(aligned, span) for span in us.SPANS],
        })

    items.sort(key=lambda it: (it["mid"] is None, -(it["mid"] or 0)))
    payload = {
        "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "asof": us_axis[-1],
        "twAsof": tw_dates[-1],
        "from": tw_dates[0],
        "spans": list(us.SPANS),
        "minPoints": us.MIN_POINTS,
        "cols": ["code", "name", "label", "s"]
                + [f"{k}{s}" for s in us.SPANS for k in ("r", "x")] + ["n"],
        "labels": labels,
        "items": items,
        "bench": bench,
    }
    twse.write_json(us.INDEX_PATH, payload)

    kb = us.INDEX_PATH.stat().st_size / 1024
    print(f"{len(items)} 檔美股 / {sum(i['pairs'] for i in items)} 組配對"
          f"（輸出 {sum(len(i['links']) for i in items)} 列）"
          f" -> {us.INDEX_PATH.relative_to(twse.ROOT)}（{kb:.0f} KB）")
    print(f"對齊窗：台股 {tw_dates[0]} ~ {tw_dates[-1]}（{len(tw_dates)} 個交易日）"
          f"、美股到 {us_axis[-1]}")
    if missing:
        print(f"! 沒有足夠 K 線的台股 {len(missing)} 檔（沒進過排行就沒有 kline）："
              f"{'、'.join(missing[:12])}{' …' if len(missing) > 12 else ''}")
    if dropped:
        print(f"! 算不出相關性而略過的配對 {dropped} 組")

    # 眼睛掃一下：這幾對是對照表裡標 ★★★ 的，數字應該明顯高於同族的其他檔
    for sym, code in (("ANET", "2345"), ("MU", "2408"), ("NVDA", "2330"), ("SMCI", "6669")):
        item = next((i for i in items if i["t"] == sym), None)
        row = next((r for r in (item or {}).get("links", []) if r[0] == code), None)
        if row:
            mid = us.SPANS.index(60) * 2 + 4
            print(f"  {sym:<6} vs {code} {row[1]:<6} r60={row[mid]}% x60={row[mid + 1]}%"
                  f"（{row[-1]} 天）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
