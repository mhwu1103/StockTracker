"""抓川普的新貼文 -> docs/data/trump/{truth,tweets}/YYYY-MM.json。

    python scripts/fetch_trump.py                     # 兩個來源都抓新的（排程跑的就是這個）
    python scripts/fetch_trump.py --since 2026-06-01  # 補歷史：Truth Social 一路往回翻到那一天
    python scripts/fetch_trump.py --source truth      # 只抓其中一個（truth／x）
    python scripts/fetch_trump.py --dry-run           # 只印出抓到什麼，不寫檔

只收他自己寫的、有字的貼文，理由見 scripts/trump.py 的 docstring。

## Truth Social：往回翻到接上為止

trumpstruth.org 的列表一頁 100 則、新的在前，底下有下一頁連結。增量與補歷史是
同一個迴圈，差別只在停在哪裡：

  · 補歷史（--since）：翻到這一頁最舊的一則早於那一天為止。
  · 增量：翻到接上已存的最後一則為止。平常第一頁就接上了（100 則約三天的量，
    而排程是每 3 小時一次）；排程停了幾天的話會自己多翻幾頁補回來 ——
    這一點跟 X 不一樣，X 漏掉就沒了。

頁與頁之間停 2 秒。這是別人維護的公益存檔，補歷史一次要翻三十幾頁。

## X：與 fetch_x.py（Serenity）同一套

首屏 5 則、已存過的只更新互動數、月檔不放時間戳，理由都寫在那一支。互動數要變
多少才改寫月檔的門檻也直接沿用那一支的 `_worth_updating`。
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime

import fetch_x
import serenity
import trump
import twse

# 除了 fetch_x 的那四個，觀看數也跟著覆寫：第一次抓到時多半才剛發幾分鐘，
# 只存第一次的數字等於永遠是低估。
METRICS = fetch_x.METRICS + ("views",)

# 增量模式最多往回翻幾頁。100 則一頁約三天，20 頁是兩個月 —— 排程停得比這還久的話
# 應該有人注意到了，改用 --since 明確地補。
MAX_PAGES = 20
PAGE_PAUSE = 2.0


def parse_args():
    ap = argparse.ArgumentParser(description="抓川普的新貼文（Truth Social 與 X）")
    ap.add_argument("--source", choices=("all", "truth", "x"), default="all")
    ap.add_argument("--since", help="補歷史：Truth Social 往回翻到這一天（YYYY-MM-DD）")
    ap.add_argument("--dry-run", action="store_true", help="只印出抓到什麼，不寫檔")
    return ap.parse_args()


def load_month(month: str, src: str) -> dict:
    path = trump.month_path(month, src)
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


def store(rows: list, src: str, *, dry_run: bool) -> tuple:
    """分月併進月檔。回傳 (新增數, 更新數, 寫了幾個檔)。"""
    buckets = {}
    for row in rows:
        month = serenity.month_of(row)
        if month not in buckets:
            buckets[month] = load_month(month, src)
    added = updated = 0
    for month, existing in buckets.items():
        a, u = merge(existing, [r for r in rows if serenity.month_of(r) == month])
        added += a
        updated += u

    written = 0
    for month, items in sorted(buckets.items()):
        ordered = sorted(items.values(), key=lambda r: (r.get("ts") or "", r["id"]))
        # 不放 updated 時間戳，理由同 fetch_x.write_months。
        payload = {"user": trump.USER, "src": src, "month": month,
                   "count": len(ordered), "items": ordered}
        if dry_run:
            print(f"  （dry-run）{src}/{month}: {len(ordered)} 則")
        elif twse.write_if_changed(trump.month_path(month, src), payload):
            written += 1
    return added, updated, written


def line(row: dict) -> str:
    text = (row.get("text") or "").replace("\n", " ")
    topics = "、".join(row.get("topics") or [])
    mark = "［背書］" if trump.is_endorsement(row.get("text")) else ""
    return (f"{row['ts'][:16]}  {mark}{text[:60]}{'…' if len(text) > 60 else ''}"
            + (f"  〔{topics}〕" if topics else ""))


# ---------------------------------------------------------------------------

def fetch_truth(state: dict, since: str | None, dry_run: bool) -> int:
    known = state.get("truth", {}).get("last_ts")
    # 補歷史時停在 since；增量時停在已存的最後一則。兩者都沒有（第一次跑、又沒給
    # --since）的話只抓第一頁，免得一不小心把整份存檔從 2022 年翻起。
    stop = f"{since}T00:00:00Z" if since else known
    limit = 400 if since else MAX_PAGES

    url = trump.TRUTH_LIST_URL
    rows = []
    pages = 0
    reached = False
    while url and pages < limit:
        if pages:
            time.sleep(PAGE_PAUSE)
        try:
            page = serenity.fetch_text(url, timeout=60)
        except Exception as err:  # noqa: BLE001
            print(f"! Truth Social 第 {pages + 1} 頁抓不到：{err}")
            break
        got, oldest, url = trump.parse_truth_list(page)
        pages += 1
        if oldest is None:
            print("! trumpstruth.org 的列表頁解析不出任何一則 —— 頁面結構可能變了")
            return 1
        # 補歷史要含 since 當天；增量則只要比已存的最後一則更新的
        rows.extend(r for r in got if not stop or (r["ts"] >= stop if since else r["ts"] > stop))
        print(f"  第 {pages} 頁：到 {oldest[:16]}，有字的 {len(got)} 則")
        if not stop or oldest < stop:
            reached = True
            break

    if stop and not reached:
        print(f"! 翻了 {pages} 頁還沒接上 {stop[:16]} —— 中間可能有缺口，"
              f"用 --since {stop[:10]} 明確地補")

    if not rows:
        print("Truth Social：沒有新的有字貼文")
    rows.sort(key=lambda r: r["ts"], reverse=True)
    added, _, written = store(rows, "truth", dry_run=dry_run)
    for row in rows[:10]:
        print(f"  ＋{line(row)}")
    if len(rows) > 10:
        print(f"  …另外 {len(rows) - 10} 則")
    print(f"Truth Social：新增 {added} 則，寫了 {written} 個月檔（翻了 {pages} 頁）")

    if not dry_run and rows:
        slot = state.setdefault("truth", {})
        newest = rows[0]["ts"]
        if not known or newest > known:
            slot.update({"last_id": rows[0]["id"], "last_ts": newest})
        if added:
            slot["last_new"] = datetime.now(twse.TAIPEI).isoformat(timespec="seconds")
    return 0


def fetch_x_latest(state: dict, dry_run: bool) -> int:
    try:
        rows, seen = trump.fetch_latest()
    except Exception as err:  # noqa: BLE001
        print(f"! 抓不到 X 的 profile：{type(err).__name__}: {err}")
        return 1
    if not seen:
        print("! X 的 profile 抓到了，但一則貼文都解析不出來 —— X 的頁面結構可能變了")
        return 1

    added, updated, written = store(rows, "x", dry_run=dry_run)
    print(f"X：首屏 {seen} 則，其中有字的 {len(rows)} 則")
    for row in rows:
        print(f"  {line(row)}")
    print(f"X：新增 {added} 則、更新 {updated} 則互動數，寫了 {written} 個月檔")

    if not dry_run:
        slot = state.setdefault("x", {})
        slot["parsed"] = seen
        if rows:
            slot.update({"last_id": rows[0]["id"], "last_ts": rows[0]["ts"]})
        if added:
            slot["last_new"] = datetime.now(twse.TAIPEI).isoformat(timespec="seconds")
    return 0


def main() -> int:
    args = parse_args()
    state = trump.load_state()
    # 舊版的 state.json 是 X 單一來源的平面結構，換成分來源的格式
    if "truth" not in state and "x" not in state:
        state = {}

    status = 0
    if args.source in ("all", "truth"):
        print("== Truth Social（trumpstruth.org）")
        status |= fetch_truth(state, args.since, args.dry_run)
    if args.source in ("all", "x"):
        print("== X")
        status |= fetch_x_latest(state, args.dry_run)

    if not args.dry_run:
        state["user"] = trump.USER
        state["checked"] = datetime.now(twse.TAIPEI).isoformat(timespec="seconds")
        twse.write_json(trump.STATE_PATH, state)
    return status


if __name__ == "__main__":
    raise SystemExit(main())
