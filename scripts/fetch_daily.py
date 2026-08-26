"""抓取當日上市收盤行情，計算成交值排行並寫入 docs/data/daily/。

用法：
    python scripts/fetch_daily.py
"""

from __future__ import annotations

import sys

import twse


def main() -> int:
    date_iso, records = twse.fetch_stock_day_all()
    if not records:
        print("沒有取得任何有成交的個股，可能今天不是交易日或資料尚未更新。")
        return 1

    payload = twse.build_payload(date_iso, "STOCK_DAY_ALL", records)
    path = twse.write_daily(payload)

    print(f"{date_iso}：全市場 {payload['marketCount']} 檔有成交，"
          f"總成交值 {payload['marketValue'] / 1e8:,.0f} 億元")
    for stock in payload["stocks"][:5]:
        print(f"  {stock['rank']:>3}. {stock['code']} {stock['name']}"
              f"  {stock['value'] / 1e8:,.1f} 億")
    print(f"已寫入 {path.relative_to(twse.ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
