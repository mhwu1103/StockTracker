"""回補集保股權分散表的歷史。兩種來源，補出來的形狀完全不同。

集保的 opendata 只給最新那一週，帶 date 參數也沒用（回來的位元組數一字不差），
所以自己抓的歷史從裝上這支腳本的那一週才開始 —— 而一頁「趨勢」只有一個點是看不出
趨勢的。往前補有兩條路：

## --source wayback：全市場 × 極稀疏

Wayback 存了那個 CSV 網址過去的樣子，解析方式與現抓完全相同，一份就是全市場。
但那個網址**一年只被典藏兩三次**（2024 年起總共個位數份），所以補出來的點之間
可能隔了大半年，而且典藏站有 1 MB 的抓取上限，2.3 MB 的原始檔有幾份是被從中間
切斷的 —— 那幾份只涵蓋代號較前面的一段。

## --source stock：一批股票 × 真正的每一週

集保官網的個股查詢頁（qryStock）下拉選單留著**近一年的週資料日**，那是唯一補得到
「上週」的地方。代價是它一次只給「一檔 × 一週」，所以補一段歷史等於「週數 × 檔數」
次請求 —— 13 週 × 200 檔就是 2,600 次。只能補一批看得最多的股票（預設是最新一個
交易日的成交值前 200 名），補出來的那幾週因此是**部分涵蓋**的，快照上標成 partial，
畫面也會講明白：那幾週查不到的股票不是退出了集保，是我們沒去補它。

跑到一半被中斷不會白跑：已經補進快照的 (代號, 週) 下次會自動跳過。

用法：
    python scripts/backfill_holders.py --dry-run              只列出有哪些典藏
    python scripts/backfill_holders.py                        典藏館，2024 年起
    python scripts/backfill_holders.py --since 2025-01-01 --limit 3
    python scripts/backfill_holders.py --source stock         近 13 週 × 前 200 檔
    python scripts/backfill_holders.py --source stock --weeks 51 --top 100
    python scripts/backfill_holders.py --source stock --codes 2330,2454
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from urllib.parse import quote

import requests

import holders
import twse

CDX_URL = "http://web.archive.org/cdx/search/cdx"
WAYBACK_RAW = "https://web.archive.org/web/{stamp}id_/{url}"

# 一份 2.3 MB，典藏站又比原站慢得多，逾時要放寬、間隔要拉開
FETCH_TIMEOUT = 240
SLEEP = 5.0

# 逐檔查詢是幾千次小請求，間隔用不著典藏館那麼久，但也不該打成連發
STOCK_SLEEP = 0.35
STOCK_TIMEOUT = 45
STOCK_CHUNK = 50        # 每補完這麼多檔就寫一次盤，中斷了才不會整批白跑


def list_snapshots(since: str, *, limit=0) -> list:
    """回傳那個 CSV 在 Wayback 上的典藏時間戳，一天最多算一次。"""
    target = holders.TDCC_URL.replace("https://", "").replace("http://", "")
    params = (
        f"?url={quote(target, safe='')}"
        "&output=json&fl=timestamp&filter=statuscode:200"
        "&collapse=timestamp:8&limit=1000"
    )
    try:
        res = requests.get(CDX_URL + params, headers=holders.HEADERS, timeout=60)
        res.raise_for_status()
        rows = json.loads(res.text)
    except Exception as err:
        print(f"  ! 查不到典藏清單 —— {err}")
        return []
    stamps = [r[0] for r in rows[1:] if r and r[0].isdigit()]
    floor = since.replace("-", "")
    stamps = [s for s in stamps if s[:8] >= floor]
    return stamps[-limit:] if limit else stamps


def fetch_archived(stamp: str) -> str:
    url = WAYBACK_RAW.format(stamp=stamp, url=holders.TDCC_URL)
    res = requests.get(url, headers=holders.HEADERS, timeout=FETCH_TIMEOUT)
    res.raise_for_status()
    return res.content.decode("utf-8-sig", errors="replace")


# --------------------------------------------------------------------------- #
# 來源二：集保官網的個股查詢頁
# --------------------------------------------------------------------------- #
def open_form():
    """開查詢頁，拿回 (session, 一次性 token, 可查詢的週資料日清單)。"""
    session = requests.Session()
    session.headers.update(holders.HEADERS)
    page = session.get(holders.TDCC_STOCK_URL, timeout=STOCK_TIMEOUT).content.decode("utf-8", "replace")
    return session, holders.form_token(page), holders.form_dates(page)


def query_stock(session, token, code: str, day: str) -> tuple:
    """查一檔一週，回傳 ({級距: (人數, 股數)}, 下一個 token)。

    token 是一次性的：每送出一次就作廢，但回應頁裡就帶著下一個，接力用即可 ——
    否則每查一檔都得先 GET 一次表單，請求數直接翻倍。
    """
    data = {
        "SYNCHRONIZER_TOKEN": token,
        "SYNCHRONIZER_URI": "/portal/zh/smWeb/qryStock",
        "method": "submit",
        "firDate": day,
        "scaDate": day,
        "sqlMethod": "StockNo",
        "stockNo": code,
        "StockNo": code,
        "StockName": "",
    }
    res = session.post(holders.TDCC_STOCK_URL, data=data, timeout=STOCK_TIMEOUT)
    res.raise_for_status()
    page = res.content.decode("utf-8", "replace")
    try:
        nxt = holders.form_token(page)
    except RuntimeError:
        nxt = token
    return holders.parse_stock_page(page), nxt


def top_codes(limit: int) -> list:
    """最新一個交易日「全部」範圍的成交值前 N 名。"""
    day_dir = twse.DAILY_DIR / "all"
    files = sorted(day_dir.glob("*.json"))
    if not files:
        return []
    payload = holders.read_json(files[-1])
    ranked = sorted(payload.get("stocks") or [], key=lambda s: s.get("rank") or 9999)
    return [s["code"] for s in ranked[:limit]]


def backfill_stock(weeks: int, codes: list, sleep: float, dry_run: bool) -> int:
    session, token, days = open_form()
    if not days:
        print("  ! 查詢頁上沒有任何可選的資料日，版面可能改了")
        return 1
    days = days[:weeks]

    print(f"  查詢頁提供 {weeks} 週：{days[-1]} ~ {days[0]}（官方只保存一年）")
    print(f"  要補 {len(codes)} 檔 × {len(days)} 週，最多 {len(codes) * len(days):,} 次請求")
    if dry_run:
        print("\n--dry-run：不往下抓。")
        return 0

    total_added = 0
    for i, day in enumerate(days, 1):
        date_iso = f"{day[:4]}-{day[4:6]}-{day[6:]}"
        path = holders.snapshot_path(date_iso)
        have = set((holders.read_json(path).get("stocks") or {})) if path.exists() else set()
        todo = [c for c in codes if c not in have]
        if not todo:
            print(f"[{i}/{len(days)}] {date_iso}：{len(codes)} 檔都已經有了，略過")
            continue

        print(f"[{i}/{len(days)}] {date_iso}：要補 {len(todo)} 檔"
              + (f"（已有 {len(codes) - len(todo)} 檔）" if len(todo) < len(codes) else ""))
        got = {}
        failed = 0
        for n, code in enumerate(todo, 1):
            try:
                levels, token = query_stock(session, token, code, day)
            except Exception as err:
                print(f"    ! {code} 請求失敗（{err}），重開表單再試一次")
                try:
                    session, token, _ = open_form()
                    levels, token = query_stock(session, token, code, day)
                except Exception as err2:
                    print(f"    ! {code} 還是失敗（{err2}），跳過")
                    failed += 1
                    time.sleep(sleep)
                    continue
            if not levels:
                # 查不到多半是那一週還沒掛牌、或當週該檔沒有集保庫存，不是壞掉
                failed += 1
            else:
                row = holders.summarise(levels)
                if row:
                    got[code] = row
                else:
                    failed += 1
            # 每 STOCK_CHUNK 檔寫一次盤：跑一小時中途斷線不該把整批丟掉
            if got and n % STOCK_CHUNK == 0:
                added, _ = holders.merge_snapshot(date_iso, got, source="stock")
                total_added += added
                got = {}
                print(f"    · 已寫入 {n}/{len(todo)}")
            time.sleep(sleep)

        if got:
            added, _ = holders.merge_snapshot(date_iso, got, source="stock")
            total_added += added
        size = len(holders.read_json(holders.snapshot_path(date_iso)).get("stocks") or {})
        print(f"    {date_iso} 併完共 {size} 檔"
              + (f"，{failed} 檔查不到（多半是當週還沒掛牌或無集保庫存）" if failed else ""))

    print(f"\n完成：共補進 {total_added:,} 筆（檔 × 週）")
    print("接著執行：python scripts/build_holders.py")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="回補集保股權分散表的歷史")
    parser.add_argument("--source", choices=("wayback", "stock", "both"), default="wayback",
                        help="wayback 全市場但極稀疏（預設）／stock 一批股票但每一週都有")
    parser.add_argument("--since", default="2024-01-01", help="只抓這一天之後的典藏（wayback）")
    parser.add_argument("--limit", type=int, default=0, help="只抓最新的幾份（wayback）")
    parser.add_argument("--weeks", type=int, default=13, help="往回補幾週（stock，最多 51）")
    parser.add_argument("--top", type=int, default=200, help="補成交值前幾名（stock）")
    parser.add_argument("--codes", default="", help="改指定代號，逗號分隔（stock）")
    parser.add_argument("--sleep", type=float, default=STOCK_SLEEP, help="每次請求的間隔秒數（stock）")
    parser.add_argument("--dry-run", action="store_true", help="只列出要做什麼，不抓")
    args = parser.parse_args()

    if args.source in ("stock", "both"):
        codes = ([c.strip() for c in args.codes.split(",") if c.strip()]
                 if args.codes else top_codes(args.top))
        if not codes:
            print("找不到要補的代號：docs/data/daily/all/ 是空的，請先執行 fetch_daily.py")
            return 1
        print("集保官網個股查詢頁（每一週都有，但一次一檔）")
        code = backfill_stock(min(args.weeks, 51), codes, args.sleep, args.dry_run)
        if args.source == "stock":
            return code
        print()

    print(f"查詢典藏清單（{args.since} 起）…")
    stamps = list_snapshots(args.since, limit=args.limit)
    if not stamps:
        print("沒有任何可用的典藏。")
        return 1
    print(f"  {len(stamps)} 份典藏：{', '.join(s[:8] for s in stamps)}")

    if args.dry_run:
        print("\n--dry-run：不往下抓。")
        return 0

    have = set(holders.snapshot_dates())
    wrote = skipped = failed = 0
    for i, stamp in enumerate(stamps, 1):
        print(f"\n[{i}/{len(stamps)}] 典藏 {stamp[:8]}")
        try:
            text = fetch_archived(stamp)
        except Exception as err:
            print(f"  ! 抓不到 —— {err}")
            failed += 1
            time.sleep(SLEEP)
            continue
        try:
            date_iso, stocks, partial = holders.parse_csv(text)
        except RuntimeError as err:
            print(f"  ! 解不開 —— {err}")
            failed += 1
            time.sleep(SLEEP)
            continue

        # 典藏日與資料日不同是常態：週三被典藏到的那一份，裡面是上週五結算的資料
        note = "" if date_iso in have else "（新的資料日）"
        ok, why = holders.save_snapshot(date_iso, stocks, source="wayback",
                                        partial=partial, truncated=partial)
        if ok:
            wrote += 1
            have.add(date_iso)
            print(f"  資料日 {date_iso}{note}：{len(stocks)} 檔，已寫入"
                  + ("　※ 典藏被 1 MB 上限切斷，代號較後面的那一段沒抓到" if partial else ""))
        else:
            skipped += 1
            print(f"  資料日 {date_iso}：{why}，略過")
        time.sleep(SLEEP)

    print(f"\n完成：寫入 {wrote} 份、略過 {skipped} 份"
          + (f"、失敗 {failed} 份（下次再跑就會補上）" if failed else ""))
    print("接著執行：python scripts/build_holders.py")
    return 0 if wrote or skipped else 1


if __name__ == "__main__":
    sys.exit(main())
