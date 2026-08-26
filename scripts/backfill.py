"""用 MI_INDEX 逐日回補歷史成交值排行。可中斷、可續跑（已存在的日期自動跳過）。

用法：
    python scripts/backfill.py --from 2024-08-01 --to 2026-08-15
    python scripts/backfill.py --days 90            # 回補最近 90 個日曆天
    python scripts/backfill.py --days 90 --force    # 連已存在的日期也重抓
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
    return start, end, args.sleep, args.force


def main() -> int:
    start, end, sleep_sec, force = parse_args()
    existing = set(twse.existing_dates())

    # 由新到舊回補，中途中斷時手上的資料仍是最近的
    days = []
    cursor = end
    while cursor >= start:
        if cursor.weekday() < 5:  # 週末直接跳過，省去無謂請求
            days.append(cursor)
        cursor -= timedelta(days=1)

    todo = [d for d in days if force or d.isoformat() not in existing]
    print(f"範圍 {start} ~ {end}：平日 {len(days)} 天，需抓取 {len(todo)} 天"
          f"（已存在 {len(days) - len(todo)} 天）")

    fetched = holidays = 0
    for i, day in enumerate(todo, start=1):
        prefix = f"[{i}/{len(todo)}] {day}"
        try:
            result = twse.fetch_mi_index(day)
        except RuntimeError as err:
            print(f"{prefix} 失敗：{err}")
            return 1

        if result is None:
            holidays += 1
            print(f"{prefix} 非交易日，跳過")
        else:
            date_iso, records = result
            payload = twse.build_payload(date_iso, "MI_INDEX", records)
            twse.write_daily(payload)
            fetched += 1
            top = payload["stocks"][0]
            print(f"{prefix} 共 {payload['marketCount']} 檔，"
                  f"第一名 {top['code']} {top['name']} {top['value'] / 1e8:,.1f} 億")

        if i < len(todo):
            time.sleep(sleep_sec)

    print(f"完成：新增 {fetched} 個交易日、跳過 {holidays} 個非交易日")
    print("接著執行：python scripts/build_history.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
