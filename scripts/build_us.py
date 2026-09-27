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

# 並排軸（看並排）兩邊共用的期間。與上面那一組的差別是**兩邊要完全一樣**：
# 差距欄是「台股這一段減美股這一段」，天數不同的兩個數字相減沒有意義。
#
# 所以沒有「年」：台股的 kline 從 2026-03 起，湊不出 250 個交易日。這是資料的限制，
# 不是參數可以調的 —— 美股那一欄有年、並排那一欄沒有，不是漏了。
PAIR_SPANS = ((1, "昨夜"), (5, "週"), (20, "月"), (63, "季"))


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


def span_series(series: list):
    """並排軸要的兩個東西：最後一個有效收盤，與對齊 PAIR_SPANS 的各段漲跌幅。

    先濾掉 None 再回推：缺的日子不能佔掉一格，否則「五個交易日前」會被算成更早的
    某一天。兩邊都走這一支，台股與美股的第 N 段才是同一種數法。
    """
    vals = [c for c in series if c is not None]
    if len(vals) < 2:
        return (vals[-1] if vals else None), [None] * len(PAIR_SPANS)
    return vals[-1], [pct(vals[-1], vals[-1 - span]) if len(vals) > span else None
                      for span, _ in PAIR_SPANS]


def day_change(closes: dict, dates: list):
    """台股最近一個交易日的漲跌幅。

    要求最後一個交易日本身有價：停牌的那幾檔不可以拿前天對大前天的漲跌充當今天的，
    畫面上它會跟其他檔並排，看不出那個數字是舊的。
    """
    if not dates or dates[-1] not in closes:
        return None
    seen = [closes[d] for d in dates if d in closes]
    return pct(seen[-1], seen[-2]) if len(seen) >= 2 else None


# 一個觀察窗佔四欄：r（原始）、x（超額）、lo／hi（滾動相關的擺盪範圍）。
# 這個 4 與下面 cols 的四個鍵是同一件事，所以兩邊都從這裡長出來 ——
# 加欄位時漏改另一處的那種錯，這一支上已經發生過一次。
SPAN_KEYS = ("r", "x", "lo", "hi")
COL_HEAD = ("code", "name", "label", "s")

