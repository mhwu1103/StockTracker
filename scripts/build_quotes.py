"""由快照與 market.json 算出報價分頁要吃的兩種檔案。

    docs/data/quotes/index.json         品項目錄：最新報價、各期間漲跌、對應族群
    docs/data/quotes/series/{cat}.json  該品類所有品項的完整序列

## 為什麼要「依報價日去重」

快照的檔名是抓取日，但一張表可能一個月才更新一次 —— 天天抓就會存下 30 份一模一樣的
數字。序列以每張表自己的 Last Update（asof）為橫軸，同一個 asof 只留一個點，
取最後一次抓到的那個值（後抓的比較可信，官方偶爾會回頭修數字）。

所以圖上的點距不等寬：現貨一天一點，合約一個月一點。這是報價本身的節奏，
不是資料缺漏，前端要照 freq 標出來。

用法：
    python scripts/build_quotes.py
"""

from __future__ import annotations

import sys
from datetime import date, datetime, timedelta

import quotes
import twse

# 各期間漲跌用日曆日往回找，不是交易日 —— 報價本身就不是每個交易日都動。
WINDOWS = [("w1", 7), ("m1", 30), ("m3", 90), ("y1", 365)]


def load_snapshots() -> tuple:
    """讀完所有快照，回傳 (series, meta, tables)。

    series[series_id][asof] = (value, change)  依報價日去重，後抓的覆蓋先抓的
    meta[series_id]         = 最後一次見到的品項資訊（名稱可能改，取最新的）
    tables[table_key]       = 最後一次見到的表資訊（含 asof）
    """
    series = {}
    meta = {}
    tables = {}
    bad = 0
    dates = quotes.snapshot_dates()
    for snap_date in dates:
        payload = quotes.read_json(quotes.snapshot_path(snap_date))
        snap_tables = payload.get("tables") or {}
        for key, table in snap_tables.items():
            tables[key] = dict(table, snap=snap_date)
        for item_id, item in (payload.get("items") or {}).items():
            table = snap_tables.get(item["t"])
            asof = (table or {}).get("asof") or snap_date
            if not sane(item):
                bad += 1
                print(f"  · 跳過 {snap_date} 的 {item['n']}：均價 {item['v']} 落在"
                      f"高低點 {item.get('lo')}~{item.get('hi')} 之外")
                continue
            series.setdefault(item_id, {})[asof] = (item["v"], item.get("c"))
            meta[item_id] = item
    dropped = drop_unkeyed(series, meta)
    print(f"讀了 {len(dates)} 份快照，{len(series)} 條 TrendForce 序列"
          + (f"，跳過 {bad} 筆不合理的數字" if bad else "")
          + (f"，丟掉 {dropped} 條認不出品項編號的序列" if dropped else ""))
    return series, meta, tables


def drop_unkeyed(series, meta) -> int:
    """丟掉「該用品項編號、卻只有名字雜湊」的序列。

    TrendForce 每一列的走勢圖連結帶一個穩定的 type 編號，那是最可靠的品項 ID。
    但比較早的典藏頁沒有那一欄，只能拿名字的雜湊當 ID —— 而名字會微幅改寫
    （「DDR5 16G」後來寫成「DDR5 16Gb」），雜湊就接不回同一條序列，
    結果是一批看起來像「已停止報價」的分身。

    判準是每張表自己的習慣：這張表只要有任何一列拿得到 type 編號，
    同一張表裡拿不到的那些列就是接不起來的，寧可不要。
    ssd_street 與 PC OEM SSD 這種本來就沒有走勢圖的表不受影響。
    """
    keyed = set()
    for item_id in series:
        cat, tab, key = item_id.split(":", 2)
        if key.isdigit():
            keyed.add((cat, tab))
    doomed = [i for i in series
              if (i.split(":", 2)[0], i.split(":", 2)[1]) in keyed
              and not i.split(":", 2)[2].isdigit()]
    for item_id in doomed:
        series.pop(item_id, None)
        meta.pop(item_id, None)
    return len(doomed)


