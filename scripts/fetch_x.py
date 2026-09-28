"""抓 @aleabitoreddit 的新貼文 -> docs/data/x/tweets/YYYY-MM.json。

    python scripts/fetch_x.py                 # 抓首屏的新貼文（排程跑的就是這個）
    python scripts/fetch_x.py --seed          # 首次建檔：把歷史存檔一次灌進來
    python scripts/fetch_x.py --dry-run       # 只印出抓到什麼，不寫檔

## 為什麼要每 3 小時跑一次

profile 首屏一次只吐 5 則，而他日均約 15 則。每天跑一次會漏掉大半，而且
**漏掉就沒了** —— 單篇 status 頁未登入只回 51 字摘要，補不回來（理由寫在
scripts/serenity.py）。所以排程頻率不是效能取捨，是資料完整性的一部分。

## 已經存過的貼文只更新互動數

同一則貼文的讚數與回覆數會隨時間長，內文則不會變。重跑時互動數覆寫成新的、
內文保留原本那一份 —— 反過來做的話，付費貼文那 51 字的預覽有一天會蓋掉
歷史存檔裡的完整版本。

## --seed：歷史是借來的，不是自己抓的

他從 2025-07 開始發文，累積六千多則，而上面說過歷史補不回來。GitHub 上
`yan-labs/serenity-aleabitoreddit` 有一份社群維護的存檔（6592 則，2025-07 到
2026-09-17，長貼文沒有被截斷），--seed 就是把那一份轉成這裡的格式灌進來。

那是**第三方整理的資料**，不是官方來源，也沒辦法逐則回頭驗證。所以：

  · 灌進來的每一則都標 `src: "archive"`，自己抓的不標。前端分得出來，
    哪天發現那份存檔有問題時也篩得出來。
  · 只在檔案還不存在時灌。已經有的不動 —— 自己抓到的那一份比較可信。

灌完之後接手的是每 3 小時一次的增量，兩邊在 2026-09-17 接軌。
"""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from datetime import datetime

import serenity
import twse

ARCHIVE_URL = ("https://raw.githubusercontent.com/yan-labs/serenity-aleabitoreddit"
               "/HEAD/data/aleabitoreddit_tweets.json")


def parse_args():
    ap = argparse.ArgumentParser(description="抓 @aleabitoreddit 的新貼文")
    ap.add_argument("--seed", action="store_true",
                    help="首次建檔：把 GitHub 上的歷史存檔灌進來")
    ap.add_argument("--dry-run", action="store_true", help="只印出抓到什麼，不寫檔")
    return ap.parse_args()


def load_month(month: str) -> dict:
    """某個月已存的貼文：{id: 貼文}。"""
    path = serenity.month_path(month)
    if not path.exists():
        return {}
    try:
        rows = json.loads(path.read_text(encoding="utf-8")).get("items") or []
    except ValueError:
        print(f"! {path.name} 讀不動，當成空的重建")
        return {}
    return {r["id"]: r for r in rows if r.get("id")}


# 互動數要變動多少才值得改寫月檔：絕對值 20 或相對 5%，取先達到的那個。
#
# 這支腳本一天跑 8 次，而首屏那幾則的讚數**每一次都在變**。沒有門檻的話，
# 每一輪都會為了「讚數 +3」重寫整個當月檔（壓縮過的 JSON 是一整行，git 看到的
# 是整檔變更），一年就是近三千個這種 commit。
#
# 代價是存下來的互動數最多差 5%。這裡的互動數是拿來看「哪一則引起共鳴」的相對
# 指標，不是要精確到個位數的東西，5% 換掉那三千個 commit 是划算的。
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
        # 互動數會長，內文不會變 —— 只覆寫前者。反過來做的話，付費貼文那 51 字
        # 的預覽有一天會蓋掉歷史存檔裡的完整版本。
        if not _worth_updating(old, row):
            continue
        for k in METRICS:
            if row.get(k) is not None:
                old[k] = row[k]
        updated += 1
    return added, updated