def col_at(span: int) -> int:
    """某個觀察窗的第一欄（r）在一列裡的位置。"""
    return len(COL_HEAD) + us.SPANS.index(span) * len(SPAN_KEYS)


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

    # 並排軸的美股日期軸：裁到台股最後一個交易日**之前**的那一場。
    #
    # 相關性那一段是 us.align() 一天一天接起來的，對齊寫在算式裡，看不到這個問題。
    # 並排軸不一樣：它拿兩邊各自的最後 N 天算漲跌幅，日期一錯位就是整欄都錯 ——
    # 而畫面上兩個數字並排看起來完全正常（日股頁踩過同一個坑，見 build_pair.py）。
    #
    # 而這個錯位是常態不是例外：排程在台北時間傍晚跑，Yahoo 那時給得出的美股最後一場
    # 常常與台股同一個日期（美股 D 日收在台北 D+1 日清晨），但台股 D 日當天反映的是
    # 美股 D−1 日的那一夜。所以要的是「台股最後一天之前的最後一場美股」。
    pair_axis = [d for d in us_axis if d < tw_dates[-1]]
    if len(pair_axis) < 2:
        # 台股落後美股很多天（行情那幾步失敗時會這樣）。並排軸寧可整個留白，
        # 也不要拿一個對不上的日期去算差距。
        pair_axis = []

    twii = us.returns(closes.get(us.TW_INDEX) or {}, tw_dates)
    ixic = us.returns(closes[us.US_INDEX], us_axis)

    link = us.load_link()
    themes = us.load_themes()
    pairs = us.pairs_of(link, themes)
    stock_names = (json.loads((twse.DATA_DIR / "industry.json").read_text(encoding="utf-8"))
                   .get("names") or {})

    # 台股那一邊只算一次：同一檔會被好幾檔美股配到
    need = {code for rows in pairs.values() for code, *_ in rows}
    tw_ret, tw_exc, tw_chg, tw_pair, missing = {}, {}, {}, {}, []
    for code in sorted(need):
        tw_close = us.tw_closes(code)
        # 當日漲跌與相關性無關，但族群頁要拿它跟美股那一邊並排，
        # 而 kline 已經在手上，另外讀一次只是浪費。
        tw_chg[code] = day_change(tw_close, tw_dates)
        # 並排軸的四段。要求最後一個交易日本身有價，理由同 day_change：停牌的那幾檔
        # 不可以拿前天的收盤充當今天的，它會跟其他檔並排在同一欄，看不出是舊的。
        if tw_dates[-1] in tw_close:
            px, chg = span_series([tw_close.get(d) for d in tw_dates])
            tw_pair[code] = {"px": px, "chg": chg}
        series = us.returns(tw_close, tw_dates)
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
                # 同一個相關係數的擺盪範圍：一路都在 40~60 之間，與半年前還是 −20%
                # 最近才衝上來，是完全不同的兩件事，而單一個數字分不出來。
                row.extend(us.corr_range(aligned, span))
            row.append(len(aligned))
            row.append(tw_chg.get(code))
            rows.append(row)
        if not rows:
            continue
        # 排序用中段的原始相關（r60）：短窗太跳、長窗受限於 kline 的起點
        mid = col_at(60)
        rows.sort(key=lambda r: (r[mid] is None, -(r[mid] or 0)))
        scores = [r[mid] for r in rows if r[mid] is not None]
        # ★★★ 的配對一律留著，不管排第幾名：那正是這一頁要驗證的東西。
        # NVDA 橫跨六族、配對池兩百多檔，不這樣做的話台積電會被排名截掉。
        must = [r for r in rows if r[3] == 3]
        rest = [r for r in rows if r[3] != 3]
        keep = must + rest[:max(0, args.top - len(must))]
        keep.sort(key=lambda r: (r[mid] is None, -(r[mid] or 0)))
        pair_px, pair_chg = span_series([closes[sym].get(d) for d in pair_axis])
        items.append({
            "t": sym,
            "n": names.get(sym, sym),
            "last": (closes[sym][sorted(closes[sym])[-1]]),
            "chg": changes([closes[sym].get(d) for d in us_axis]),
            # 並排軸專用：收盤與漲跌都停在 pair_axis 那一天，不是 last 那一天。
            # 兩者在多數日子是同一天，但不能假設 —— 混用的話「昨夜 +2%」配的會是
            # 另一場的收盤價。
            "ppx": pair_px,
            "pchg": pair_chg,
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
        own_axis = us_axis if sym != us.TW_INDEX else tw_dates
        series = us.returns(closes[sym], own_axis)
        aligned = us.align(series, twii, tw_dates)
        # 並排軸的大盤也要停在對的那一天：美股的指數停在 pair_axis，台股加權停在
        # 台股自己的最後一天。兩邊差一場，正是這一頁的對齊方式。
        b_px, b_chg = span_series([closes[sym].get(d)
                                   for d in (pair_axis if sym != us.TW_INDEX else tw_dates)])
        bench.append({
            "t": sym,
            "n": row["n"],
            "why": row["why"],
            "last": closes[sym][sorted(closes[sym])[-1]],
            "chg": changes([closes[sym].get(d) for d in us_axis]),
            "ppx": b_px,
            "pchg": b_chg,
            "twr": [us.corr_pct(aligned, span) for span in us.SPANS],
        })

    shown = {row[0] for it in items for row in it["links"]}
    items.sort(key=lambda it: (it["mid"] is None, -(it["mid"] or 0)))
    payload = {
        "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "asof": us_axis[-1],
        "twAsof": tw_dates[-1],
        "from": tw_dates[0],
        "spans": list(us.SPANS),
        "pairSpans": [label for _, label in PAIR_SPANS],
        "pairAsof": pair_axis[-1] if pair_axis else None,
        "minPoints": us.MIN_POINTS,
        # 前端照名字查位置（不是照算式），所以這裡加欄位不必兩邊一起改
        "cols": list(COL_HEAD)
                + [f"{k}{s}" for s in us.SPANS for k in SPAN_KEYS] + ["n", "twchg"],
        "minWindows": us.MIN_WINDOWS,
        "labels": labels,
        "items": items,
        # 並排軸的台股那一邊。**按代號存一份**，不是加進每一列 ——
        # 同一檔台股平均出現在五組配對裡（2330 出現在 26 組），存進列裡就是同一組數字
        # 複製五份。只留真的被輸出的那些列用得到的代號。
        "tw": {c: v for c, v in tw_pair.items() if c in shown},
        "bench": bench,
    }
    twse.write_json(us.INDEX_PATH, payload)

    kb = us.INDEX_PATH.stat().st_size / 1024
    print(f"{len(items)} 檔美股 / {sum(i['pairs'] for i in items)} 組配對"
          f"（輸出 {sum(len(i['links']) for i in items)} 列）"
          f" -> {us.INDEX_PATH.relative_to(twse.ROOT)}（{kb:.0f} KB）")
    print(f"對齊窗：台股 {tw_dates[0]} ~ {tw_dates[-1]}（{len(tw_dates)} 個交易日）"
          f"、美股到 {us_axis[-1]}")
    print(f"並排軸：美股 {pair_axis[-1] if pair_axis else '—'}（台股 {tw_dates[-1]} 那天反映的"
          f"就是這一場） / 台股 {len(payload['tw'])} 檔有四段漲跌")
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
            at = col_at(60)
            band = (f" 擺盪 {row[at + 2]}~{row[at + 3]}%"
                    if row[at + 2] is not None else " 擺盪 —")
            # 天數是倒數第二欄，不是最後一欄：列尾後來多了 twchg。
            # 這一行印了一陣子的「3.06 天」其實是當日漲跌 3.06%（前端犯過同一個錯，
            # 那邊改成照 cols 查位置了，見 us.js 的註解）。
            print(f"  {sym:<6} vs {code} {row[1]:<6} r60={row[at]}% x60={row[at + 1]}%"
                  f"{band}（{row[-2]} 天）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