def sane(item) -> bool:
    """均價必須落在高低點之間，否則那一格是來源網站打錯字。

    真的發生過：2025-03-12 的「N型致密料」高點 42、低點 37、均價 4.00 ——
    照抄下去圖上就是一次 -90% 的暴跌。快照保留原始數字（那是抓到什麼的紀錄），
    序列這一端把它丟掉。留 5% 的餘裕給四捨五入。
    """
    low, high, value = item.get("lo"), item.get("hi"), item.get("v")
    if low is None or high is None or value is None:
        return True
    return low * 0.95 <= value <= high * 1.05


def pct(now, then):
    if now is None or then is None or then == 0:
        return None
    return round((now / then - 1) * 100, 2)


def value_at_or_before(days, values, cutoff: str, floor: str):
    """序列裡最後一個日期落在 [floor, cutoff] 之間的 (日期, 值)；沒有就回 (None, None)。

    floor 是不能省的：報價的歷史稀疏（典藏一個月才一份），少了下限的話
    「近一月」會拿到一年前的那一筆去比，算出來的數字是真的，標籤卻是假的。
    """
    found = (None, None)
    for day, value in zip(days, values):
        if day > cutoff:
            break
        if day >= floor:
            found = (day, value)
    return found


def changes(days, values) -> dict:
    """各期間漲跌幅。基準是「最後一筆的日期往回推 N 個日曆日」附近的那一筆。

    容許的誤差是 N 天本身（基準取 [今-2N, 今-N] 之間最靠近 cutoff 的一筆），
    所以實際區間最長是名目的兩倍，不會出現「近一月」其實隔了半年的情況。
    """
    if not days:
        return {}
    anchor = date.fromisoformat(days[-1])
    out = {}
    for key, back in WINDOWS:
        cutoff = (anchor - timedelta(days=back)).isoformat()
        floor = (anchor - timedelta(days=back * 2)).isoformat()
        base = value_at_or_before(days, values, cutoff, floor)[1]
        got = pct(values[-1], base)
        if got is not None:
            out[key] = got
    return out


def theme_names(path) -> set:
    """themes.json 裡所有 (大族群, 子族群) 的組合，用來檢查對照表有沒有寫錯字。"""
    try:
        payload = quotes.read_json(path)
    except Exception:
        return set()
    out = set()
    for group in payload.get("groups") or []:
        for sub in group.get("subs") or []:
            out.add((group["name"], sub["name"]))
    return out


def build_items(series, meta, tables) -> list:
    """TrendForce 那一半的品項清單。"""
    items = []
    for item_id, by_asof in series.items():
        info = meta[item_id]
        cat, tab = item_id.split(":", 2)[:2]
        spec = quotes.TF_TAB_SPECS.get((cat, tab))
        if not spec:
            continue
        days = sorted(by_asof)
        values = [by_asof[d][0] for d in days]
        last_chg = by_asof[days[-1]][1]
        chg = changes(days, values)
        if last_chg is not None:
            chg["prev"] = last_chg
        items.append({
            "id": item_id,
            "cat": cat,
            "kind": quotes.CAT_KINDS[cat],
            "table": spec["label"],
            "title": (tables.get(f"{cat}:{tab}") or {}).get("title", spec["label"]),
            "name": info["n"],
            "unit": spec["unit"],
            "cur": info.get("cur") or "USD",
            "freq": spec["freq"],
            "themes": spec["themes"],
            "last": {"d": days[-1], "v": values[-1]},
            "chg": chg,
            "n": len(days),
            "first": days[0],
            "days": days,
            "values": values,
        })
    return items


def build_market_items() -> list:
    """Yahoo 那一半：金屬、能源、指數。"""
    if not quotes.MARKET_PATH.exists():
        print("! 找不到 market.json，金屬與指數這次不會出現在報價頁")
        return []
    payload = quotes.read_json(quotes.MARKET_PATH)
    items = []
    for spec in quotes.YAHOO_ITEMS:
        node = (payload.get("items") or {}).get(spec["id"])
        if not node:
            print(f"! market.json 裡沒有 {spec['name']}（{spec['sym']}）")
            continue
        days, values = node["d"], node["v"]
        if not days:
            continue
        chg = changes(days, values)
        if len(values) >= 2:
            got = pct(values[-1], values[-2])
            if got is not None:
                chg["prev"] = got
        items.append({
            "id": f"{spec['cat']}:{spec['id']}",
            "cat": spec["cat"],
            "kind": quotes.CAT_KINDS[spec["cat"]],
            "table": quotes.CAT_NAMES[spec["cat"]],
            "title": spec["sym"],
            "name": spec["name"],
            "unit": spec["unit"],
            "cur": "",
            "freq": "每日",
            "themes": spec["themes"],
            "why": spec["why"],
            "last": {"d": days[-1], "v": values[-1]},
            "chg": chg,
            "n": len(days),
            "first": days[0],
            "days": days,
            "values": values,
        })
    print(f"market.json：{len(items)} 條金屬／能源／指數序列")
    return items


