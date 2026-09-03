"""抓三大法人買賣超（上市 + 上櫃）-> docs/data/insti/daily/YYYY-MM-DD.json。

兩支來源都能指定日期，所以「抓今天」與「回補上週」是同一段程式，不像成交值排行
那樣要分成 fetch_daily.py 與 backfill.py 兩支。已經有檔案的日期預設跳過。

金額是「買賣超股數 × 當日收盤價」估算出來的，收盤價讀 docs/data/close/ ——
排程裡 backfill.py 跑在前面，那份檔案那時已經寫好了。

用法：
    python scripts/fetch_institutions.py                  今天
    python scripts/fetch_institutions.py --date 2026-09-02
    python scripts/fetch_institutions.py --days 14        回補最近 14 個日曆天內缺的交易日
    python scripts/fetch_institutions.py --days 14 --force   已存在的日期也重抓
    python scripts/fetch_institutions.py --dry-run        只抓來看，不寫檔
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import date, timedelta

import institutions as insti
import twse


def parse_args():
    parser = argparse.ArgumentParser(description="抓三大法人買賣超")
    parser.add_argument("--date", help="只抓這一天 YYYY-MM-DD（預設今天）")
    parser.add_argument("--days", type=int, help="改抓「最近 N 個日曆天」裡缺的交易日")
    parser.add_argument("--sleep", type=float, default=4.0,
                        help="每個日期之間的間隔秒數（預設 4，勿調太低以免被限流）")
    parser.add_argument("--force", action="store_true", help="已存在的日期也重新抓取")
    parser.add_argument("--dry-run", action="store_true", help="只抓並印出結果，不寫檔")
    args = parser.parse_args()
    if args.date and args.days:
        parser.error("--date 與 --days 只能給一個")
    return args


def wanted_days(args) -> list:
    if args.date:
        return [date.fromisoformat(args.date)]
    end = twse.taipei_today()
    if not args.days:
        return [end]
    # 由新到舊，中途中斷時手上的資料仍是最近的；週末直接跳過，省去無謂請求
    days = [end - timedelta(days=i) for i in range(args.days)]
    return [d for d in days if d.weekday() < 5]


def fetch_day(day: date) -> dict:
    """抓一天。非交易日回 None，兩個市場只有一邊有資料時視為「還沒出來」也回 None。"""
    by_market = {}
    for market, fetch in insti.FETCHERS.items():
        by_market[market] = fetch(day)
        label = twse.SCOPE_NAMES[market]
        print(f"  {label} {len(by_market[market])} 檔")

    got = [m for m in insti.MARKETS if by_market[m]]
    if not got:
        return None
    if len(got) < len(insti.MARKETS):
        # 只寫一半的檔案沒有人看得出來 —— 少掉那個市場會被讀成「那邊的法人整天沒動」。
        # 櫃買收盤後出得比證交所晚，隔天的排程會把這一天補上。
        missing = [twse.SCOPE_NAMES[m] for m in insti.MARKETS if m not in got]
        print(f"  ! {'、'.join(missing)}還沒有資料，這一天先不寫（隔天的排程會補）")
        return None

    # 官方的全市場合計是唯一有金額的來源，但它只是畫面上的表頭數字：抓不到就少一個
    # 對照基準，不該讓整天的個股資料跟著作廢。
    totals = {}
    for market, fetch_total in insti.TOTAL_FETCHERS.items():
        try:
            totals[market] = fetch_total(day)
        except (RuntimeError, KeyError, IndexError) as err:
            print(f"  ! {twse.SCOPE_NAMES[market]}官方合計抓不到（{err}），這一天只留估算值")
            totals = None
            break

    closes = insti.load_closes(day)
    return insti.build_payload(day.isoformat(), by_market, closes, totals)


def describe(payload: dict) -> None:
    for market in insti.MARKETS:
        label = twse.SCOPE_NAMES[market]
        est = payload["est"][market]
        official = (payload.get("total") or {}).get(market)
        line = (f"  {label}官方合計：外資 {official['fo']:+,.1f} 億、投信 {official['tr']:+,.1f} 億、"
                f"自營商 {official['de']:+,.1f} 億" if official else f"  {label}（沒有官方合計）")
        # 估算與官方的差距就是「拿收盤價當均價」的代價，每天印出來才知道它有多大
        gap = ("" if not official or not official["fo"]
               else f"；估算 {est['fo']:+,.1f} 億，外資差 "
                    f"{abs(est['fo'] / official['fo'] - 1) * 100:.1f}%")
        print(line + gap)
    both = []
    for market, stocks in payload["stocks"].items():
        for code, row in stocks.items():
            name, foreign, trust, _, close = row
            fo, tr = insti.oku(foreign, close), insti.oku(trust, close)
            if min(fo, tr) >= 0.5 or max(fo, tr) <= -0.5:
                both.append((abs(fo + tr), code, name, fo, tr))
    both.sort(reverse=True)
    print(f"  外資投信同買／同賣 0.5 億以上：{len(both)} 檔"
          + (f"，最大是 {both[0][1]} {both[0][2]}"
             f"（外資 {both[0][3]:+,.1f} 億、投信 {both[0][4]:+,.1f} 億）" if both else ""))


def main() -> int:
    args = parse_args()
    days = wanted_days(args)
    existing = set(insti.existing_dates())
    todo = [d for d in days if args.force or args.date or d.isoformat() not in existing]

    skipped = len(days) - len(todo)
    print(f"三大法人買賣超：{len(days)} 個候選日期，要抓 {len(todo)} 天"
          + (f"（已有 {skipped} 天）" if skipped else ""))

    wrote = holidays = 0
    for i, day in enumerate(todo, start=1):
        print(f"\n[{i}/{len(todo)}] {day}")
        try:
            payload = fetch_day(day)
        except RuntimeError as err:
            print(f"  ! 失敗 —— {err}")
            return 1

        if payload is None:
            holidays += 1
        else:
            describe(payload)
            if args.dry_run:
                print("  --dry-run：不寫檔")
            else:
                path = insti.write_json(insti.daily_path(payload["date"]), payload)
                print(f"  已寫入 {path.relative_to(twse.ROOT)}"
                      f"（{payload['n']} 檔，門檻 {payload['cut']} 億以下不存"
                      + (f"，{payload['noPrice']} 檔當日無收盤價未收" if payload["noPrice"] else "")
                      + "）")
                wrote += 1

        if i < len(todo):
            time.sleep(args.sleep)

    print(f"\n完成：新增 {wrote} 天、跳過 {holidays} 天（非交易日或資料還沒出來）")
    if wrote and not args.dry_run:
        print("接著執行：python scripts/build_institutions.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
