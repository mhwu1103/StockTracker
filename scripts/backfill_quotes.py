"""用網頁典藏館（Wayback Machine）回補 TrendForce 報價的歷史。

TrendForce 的免費頁只顯示現在那一筆，走勢圖在會員區 —— 我們自己抓的歷史從安裝
這支腳本的那天才開始。Wayback 存了同一批頁面過去的樣子，解析方式與現抓完全相同，
所以可以拿來把序列往前接一段。

**這段歷史是稀疏的**：典藏頻率大約一個月一次，不是每天。現貨價因此只看得出大趨勢；
合約價與鋰電池材料本來就是半月或一個月更新一次，稀疏反而幾乎不損失資訊。
build_quotes.py 依每張表自己的 Last Update 去重，所以同一個報價日不會重複進去。

金屬與指數不必回補：Yahoo 的 chart API 本來就一次給五年，fetch_quotes.py 每次重抓。

用法：
    python scripts/backfill_quotes.py                     全部品類，2024 年起
    python scripts/backfill_quotes.py --since 2026-01-01
    python scripts/backfill_quotes.py --cat dram --limit 5
    python scripts/backfill_quotes.py --dry-run           只列出有哪些典藏，不抓
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime

import quotes

CDX_URL = "http://web.archive.org/cdx/search/cdx"
WAYBACK_RAW = "https://web.archive.org/web/{stamp}id_/{url}"


def list_snapshots(page_url: str, since: str, *, limit=0) -> list:
    """回傳該頁在 Wayback 上的典藏時間戳，一天最多算一次。"""
    params = (
        f"?url={page_url.replace('https://', '').replace('http://', '')}"
        "&output=json&fl=timestamp&filter=statuscode:200"
        "&collapse=timestamp:8&limit=3000"
    )
    try:
        rows = json.loads(quotes.fetch_text(CDX_URL + params, retries=2, timeout=60))
    except Exception as err:
        print(f"  ! 查不到典藏清單 —— {err}")
        return []
    stamps = [r[0] for r in rows[1:] if r and r[0].isdigit()]
    floor = since.replace("-", "")
    stamps = [s for s in stamps if s[:8] >= floor]
    return stamps[-limit:] if limit else stamps


def merge_into_snapshot(date_iso: str, tables: dict) -> tuple:
    """把典藏解出來的表併進當天的快照，只補「還沒有的表」。回傳 (新增表數, 新增品項數)。

    已經有的表一律不動：現抓的那一份永遠比典藏可信。
    """
    path = quotes.snapshot_path(date_iso)
    if path.exists():
        payload = quotes.read_json(path)
        payload.setdefault("tables", {})
        payload.setdefault("items", {})
    else:
        payload = {
            "fetched": f"{date_iso}T00:00:00+08:00",
            "source": "wayback",
            "tables": {},
            "items": {},
        }

    fresh = quotes.build_snapshot(tables, source="wayback")
    added_tables = 0
    added_items = 0
    for key, table in fresh["tables"].items():
        if key in payload["tables"]:
            continue
        payload["tables"][key] = dict(table, src="wayback")
        added_tables += 1
        for item_id, item in fresh["items"].items():
            if item["t"] == key:
                payload["items"][item_id] = item
                added_items += 1

    if not added_tables:
        return (0, 0)

    payload["tables"] = dict(sorted(payload["tables"].items()))
    payload["items"] = dict(sorted(payload["items"].items()))
    quotes.write_json(path, payload)
    return (added_tables, added_items)


def backfill_cat(cat_spec: dict, since: str, *, limit=0, dry_run=False, sleep=4.0) -> int:
    cat = cat_spec["cat"]
    page_url = quotes.TF_PAGE_URLS[cat]
    stamps = list_snapshots(page_url, since, limit=limit)
    print(f"{quotes.CAT_NAMES[cat]}：{page_url}")
    if not stamps:
        print("  沒有可用的典藏")
        return 0
    print(f"  {len(stamps)} 份典藏（{stamps[0][:8]} ~ {stamps[-1][:8]}）")
    if dry_run:
        return 0

    done = 0
    for stamp in stamps:
        date_iso = f"{stamp[:4]}-{stamp[4:6]}-{stamp[6:8]}"
        url = WAYBACK_RAW.format(stamp=stamp, url=page_url)
        try:
            got = quotes.fetch_tf_cat(cat_spec, url=url)
        except RuntimeError as err:
            print(f"  ! {date_iso} 抓不到 —— {err}")
            continue
        if not got:
            print(f"  · {date_iso} 解不出任何表（那時的版面可能不一樣）")
            continue
        tables, items = merge_into_snapshot(date_iso, got)
        asofs = sorted({t["asof"] for t in got.values() if t["asof"]})
        note = f"報價日 {asofs[0]} ~ {asofs[-1]}" if asofs else "沒有 Last Update"
        if tables:
            print(f"  {date_iso}：補進 {tables} 張表、{items} 個品項（{note}）")
            done += 1
        else:
            print(f"  · {date_iso} 已經有了，跳過")
        time.sleep(sleep)
    return done


def main() -> int:
    parser = argparse.ArgumentParser(description="用 Wayback 回補 TrendForce 報價歷史")
    parser.add_argument("--since", default="2024-01-01", help="只回補這個日期之後的典藏")
    parser.add_argument("--cat", action="append", help="只回補指定品類（可重複）")
    parser.add_argument("--limit", type=int, default=0, help="每個品類最多抓幾份典藏（取最新的）")
    parser.add_argument("--sleep", type=float, default=4.0, help="每次抓取之間等幾秒")
    parser.add_argument("--dry-run", action="store_true", help="只列出有哪些典藏")
    args = parser.parse_args()

    try:
        datetime.strptime(args.since, "%Y-%m-%d")
    except ValueError:
        print(f"--since 要是 YYYY-MM-DD，收到的是 {args.since!r}")
        return 2

    specs = quotes.TF_CATS
    if args.cat:
        specs = [c for c in quotes.TF_CATS if c["cat"] in args.cat]
        if not specs:
            print(f"沒有這些品類：{args.cat}；可用的是 {[c['cat'] for c in quotes.TF_CATS]}")
            return 2

    total = 0
    for spec in specs:
        total += backfill_cat(spec, args.since, limit=args.limit,
                              dry_run=args.dry_run, sleep=args.sleep)
        print()

    if args.dry_run:
        return 0
    print(f"共補進 {total} 個日期。接著執行：python scripts/build_quotes.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