def mark_stale(items) -> int:
    """標出「已經不在最新那張表上」的品項。

    回補歷史會撈到早就停止報價的品項（TrendForce 換過規格、下架過品項），
    它們的序列有價值，但混在清單裡就是一批看起來很新、其實停在一年前的數字。
    判準取每張表自己的最新報價日：那一天的表上沒有它，它就是停更的。
    """
    latest = {}
    for item in items:
        key = (item["cat"], item["table"])
        latest[key] = max(latest.get(key, ""), item["last"]["d"])
    stale = 0
    for item in items:
        if item["last"]["d"] < latest[(item["cat"], item["table"])]:
            item["stale"] = True
            stale += 1
    if stale:
        print(f"  其中 {stale} 個品項已不在最新的表上，前端會單獨列出")
    return stale


def write_series(items) -> int:
    """一個品類一個檔：共用一條日期軸，各品項存 [日期序號, 值]。"""
    by_cat = {}
    for item in items:
        by_cat.setdefault(item["cat"], []).append(item)

    written = 0
    for cat, group in by_cat.items():
        all_days = sorted({d for item in group for d in item["days"]})
        at = {d: i for i, d in enumerate(all_days)}
        payload = {
            "cat": cat,
            "name": quotes.CAT_NAMES[cat],
            "dates": all_days,
            "items": {
                item["id"]: [[at[d], v] for d, v in zip(item["days"], item["values"])]
                for item in group
            },
        }
        path = quotes.write_json(quotes.series_path(cat), payload)
        print(f"  {quotes.CAT_NAMES[cat]}：{len(group)} 個品項、{len(all_days)} 個報價日"
              f" -> {path.relative_to(twse.ROOT)}")
        written += 1
    return written


def main() -> int:
    series, meta, tables = load_snapshots()
    items = build_items(series, meta, tables) + build_market_items()
    if not items:
        print("沒有任何報價資料。請先執行 scripts/fetch_quotes.py。")
        return 1

    # 對照表寫錯字的話前端會靜靜地畫不出族群線，所以在這裡就吵出來
    known = theme_names(twse.DATA_DIR / "themes.json")
    if known:
        bad = sorted({tuple(t) for item in items for t in item["themes"]} - known)
        for group, sub in bad:
            print(f"! 對照表裡的族群名對不上 themes.json：{group} / {sub}")

    mark_stale(items)
    cat_order = {c["key"]: i for i, c in enumerate(quotes.CATS)}
    items.sort(key=lambda x: (cat_order.get(x["cat"], 99), x["table"], x["name"]))
    write_series(items)

    cats = []
    for spec in quotes.CATS:
        group = [i for i in items if i["cat"] == spec["key"]]
        if not group:
            continue
        live = [i for i in group if not i.get("stale")] or group
        cats.append({
            "key": spec["key"],
            "name": spec["name"],
            "kind": spec["kind"],
            "source": spec["source"],
            "url": quotes.TF_PAGE_URLS.get(spec["key"], quotes.YAHOO_CHART),
            "n": len(live),
            "retired": len(group) - len(live),
            "latest": max(i["last"]["d"] for i in live),
        })

    index = {
        "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "latest": max(i["last"]["d"] for i in items if not i.get("stale")),
        "cats": cats,
        "items": [{k: v for k, v in item.items() if k not in ("days", "values")} for item in items],
    }
    path = quotes.write_json(quotes.QUOTES_INDEX_PATH, index)
    print(f"  目錄：{len(items)} 個品項、{len(cats)} 個品類 -> {path.relative_to(twse.ROOT)}")

    thin = [i for i in items if i["n"] < 2]
    if thin:
        print(f"\n注意：{len(thin)} 個品項只有 1 個報價日，畫不出走勢 —— "
              "TrendForce 的歷史要靠每天累積，或先跑 scripts/backfill_quotes.py。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
