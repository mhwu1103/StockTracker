"""逐日回補歷史成交值排行。可中斷、可續跑（已存在的日期自動跳過）。

上市走證交所的 MI_INDEX，上櫃走櫃買中心的 dailyQuotes，兩者都能指定任一交易日。

用法：
    python scripts/backfill.py --from 2024-08-01 --to 2026-08-15
    python scripts/backfill.py --days 90                  # 回補最近 90 個日曆天
    python scripts/backfill.py --days 90 --force          # 連已存在的日期也重抓
    python scripts/backfill.py --days 90 --scope tpex     # 只補上櫃
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import date, timedelta

import twse


def parse_args():
    parser = argparse.ArgumentParser(description="回補台股歷史成交值排行")
    parser.add_argument("--from", dest="start", help="起始日期 YYYY-MM-DD")
    parser.add_argument("--to", dest="end", help="結束日期 YYYY-MM-DD（預設今天）")
    parser.add_argument("--days", type=int, help="改用「最近 N 個日曆天」指定範圍")
    parser.add_argument("--sleep", type=float, default=4.0, help="每次請求間隔秒數（預設 4，勿調太低以免被限流）")
    parser.add_argument("--force", action="store_true", help="已存在的日期也重新抓取")
    parser.add_argument("--scope", choices=("twse", "tpex"), default=None,
                        help="只回補單一市場（預設兩個都補）")
    args = parser.parse_args()

    end = date.fromisoformat(args.end) if args.end else twse.taipei_today()
    if args.days:
        start = end - timedelta(days=args.days - 1)
    elif args.start:
        start = date.fromisoformat(args.start)
    else:
        parser.error("請指定 --from 或 --days")
    if start > end:
        parser.error("起始日期不能晚於結束日期")
    scopes = [args.scope] if args.scope else ["twse", "tpex"]
    return start, end, args.sleep, args.force, scopes


FETCHERS = {
    "twse": ("MI_INDEX", lambda day: twse.fetch_mi_index(day)),
    "tpex": ("TPEX_DAILY", lambda day: twse.fetch_tpex_daily(day)),
}


def backfill_scope(scope, days, sleep_sec, force) -> int:
    label = twse.SCOPE_NAMES[scope]
    source, fetch = FETCHERS[scope]
    # 排行與收盤價都齊了才算補過：收盤價是後來才加的檔案，先前補過的日子只有排行，
    # 這樣重跑一次就會把缺的那半邊補上，不必動用 --force 把整段重抓
    existing = set(twse.existing_dates(scope)) & set(twse.existing_close_dates(scope))
    todo = [d for d in days if force or d.isoformat() not in existing]
    print(f"\n=== {label} ===")
    print(f"平日 {len(days)} 天，需抓取 {len(todo)} 天（已完整 {len(days) - len(todo)} 天）")

    fetched = holidays = 0
    for i, day in enumerate(todo, start=1):
        prefix = f"[{label} {i}/{len(todo)}] {day}"
        try:
            result = fetch(day)
        except RuntimeError as err:
            print(f"{prefix} 失敗：{err}")
            return 1

        if result is None:
            holidays += 1
            print(f"{prefix} 非交易日，跳過")
        else:
            date_iso, records = result
            payload = twse.build_payload(date_iso, source, records)
            twse.write_daily(payload, scope)
            twse.write_closes(date_iso, scope, records)
            fetched += 1
            top = payload["stocks"][0]
            print(f"{prefix} 共 {payload['marketCount']} 檔，"
                  f"第一名 {top['code']} {top['name']} {top['value'] / 1e8:,.1f} 億")

        if i < len(todo):
            time.sleep(sleep_sec)

    print(f"{label} 完成：新增 {fetched} 個交易日、跳過 {holidays} 個非交易日")
    return 0


def main() -> int:
    start, end, sleep_sec, force, scopes = parse_args()

    # 由新到舊回補，中途中斷時手上的資料仍是最近的
    days = []
    cursor = end
    while cursor >= start:
        if cursor.weekday() < 5:  # 週末直接跳過，省去無謂請求
            days.append(cursor)
        cursor -= timedelta(days=1)

    print(f"範圍 {start} ~ {end}")
    for scope in scopes:
        if backfill_scope(scope, days, sleep_sec, force):
            return 1

    print("\n接著執行：python scripts/build_history.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