def write_months(buckets: dict, *, dry_run: bool = False) -> int:
    """把 {月份: {id: 貼文}} 寫回月檔。回傳寫了幾個檔。"""
    written = 0
    for month, rows in sorted(buckets.items()):
        ordered = sorted(rows.values(), key=lambda r: int(r["id"]))
        # 這裡**不能**放 updated 時間戳。write_if_changed 比的是整份 JSON 的文字，
        # 一個每次都變的欄位會讓它永遠判定「有變」—— 而這支腳本一天跑 8 次，
        # 那就是一天 8 個只有時間戳不同的 commit。月檔是內容存檔，
        # 它的「更新時間」本來也沒有意義；抓取時間在 state.json 裡。
        payload = {
            "user": serenity.USER,
            "month": month,
            "count": len(ordered),
            "items": ordered,
        }
        if dry_run:
            print(f"  （dry-run）{month}: {len(ordered)} 則")
            continue
        if twse.write_if_changed(serenity.month_path(month), payload):
            written += 1
    return written


def from_archive(raw: list) -> list:
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
            "ts": serenity.ts_from_id(tid),
            "text": text,
            "likes": m.get("likes"),
            "replies": m.get("replies"),
            "reposts": m.get("retweets"),
            "bookmarks": m.get("bookmarks"),
            "views": m.get("views"),
            "reply": bool(x.get("isReply")) or None,
            "quote": bool(x.get("isQuote")) or None,
            "tickers": serenity.tickers_in(text),
            "url": f"https://x.com/{serenity.USER}/status/{tid}",
            "src": "archive",
        }
        out.append({k: v for k, v in row.items() if v is not None})
    return out


def seed(dry_run: bool = False) -> int:
    print(f"抓歷史存檔：{ARCHIVE_URL}")
    raw = json.loads(serenity.fetch_text(ARCHIVE_URL, timeout=120))
    rows = from_archive(raw)
    print(f"  來源 {len(raw)} 則，可用 {len(rows)} 則")
    if not rows:
        print("! 歷史存檔是空的或格式變了")
        return 1

    buckets = defaultdict(dict)
    skipped = 0
    for row in rows:
        month = serenity.month_of(row)
        if month not in buckets:
            existing = load_month(month)
            buckets[month] = existing
        if row["id"] in buckets[month]:
            skipped += 1
            continue
        buckets[month][row["id"]] = row

    written = write_months(buckets, dry_run=dry_run)
    span = f"{rows[0]['ts'][:10]} ~ {rows[-1]['ts'][:10]}" if rows else "—"
    print(f"\n灌入完成：{len(rows) - skipped} 則新增、{skipped} 則已存在（{span}）")
    print(f"寫了 {written} 個月檔 -> {serenity.TWEET_DIR.relative_to(twse.ROOT)}")
    return 0


def main() -> int:
    args = parse_args()
    if args.seed:
        return seed(dry_run=args.dry_run)

    try:
        rows = serenity.fetch_latest()
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
        month = serenity.month_of(row)
        if month not in buckets:
            buckets[month] = load_month(month)

    # 哪幾則是新的，要在 merge 之前問 —— merge 之後 buckets 裡就全都在了。
    fresh = {r["id"] for r in rows if r["id"] not in buckets[serenity.month_of(r)]}

    added, updated = 0, 0
    for month, existing in buckets.items():
        a, u = merge(existing, [r for r in rows if serenity.month_of(r) == month])
        added += a
        updated += u

    for row in rows:
        mark = " [付費預覽]" if row.get("locked") else ""
        print(f"  {'＋' if row['id'] in fresh else '  '}{row['ts'][:16]}"
              f"  讚 {row['likes'] or 0:>5}  {'、'.join(row['tickers']) or '—':<24}{mark}")

    if args.dry_run:
        write_months(buckets, dry_run=True)
        return 0

    written = write_months(buckets)
    print(f"\n新增 {added} 則、更新 {updated} 則互動數，寫了 {written} 個月檔")

    # 游標與健康狀態。排程沒跑到、或頁面結構變了的時候，這一份是唯一看得出
    # 「多久沒有真的抓到東西」的地方。
    state = serenity.load_state()
    state.update({
        "user": serenity.USER,
        "last_id": rows[0]["id"],
        "last_ts": rows[0]["ts"],
        "checked": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "parsed": len(rows),
    })
    if added:
        state["last_new"] = state["checked"]
    twse.write_json(serenity.STATE_PATH, state)

    # 一次抓 5 則、他日均 15 則：如果每次都是滿的 5 則新貼文，代表首屏已經
    # 裝不下兩次排程之間的產量，也就是**正在漏**。這時要調高排程頻率。
    if added >= len(rows):
        print("! 首屏整屏都是新的 —— 兩次排程之間他發的量已經超過首屏容量，"
              "很可能漏了。考慮把 .github/workflows/x.yml 的間隔再調短。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
