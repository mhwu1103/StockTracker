"""抓取當日上市與上櫃收盤行情，計算成交值排行並寫入 docs/data/daily/。

同時把全市場的四價（開高低收）寫進 docs/data/close/，均線分頁與個股 K 線要靠它。

「全部」的排行不在這裡產生，而是由 build_history.py 合併兩個市場算出來，
因為合併後的名次與連續進榜天數都得回頭看歷史才算得準。

用法：
    python scripts/fetch_daily.py
"""

from __future__ import annotations

import sys

import twse

SOURCES = [
    ("twse", "STOCK_DAY_ALL", twse.fetch_stock_day_all),
    ("tpex", "TPEX_QUOTES", twse.fetch_tpex_quotes),
]


def main() -> int:
    ok = 0
    for scope, source, fetch in SOURCES:
        label = twse.SCOPE_NAMES[scope]
        try:
            date_iso, records = fetch()
        except RuntimeError as err:
            print(f"{label}：抓取失敗 —— {err}")
            continue

        if not records:
            print(f"{label}：沒有取得任何有成交的個股，可能今天不是交易日或資料尚未更新。")
            continue

        payload = twse.build_payload(date_iso, source, records)
        path = twse.write_daily(payload, scope)
        # 均線與 K 線要全市場的四價，daily 只留前 300 名，所以另外存一份
        twse.write_closes(date_iso, scope, records)
        ok += 1

        print(f"{label} {date_iso}：{payload['marketCount']} 檔有成交，"
              f"總成交值 {payload['marketValue'] / 1e8:,.0f} 億元")
        for stock in payload["stocks"][:3]:
            print(f"  {stock['rank']:>3}. {stock['code']} {stock['name']}"
                  f"  {stock['value'] / 1e8:,.1f} 億")
        print(f"  已寫入 {path.relative_to(twse.ROOT)}")

    if not ok:
        return 1
    print("\n接著執行：python scripts/build_history.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
