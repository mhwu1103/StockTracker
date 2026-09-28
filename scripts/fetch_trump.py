"""抓 @realDonaldTrump 的新貼文 -> docs/data/trump/tweets/YYYY-MM.json。

    python scripts/fetch_trump.py             # 抓首屏的新貼文（排程跑的就是這個）
    python scripts/fetch_trump.py --dry-run   # 只印出抓到什麼，不寫檔

與 fetch_x.py（Serenity）是同一套做法：每 3 小時讀一次 profile 首屏、已存過的
只更新互動數、月檔不放時間戳。理由都寫在那一支的 docstring，這裡不重複。
互動數要變多少才改寫月檔的門檻也直接沿用那一支的 `_worth_updating`。

## 沒有 --seed

Serenity 那頁有一份社群存檔可以灌歷史，這裡沒有：他 X 上的舊貼文沒有公開存檔，
Truth Social 的存檔停在 2026-05 而且不是同一個平台（理由見 scripts/trump.py）。
所以這一頁的歷史從第一次排程開始累積。

## 首屏容量

他的發文量很不平均：平常一天幾則，有時候六分鐘連發五段影片（2026-09-27 的
首屏就是這樣）。後者一次就把首屏塞滿，所以「整屏都是新的」的警告在這個帳號上
比 Serenity 更常出現 —— 看到的時候代表那一輪之前可能還有沒抓到的。
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime

import fetch_x
import serenity
import trump
import twse

# 除了 fetch_x 的那四個，觀看數也跟著覆寫：他一則影片是幾百萬觀看，第一次抓到
# 時多半才剛發幾分鐘，只存第一次的數字等於永遠是低估。
METRICS = fetch_x.METRICS + ("views",)


def parse_args():
    ap = argparse.ArgumentParser(description="抓 @realDonaldTrump 的新貼文")
    ap.add_argument("--dry-run", action="store_true", help="只印出抓到什麼，不寫檔")
    return ap.parse_args()


def load_month(month: str) -> dict:
    path = trump.month_path(month)
    if not path.exists():
        return {}
    try:
        rows = json.loads(path.read_text(encoding="utf-8")).get("items") or []
    except ValueError:
        print(f"! {path.name} 讀不動，當成空的重建")
        return {}
    return {r["id"]: r for r in rows if r.get("id")}


def merge(existing: dict, incoming: list) -> tuple:
    """把新抓到的併進已存的。回傳 (新增數, 更新數)。內文不覆寫，只更新互動數。"""
    added = updated = 0
    for row in incoming:
        old = existing.get(row["id"])
        if old is None:
            existing[row["id"]] = row
            added += 1
            continue
        if not fetch_x._worth_updating(old, row):
            continue
        for k in METRICS:
            if row.get(k) is not None:
                old[k] = row[k]
        updated += 1
    return added, updated


def write_months(buckets: dict, *, dry_run: bool = False) -> int:
    written = 0
    for month, rows in sorted(buckets.items()):
        ordered = sorted(rows.values(), key=lambda r: int(r["id"]))
        # 不放 updated 時間戳，理由同 fetch_x.write_months。
        payload = {"user": trump.USER, "month": month, "count": len(ordered), "items": ordered}
        if dry_run:
            print(f"  （dry-run）{month}: {len(ordered)} 則")
            continue
        if twse.write_if_changed(trump.month_path(month), payload):
            written += 1
    return written


def describe(row: dict) -> str:
    """一則貼文印在 log 裡的樣子。他多半是影片，只印內文的話一整排都是空的。"""
    media = row.get("media") or []
    if media:
        m = media[0]
        kind = "影片" if m.get("type") in ("video", "animated_gif") else "圖片"
        sec = f" {m['ms'] // 1000} 秒" if m.get("ms") else ""
        head = f"[{kind}{sec}]"
    else:
        head = ""
    text = (row.get("text") or "").replace("\n", " ")
    topics = "、".join(row.get("topics") or [])
    return f"{head} {text[:60]}{'…' if len(text) > 60 else ''}" + (f"  〔{topics}〕" if topics else "")


def main() -> int:
    args = parse_args()
    try:
        rows = trump.fetch_latest()
    except Exception as err:  # noqa: BLE001
        print(f"! 抓不到 profile：{type(err).__name__}: {err}")
        return 1

    if not rows:
        print("! profile 抓到了，但一則貼文都解析不出來 —— X 的頁面結構可能變了")
        return 1

    print(f"首屏 {len(rows)} 則（{rows[-1]['ts'][:16]} ~ {rows[0]['ts'][:16]}）")

    buckets = {}
    for row in rows:
        month = serenity.month_of(row)
        if month not in buckets:
            buckets[month] = load_month(month)

    fresh = {r["id"] for r in rows if r["id"] not in buckets[serenity.month_of(r)]}

    added = updated = 0
    for month, existing in buckets.items():
        a, u = merge(existing, [r for r in rows if serenity.month_of(r) == month])
        added += a
        updated += u

    for row in rows:
        print(f"  {'＋' if row['id'] in fresh else '  '}{row['ts'][:16]}"
              f"  讚 {row.get('likes') or 0:>6}  {describe(row)}")

    if args.dry_run:
        write_months(buckets, dry_run=True)
        return 0

    written = write_months(buckets)
    print(f"\n新增 {added} 則、更新 {updated} 則互動數，寫了 {written} 個月檔")

    state = trump.load_state()
    state.update({
        "user": trump.USER,
        "last_id": rows[0]["id"],
        "last_ts": rows[0]["ts"],
        "checked": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "parsed": len(rows),
    })
    if added:
        state["last_new"] = state["checked"]
    twse.write_json(trump.STATE_PATH, state)

    if added >= len(rows):
        print("! 首屏整屏都是新的 —— 上一輪之後他發的量已經超過首屏容量，中間可能漏了。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
