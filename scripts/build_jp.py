"""由日股日線與台股日 K 線算出族群對照 -> docs/data/jp/index.json。

輸入：
    docs/data/jp/market.json                     日股日線（fetch_jp.py 抓的）
    docs/data/kline/{市場}/{代號}/YYYY-MM.json    台股個股日 K 線
    docs/data/jp_link.json                       人工對照表（哪一族對哪幾檔日股）
    docs/data/themes.json                        族群成分股
    docs/data/daily/all/<最近一天>.json           挑台股用的成交值

輸出每一族一組**子族群區塊**：一個區塊是「這幾檔日股 → 這幾檔台股」，
日股與台股在同一個環節上，差距就在區塊裡算。為什麼配對的單位是子族群而不是
族群、為什麼只擺漲跌幅不算相關係數，都寫在 jp.py 的 docstring 裡，改之前先讀。

用法：
    python scripts/build_jp.py
    python scripts/build_jp.py --top 6     # 每個區塊最多列幾檔台股（預設 4）
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from statistics import median

import jp
import twse


def parse_args():
    ap = argparse.ArgumentParser(description="算日股與台股的族群對照")
    ap.add_argument("--top", type=int, default=jp.TW_TOP,
                    help=f"每個子族群區塊最多輸出幾檔台股（預設 {jp.TW_TOP}）")
    return ap.parse_args()


def main() -> int:
    args = parse_args()
    if not jp.MARKET_PATH.exists():
        print(f"找不到 {jp.MARKET_PATH.relative_to(twse.ROOT)}，先跑 fetch_jp.py")
        return 1

    market = json.loads(jp.MARKET_PATH.read_text(encoding="utf-8"))
    jp_axis = market["d"]
    jp_close = {sym: row.get("c") or [] for sym, row in market["items"].items()}
    jp_names = {sym: row["n"] for sym, row in market["items"].items()}

    # 台股的交易日軸與 kline 的起點：與 build_us.py 同一個來源，
    # 排在 build_history.py 後面才會是今天的。
    index = json.loads(twse.INDEX_PATH.read_text(encoding="utf-8"))
    kline = index.get("kline") or {}
    floor = min((kline[m]["from"] for m in kline), default="")
    tw_dates = [d for d in index["dates"] if d >= floor] if floor else list(index["dates"])
    if len(tw_dates) < 2:
        print("台股 K 線的涵蓋範圍太短，算不出漲跌幅")
        return 1

    link = jp.load_link()
    themes = jp.load_themes()
    codes_of = jp.theme_codes(themes)
    sub_codes_of = jp.theme_sub_codes(themes)
    stock_names = (json.loads((twse.DATA_DIR / "industry.json").read_text(encoding="utf-8"))
                   .get("names") or {})
    values = jp.latest_values(twse.DAILY_DIR / "all" / f"{tw_dates[-1]}.json")

    # 日股要裁到台股的最後一個交易日。
    #
    # 整頁做的事是「兩邊的漲跌幅並排比」，那前提是兩邊量的是同一段時間。
    # 而 fetch_jp.py 每天抓得到最新的日股，台股卻可能還停在幾天前（行情或
    # build_history 那幾步失敗時會沿用舊資料）——不裁的話，日股的「週」是
    # 到 09-25 的五天、台股的「週」是到 09-18 的五天，差距那一欄整欄是錯的，
    # 而畫面上兩個數字並排看起來完全正常。
    cut = tw_dates[-1]
    keep = sum(1 for d in jp_axis if d <= cut)
    if keep < 2:
        print(f"日股在台股最後一個交易日（{cut}）之前沒有足夠資料")
        return 1
    jp_axis = jp_axis[:keep]
    jp_close = {sym: series[:keep] for sym, series in jp_close.items()}

    # 日股自己的交易日軸用 ^N225。不能用 market.json 的 d，那是所有標的的聯集，
    # 而 JPY=X 是匯率、週末也有報價 —— 用聯集的話頁面上會寫「日股到星期日」。
    n225_series = jp_close.get(jp.JP_INDEX) or []
    jp_last = next((d for d, c in zip(reversed(jp_axis), reversed(n225_series))
                    if c is not None), jp_axis[-1])

    def jp_row(sym: str, name: str) -> dict | None:
        series = jp_close.get(sym)
        if not series:
            return None
        seen = [c for c in series if c is not None]
        if len(seen) < 2:
            return None
        return {"t": sym, "n": name, "px": seen[-1], "chg": jp.changes(series),
                "cur": jp.CURRENCY.get(sym, "円"),
                "dp": jp.DECIMALS.get(sym, jp.JP_DECIMALS)}

    # 台股那一邊只算一次：同一檔會被好幾族用到（環球晶在三族裡）
    tw_cache: dict[str, dict | None] = {}

    def tw_row(code: str) -> dict | None:
        if code in tw_cache:
            return tw_cache[code]
        series = jp.tw_series(code, tw_dates)
        row = None
        # 最後一個交易日本身要有價：停牌的那幾檔不可以拿前天的漲跌充當今天的，
        # 畫面上它會跟其他檔並排，看不出那個數字是舊的。
        if series and series[-1] is not None:
            row = {"t": code, "n": stock_names.get(code, code),
                   "px": series[-1], "chg": jp.changes(series),
                   "cur": "元", "dp": jp.TW_DECIMALS, "val": values.get(code)}
        tw_cache[code] = row
        return row

    # 日股與台股各自的漲跌中位數。一族（或一個區塊）裡常有一兩檔暴衝，用平均會被
    # 它拉著走 —— 與美股頁的族群軸同一個理由。
    def med(rows, i):
        vals = [r["chg"][i] for r in rows if r["chg"][i] is not None]
        return round(median(vals), 2) if vals else None

    def meds(rows):
        return [med(rows, i) for i in range(len(jp.SPANS))]

    def uniq(rows):
        """同一檔台股會被同一族的兩個子族用到，族群層的中位數不能算它兩次。"""
        seen, out = set(), []
        for r in rows:
            if r["t"] not in seen:
                seen.add(r["t"])
                out.append(r)
        return out

    groups, dropped = [], set()
    for group in link["groups"]:
        name = group["name"]
        theme_subs = sub_codes_of.get(name) or {}

        # 對照表裡這一族出現過的所有日股：族群層的清單加上各子族的，去重保留順序。
        # 強度（星等）標在對照表上，畫面要靠它排序與標星；同一檔在兩處給了不同的 s
        # 時以先出現的為準 —— 那是對照表自己該修的事，不是這裡要調解的。
        entries, strength = [], {}
        for row in ((group.get("jp") or [])
                    + [r for s in group.get("subs") or [] for r in s.get("jp") or []]):
            if row["t"] not in strength:
                strength[row["t"]] = row.get("s", 1)
                entries.append(row)

        def jp_side(items):
            rows = [r for r in (jp_row(row["t"], jp_names.get(row["t"], row["n"]))
                                for row in items) if r]
            for r in rows:
                r["s"] = strength.get(r["t"], 1)
            rows.sort(key=lambda r: (-r["s"], -(r["chg"][1] or -999)))
            return rows

        def tw_side(codes):
            rows = []
            for code in jp.pick_tw(codes, values, args.top):
                row = tw_row(code)
                if row is None:
                    dropped.add(code)
                    continue
                rows.append(row)
            return rows

        def block(bname, jp_rows, tw_rows):
            return {"name": bname, "jp": jp_rows, "tw": tw_rows,
                    "jpMed": meds(jp_rows), "twMed": meds(tw_rows)}

        # 一個子族群一個區塊。兩邊都要有東西才算數：只剩日股或只剩台股的子族沒有
        # 對照可看，它的成員讓給下面那一塊，不要在表上留半排孤兒。
        blocks, used_jp, used_codes = [], set(), set()
        for sub in group.get("subs") or []:
            codes = theme_subs.get(sub["name"]) or []
            jp_rows, tw_rows = jp_side(sub.get("jp") or []), tw_side(codes)
            if not jp_rows or not tw_rows:
                continue
            used_jp |= {r["t"] for r in jp_rows}
            used_codes |= set(codes)
            blocks.append(block(sub["name"], jp_rows, tw_rows))

        # 沒有落進任何子族的日股收成最後一塊。對照表把它們標在族群層，意思是
        # 「對到整族」而不是漏標 —— 記憶體那一族的愛德萬、AI 伺服器那一族的日立
        # 都是這樣。直接丟掉的話畫面看起來完全正常，沒有人會發現少了幾檔。
        rest_jp = jp_side([row for row in entries if row["t"] not in used_jp])
        if rest_jp:
            rest_codes = [c for c in (codes_of.get(name) or []) if c not in used_codes]
            # 一族的子族群全軍覆沒時，這一塊就是整族，不該叫「對到整族」
            blocks.append(block(jp.REST_NAME if blocks else "",
                                rest_jp, tw_side(rest_codes)))

        jp_all = uniq([r for b in blocks for r in b["jp"]])
        tw_all = uniq([r for b in blocks for r in b["tw"]])
        if not jp_all or not tw_all:
            continue

        # 子族群把台股全部吃光時，「對到整族」那一塊就沒有自己的台股（記憶體那一族
        # 的愛德萬與 Resonac 就是）。那一塊的名字本來就叫「對到整族」，所以拿整族的
        # 台股中位數當它的對照 —— 留一欄 None 的話，那兩檔日股會變成表上唯一沒有
        # 任何對照數字的兩列，看起來像壞掉。
        group_tw_med = meds(tw_all)
        for b in blocks:
            if not b["tw"]:
                b["twMed"] = group_tw_med

        groups.append({
            "name": name,
            "why": group.get("why") or "",
            "jpMed": meds(jp_all),
            "twMed": meds(tw_all),
            "jpN": len(jp_all),
            "twN": len(tw_all),
            "blocks": blocks,
        })

    # 大盤基準：日經與台股加權，擺在最上面當整頁的底
    bench = []
    n225 = jp_row(jp.JP_INDEX, jp_names.get(jp.JP_INDEX, "日經 225"))
    if n225:
        n225["why"] = next((b.get("why", "") for b in link.get("benchmarks") or []
                            if b["t"] == jp.JP_INDEX), "")
        bench.append(n225)
    twii = jp_row(jp.TW_INDEX, jp_names.get(jp.TW_INDEX, "加權指數"))
    if twii:
        twii["why"] = "台股的底。族群漲得比它多才叫強，否則只是跟著大盤走"
        bench.append(twii)
    # 日圓擺在大盤區，因為它是這一頁最大的外生變數：日圓貶值時日廠報價競爭力
    # 上升，被動元件與工具機會出現「日股漲、台股不跟」。注意方向 ——
    # USD/JPY 上漲＝日圓變弱，對台廠是壞消息，紅色在這一列不代表好。
    for row in link.get("benchmarks") or []:
        if row["t"] in (jp.JP_INDEX, jp.TW_INDEX):
            continue
        extra = jp_row(row["t"], row["n"])
        if extra:
            extra["why"] = row.get("why", "")
            bench.append(extra)

    # 按「台股這一族的週漲跌」排序：頁面要回答的是台股跟上了沒
    groups.sort(key=lambda g: (g["twMed"][1] is None, -(g["twMed"][1] or 0)))

    payload = {
        "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "asof": jp_last,
        "twAsof": tw_dates[-1],
        "from": tw_dates[0],
        "spans": [label for _, label in jp.SPANS],
        "spanDays": [span for span, _ in jp.SPANS],
        "groups": groups,
        "bench": bench,
    }
    twse.write_json(jp.INDEX_PATH, payload)

    kb = jp.INDEX_PATH.stat().st_size / 1024
    print(f"{len(groups)} 族 / {sum(len(g['blocks']) for g in groups)} 個區塊"
          f" / 日股 {sum(g['jpN'] for g in groups)} 檔"
          f" / 台股 {sum(g['twN'] for g in groups)} 檔"
          f" -> {jp.INDEX_PATH.relative_to(twse.ROOT)}（{kb:.0f} KB）")
    print(f"日股到 {jp_last}、台股 {tw_dates[0]} ~ {tw_dates[-1]}"
          f"（{len(tw_dates)} 個交易日）")
    if dropped:
        print(f"! 沒有 K 線而略過的台股 {len(dropped)} 檔（沒進過排行就沒有 kline）")

    # 眼睛掃一下：這幾族的日股與台股應該同向，差很多就是哪裡接錯了
    for name in ("被動元件", "半導體設備 · 測試介面", "PCB · 載板"):
        g = next((x for x in groups if x["name"] == name), None)
        if g:
            names = "、".join(b["name"] or "整族" for b in g["blocks"])
            print(f"  {name:<18} 日股週 {g['jpMed'][1]}% / 台股週 {g['twMed'][1]}%"
                  f"（日 {g['jpN']} 檔、台 {g['twN']} 檔）")
            print(f"  {'':<18} {len(g['blocks'])} 塊：{names}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
