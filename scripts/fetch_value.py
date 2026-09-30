"""抓價值頁要的兩份原始資料：每月底的本益比／殖利率／股淨比，與月營收。

    python scripts/fetch_value.py                              # 每日排程
    python scripts/fetch_value.py --pe-months 61 --rev-months 14   # 第一次回補

- **本益比**：`--pe-months` 個月，每個月取最後一個交易日（這個月就是今天或之前最近的
  交易日）。過去的月份一旦寫過就不再重抓——月底那一天的數字不會再變；只有這個月每天
  覆寫。要五年的區間，所以回補給 61 個月。
- **月營收**：`--rev-months` 個月。每月 10 日前公布上個月，而且常有公司晚報、更正，
  所以最近兩個月每天都重抓；更早的已存在就跳過。要一年的新高與三個月平均，回補給 14 個月。

資料來源與格式見 valuation.py。
"""

from __future__ import annotations

import argparse
import sys
import time
from calendar import monthrange
from datetime import date

import twse
import valuation


def parse_args():
    ap = argparse.ArgumentParser(description="抓本益比與月營收")
    ap.add_argument("--pe-months", type=int, default=1, help="本益比往回幾個月（含這個月，預設 1）")
    ap.add_argument("--rev-months", type=int, default=2, help="月營收往回幾個月（不含這個月，預設 2）")
    ap.add_argument("--sleep", type=float, default=3.0, help="每次請求之間的間隔秒數")
    ap.add_argument("--force", action="store_true", help="已存在的過去月份也重抓")
    return ap.parse_args()


def months_back(first: date, n: int) -> list:
    """由舊到新的 n 個 (年, 月)，最後一個是 first 那個月。"""
    out, y, m = [], first.year, first.month
    for _ in range(n):
        out.append((y, m))
        y, m = (y, m - 1) if m > 1 else (y - 1, 12)
    return out[::-1]


def main() -> int:
    args = parse_args()
    today = twse.taipei_today()
    this_month = f"{today:%Y-%m}"
    calls = 0

    def pause():
        nonlocal calls
        if calls:
            time.sleep(args.sleep)
        calls += 1

    # ---- 本益比 ----
    for y, m in months_back(today, max(0, args.pe_months)):
        month = f"{y}-{m:02d}"
        end = today if month == this_month else date(y, m, monthrange(y, m)[1])
        for market in valuation.MARKETS:
            path = valuation.pe_path(market, month)
            if month != this_month and path.exists() and not args.force:
                continue
            pause()
            day, rows = valuation.fetch_pe_on_or_before(market, end)
            if not rows:
                print(f"  ! {market} {month}：往回找了 15 天都沒有資料")
                continue
            # 月初收盤前（或月初連假）跑，當月還沒有交易日，往回找會找到上個月底。
            # 那一份照它自己的日期歸到上個月的檔 —— 寫進當月的話，同一個月底會在
            # 兩個月檔各出現一次，band() 與回測都會把它算成兩個樣本。
            # 上個月的檔若因為月底那天排程漏跑而停在更早的日子，這裡順便補上。
            # 用另一個變數：month 是外層迴圈的，改掉它的話下一個市場會拿到上個月、
            # 然後被上面「過去月份已存在就略過」那一條擋掉。
            belongs = f"{day:%Y-%m}"
            if belongs != month:
                path = valuation.pe_path(market, belongs)
                print(f"  本益比 {market}：{month} 還沒有交易日，找到的 {day} 歸到 {belongs}")
            changed = twse.write_if_changed(path, {"d": day.isoformat(), "c": rows})
            print(f"  本益比 {market} {belongs}（{day}）：{len(rows)} 檔{'' if changed else '，無變化'}")

    # ---- 月營收 ----
    last_month = (today.year, today.month - 1) if today.month > 1 else (today.year - 1, 12)
    recent = set(months_back(date(*last_month, 1), 2))
    for y, m in months_back(date(*last_month, 1), max(0, args.rev_months)):
        month = f"{y}-{m:02d}"
        path = valuation.rev_path(month)
        if (y, m) not in recent and path.exists() and not args.force:
            continue
        merged = {}
        for market in valuation.MARKETS:
            pause()
            got = valuation.fetch_revenue(market, y, m)
            if got:
                merged.update(got)
        if not merged:
            print(f"  月營收 {month}：還沒公布")
            continue
        changed = twse.write_if_changed(path, merged)
        print(f"  月營收 {month}：{len(merged)} 家{'' if changed else '，無變化'}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
