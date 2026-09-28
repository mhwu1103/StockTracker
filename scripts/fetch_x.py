"""抓 X 帳號的新貼文 -> docs/data/x/<帳號>/tweets/<月或日>.json。

    python scripts/fetch_x.py                     # 每個帳號抓首屏的新貼文（排程跑的就是這個）
    python scripts/fetch_x.py --user elonmusk     # 只抓一個帳號
    python scripts/fetch_x.py --seed              # 首次建檔：有歷史存檔的帳號一次灌進來
    python scripts/fetch_x.py --dry-run           # 只印出抓到什麼，不寫檔

收哪幾個帳號在 scripts/xposts.py 的 ACCOUNTS。

## 為什麼要每 30 分鐘跑一次

profile 首屏一次只吐 5 則，而 Elon 日均約 70 則。跑得不夠勤就會漏，而且
**漏掉就沒了** —— 單篇 status 頁未登入只回 51 字摘要，補不回來（理由寫在
scripts/xposts.py）。所以排程頻率不是效能取捨，是資料完整性的一部分。

一個帳號抓失敗不擋其他帳號：X 偶爾對某一個 profile 回空殼，那不是另一個
帳號這一輪也不抓的理由。只要有任何一個失敗，整支就回非零，讓流程紅得起來。

## 已經存過的貼文只更新互動數

同一則貼文的讚數與回覆數會隨時間長，內文則不會變。重跑時互動數覆寫成新的、
內文保留原本那一份 —— 反過來做的話，付費貼文那 51 字的預覽有一天會蓋掉
歷史存檔裡的完整版本。

## --seed：歷史是借來的，不是自己抓的

目前只有 Serenity 有存檔可灌（Account.archive_url）；Elon 沒有可信的公開存檔，
從開始抓的那一天起算。

Serenity 從 2025-07 開始發文，累積六千多則，而上面說過歷史補不回來。GitHub 上
`yan-labs/serenity-aleabitoreddit` 有一份社群維護的存檔（6592 則，2025-07 到
2026-09-17，長貼文沒有被截斷），--seed 就是把那一份轉成這裡的格式灌進來。

那是**第三方整理的資料**，不是官方來源，也沒辦法逐則回頭驗證。所以：

  · 灌進來的每一則都標 `src: "archive"`，自己抓的不標。前端分得出來，
    哪天發現那份存檔有問題時也篩得出來。
  · 只在檔案還不存在時灌。已經有的不動 —— 自己抓到的那一份比較可信。

灌完之後接手的是排程的增量，兩邊在 2026-09-17 接軌。
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime

import twse
import xposts
from xposts import Account


def parse_args():
    ap = argparse.ArgumentParser(description="抓 X 帳號的新貼文")
    ap.add_argument("--user", choices=sorted(xposts.ACCOUNTS),
                    help="只處理這一個帳號（預設全部）")
    ap.add_argument("--seed", action="store_true",
                    help="首次建檔：把 GitHub 上的歷史存檔灌進來")
    ap.add_argument("--dry-run", action="store_true", help="只印出抓到什麼，不寫檔")
    return ap.parse_args()


def load_bucket(acct: Account, bucket: str) -> dict:
    """某個存檔（月或日）已存的貼文：{id: 貼文}。"""
    path = acct.bucket_path(bucket)
    if not path.exists():
        return {}
    try:
        rows = json.loads(path.read_text(encoding="utf-8")).get("items") or []
    except ValueError:
        print(f"! {path.name} 讀不動，當成空的重建")
        return {}
    return {r["id"]: r for r in rows if r.get("id")}


# 互動數要變動多少才值得改寫存檔：絕對值 20 或相對 5%，取先達到的那個。
#
# 這支腳本一天跑 48 次，而首屏那幾則的讚數**每一次都在變**。沒有門檻的話，
# 每一輪都會為了「讚數 +3」重寫整個存檔（壓縮過的 JSON 是一整行，git 看到的
# 是整檔變更），一年就是上萬個這種 commit。
#
# 代價是存下來的互動數最多差 5%。這裡的互動數是拿來看「哪一則引起共鳴」的相對
# 指標，不是要精確到個位數的東西，5% 換掉那些 commit 是划算的。
MIN_DELTA_ABS = 20
MIN_DELTA_REL = 0.05

METRICS = ("likes", "replies", "reposts", "bookmarks")


def _worth_updating(old: dict, new: dict) -> bool:
    for k in METRICS:
        fresh = new.get(k)
        if fresh is None:
            continue
        prev = old.get(k)
        if prev is None:
            return True
        diff = abs(fresh - prev)
        if diff >= MIN_DELTA_ABS or diff >= max(prev, 1) * MIN_DELTA_REL:
            return True
    return False


def merge(existing: dict, incoming: list) -> tuple:
    """把新抓到的併進已存的。回傳 (新增數, 更新數)。"""
    added = updated = 0
    for row in incoming:
        old = existing.get(row["id"])
        if old is None:
            existing[row["id"]] = row
            added += 1
            continue
        # 舊解析器存錯的引用推文：它把被引用那一則的長文當成了自己的內文，
        # 而且沒有 quote 欄位。新的一份帶著 quote 回來，就是那一則被存錯過的
        # 證據 —— 整則換掉。存檔灌進來的不動，那一份的內文本來就是對的。
        if row.get("quote") and not old.get("quote") and old.get("src") != "archive":
            existing[row["id"]] = row
            updated += 1
            continue
        # 互動數會長，內文不會變 —— 只覆寫前者。反過來做的話，付費貼文那 51 字
        # 的預覽有一天會蓋掉歷史存檔裡的完整版本。
        if not _worth_updating(old, row):
            continue
        for k in METRICS:
            if row.get(k) is not None:
                old[k] = row[k]
        updated += 1
    return added, updated


def write_buckets(acct: Account, buckets: dict, *, dry_run: bool = False) -> int:
    """把 {存檔名: {id: 貼文}} 寫回去。回傳寫了幾個檔。"""
    written = 0
    for bucket, rows in sorted(buckets.items()):
        ordered = sorted(rows.values(), key=lambda r: int(r["id"]))
        # 這裡**不能**放 updated 時間戳。write_if_changed 比的是整份 JSON 的文字，
        # 一個每次都變的欄位會讓它永遠判定「有變」—— 而這支腳本一天跑 48 次，
        # 那就是一天 48 個只有時間戳不同的 commit。這些檔是內容存檔，
        # 它的「更新時間」本來也沒有意義；抓取時間在 state.json 裡。
        payload = {
            "user": acct.user,
            "bucket": bucket,
            "count": len(ordered),
            "items": ordered,
        }
        if dry_run:
            print(f"  （dry-run）{bucket}: {len(ordered)} 則")
            continue
        if twse.write_if_changed(acct.bucket_path(bucket), payload):
            written += 1
    return written


def from_archive(acct: Account, raw: list) -> list:
    """把第三方存檔的格式轉成這裡的格式。

    來源欄位：{id, text, metrics:{likes,retweets,replies,bookmarks,views},
    createdAtISO, isReply, isQuote, isRetweet, lang}。
    """
    out = []
    for x in raw:
        tid = str(x.get("id") or "").strip()
        text = (x.get("text") or "").strip()
        if not tid.isdigit() or not text:
            continue
        m = x.get("metrics") or {}
        row = {
            "id": tid,
            # 一律用 id 解時間，不讀來源的 createdAtISO：那份存檔裡混了兩種
            # 格式（有的帶 +00:00、有的帶 Z），而 id 解出來的一定一致。
            "ts": xposts.ts_from_id(tid),
            "text": text,
            "likes": m.get("likes"),
            "replies": m.get("replies"),
            "reposts": m.get("retweets"),
            "bookmarks": m.get("bookmarks"),
            "views": m.get("views"),
            "reply": bool(x.get("isReply")) or None,
            "quote": bool(x.get("isQuote")) or None,
            "tickers": acct.tags_in(text),
            "url": f"https://x.com/{acct.user}/status/{tid}",
            "src": "archive",
        }
        out.append({k: v for k, v in row.items() if v is not None})
    return out


def seed(acct: Account, dry_run: bool = False) -> int:
    if not acct.archive_url:
        print(f"@{acct.user} 沒有歷史存檔可灌，跳過")
        return 0
    print(f"@{acct.user} 抓歷史存檔：{acct.archive_url}")
    raw = json.loads(xposts.fetch_text(acct.archive_url, timeout=120))
    rows = from_archive(acct, raw)
    print(f"  來源 {len(raw)} 則，可用 {len(rows)} 則")
    if not rows:
        print("! 歷史存檔是空的或格式變了")
        return 1

    buckets = defaultdict(dict)
    skipped = 0
    for row in rows:
        bucket = acct.bucket_of(row)
        if bucket not in buckets:
            buckets[bucket] = load_bucket(acct, bucket)
        if row["id"] in buckets[bucket]:
            skipped += 1
            continue
        buckets[bucket][row["id"]] = row

    written = write_buckets(acct, buckets, dry_run=dry_run)
    span = f"{rows[0]['ts'][:10]} ~ {rows[-1]['ts'][:10]}" if rows else "—"
    print(f"\n灌入完成：{len(rows) - skipped} 則新增、{skipped} 則已存在（{span}）")
    print(f"寫了 {written} 個檔 -> {acct.tweet_dir.relative_to(twse.ROOT)}")
    return 0


def update(acct: Account, dry_run: bool = False) -> int:
    print(f"== @{acct.user}")
    try:
        rows = xposts.fetch_latest(acct)
    except Exception as err:  # noqa: BLE001
        print(f"! 抓不到 profile：{type(err).__name__}: {err}")
        return 1

    if not rows:
        # 解析不出東西，多半是 X 換了首屏那份 blob 的長相。把它跟「這次沒有
        # 新貼文」分開報 —— 後者是常態，前者要有人去改 parse_profile。
        print("! profile 抓到了，但一則貼文都解析不出來 —— X 的頁面結構可能變了")
        return 1

    print(f"首屏 {len(rows)} 則（{rows[-1]['ts'][:16]} ~ {rows[0]['ts'][:16]}）")

    buckets = {}
    for row in rows:
        bucket = acct.bucket_of(row)
        if bucket not in buckets:
            buckets[bucket] = load_bucket(acct, bucket)

    # 哪幾則是新的，要在 merge 之前問 —— merge 之後 buckets 裡就全都在了。
    fresh = {r["id"] for r in rows if r["id"] not in buckets[acct.bucket_of(r)]}

    added, updated = 0, 0
    for bucket, existing in buckets.items():
        a, u = merge(existing, [r for r in rows if acct.bucket_of(r) == bucket])
        added += a
        updated += u

    for row in rows:
        mark = (" [付費預覽]" if row.get("locked") else "") + (" [置頂]" if row.get("pinned") else "")
        if row.get("quote"):
            mark += f" [引用 @{row['quote'].get('u')}]"
        if row.get("repost_of"):
            mark += f" [轉推 @{row['repost_of']}]"
        print(f"  {'＋' if row['id'] in fresh else '  '}{row['ts'][:16]}"
              f"  讚 {row['likes'] or 0:>7}  {'、'.join(row['tickers']) or '—':<24}{mark}")

    if dry_run:
        write_buckets(acct, buckets, dry_run=True)
        return 0

    written = write_buckets(acct, buckets)
    print(f"\n新增 {added} 則、更新 {updated} 則，寫了 {written} 個檔")

    # 游標與健康狀態。排程沒跑到、或頁面結構變了的時候，這一份是唯一看得出
    # 「多久沒有真的抓到東西」的地方。
    latest = max(rows, key=lambda r: int(r["id"]))
    state = acct.load_state()
    state.update({
        "user": acct.user,
        "last_id": latest["id"],
        "last_ts": latest["ts"],
        "checked": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "parsed": len(rows),
    })
    if added:
        state["last_new"] = state["checked"]
    twse.write_json(acct.state_path, state)

    # 如果每次都是滿屏的新貼文，代表首屏已經裝不下兩次排程之間的產量，
    # 也就是**正在漏**。這時要調高排程頻率。置頂文不算 —— 它永遠是舊的，
    # 算進去的話整屏五則最多四則新，這個警告永遠不會響。
    timeline = [r for r in rows if not r.get("pinned")]
    if timeline and all(r["id"] in fresh for r in timeline):
        print("! 首屏整屏都是新的 —— 兩次排程之間他發的量已經超過首屏容量，"
              "很可能漏了。考慮把 .github/workflows/x.yml 的間隔再調短。")
    return 0


def main() -> int:
    args = parse_args()
    accounts = [xposts.ACCOUNTS[args.user]] if args.user else list(xposts.ACCOUNTS.values())
    step = seed if args.seed else update
    failed = 0
    for acct in accounts:
        if step(acct, dry_run=args.dry_run):
            failed += 1
        print()
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
