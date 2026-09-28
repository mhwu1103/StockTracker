"""抓加權指數的每日收盤 -> docs/data/taiex.json。

紀律頁的「大盤溫控」只看一件事：加權指數收在 10／20／60 日線的哪一邊。
站內原本唯一的 ^TWII 在 us/market.json 裡，但那一份是 Yahoo 的資料、排在**美股的
交易日曆**上 —— 台股有開、美股休市的那幾天是空的，最後一格也常常是 null。拿它算
十日線，缺一天就是算錯一天。所以另外從證交所抓一份，日期軸就是台股自己的。

來源是證交所的 FMTQIK（每月市場成交資訊），一次給一整個月的每日收盤指數。
平常只重抓這個月與上個月（跨月那幾天上個月的最後一天可能還沒寫進來），
與舊檔合併後覆寫；`--months` 用來第一次回補。

年線要 240 個交易日，所以回補至少要十三個月才有第一個年線值，預設給十五個月。

檔案裡刻意不放更新時間：write_if_changed 比的是整份內容，一個每天都變的欄位會讓
它每天都判定有變。

用法：
    python scripts/fetch_taiex.py               # 這個月與上個月
    python scripts/fetch_taiex.py --months 15   # 回補十五個月
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import date

import twse

FMTQIK_URL = "https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK"
TAIEX_PATH = twse.DATA_DIR / "taiex.json"

# FMTQIK 的欄位：日期、成交股數、成交金額、成交筆數、發行量加權股價指數、漲跌點數
F_DATE, F_INDEX = 0, 4


def parse_args():
    ap = argparse.ArgumentParser(description="抓加權指數每日收盤")
    ap.add_argument("--months", type=int, default=2, help="往回抓幾個月（含這個月，預設 2）")
    ap.add_argument("--sleep", type=float, default=3.0, help="每個月之間的間隔秒數")
    return ap.parse_args()


def months_back(today: date, n: int) -> list:
    """由舊到新的 n 個月份，每個都是該月 1 號。"""
    out = []
    y, m = today.year, today.month
    for _ in range(n):
        out.append(date(y, m, 1))
        y, m = (y, m - 1) if m > 1 else (y - 1, 12)
    return out[::-1]


def fetch_month(first: date) -> dict:
    """一個月的 {日期: 收盤指數}。那個月還沒有任何交易日時回空的 dict。"""
    raw = twse.fetch_json(FMTQIK_URL, {"date": first.strftime("%Y%m%d"), "response": "json"})
    if raw.get("stat") != "OK":
        # 月初第一個交易日收盤前，這個月會回「很抱歉，沒有符合條件的資料」
        return {}
    fields = raw.get("fields") or []
    if len(fields) <= F_INDEX or "加權" not in fields[F_INDEX]:
        raise RuntimeError(f"FMTQIK 欄位格式已改變：{fields}")
    out = {}
    for row in raw.get("data") or []:
        value = twse.clean_number(row[F_INDEX])
        if value is not None:
            out[twse.roc_to_iso(row[F_DATE])] = round(float(value), 2)
    return out


def main() -> int:
    args = parse_args()
    old = twse.read_json(TAIEX_PATH) if TAIEX_PATH.exists() else {"d": [], "c": []}
    series = dict(zip(old["d"], old["c"]))

    got = 0
    for i, first in enumerate(months_back(twse.taipei_today(), max(1, args.months))):
        if i:
            time.sleep(args.sleep)
        month = fetch_month(first)
        print(f"  {first:%Y-%m}：{len(month)} 個交易日")
        series.update(month)
        got += len(month)

    if not series:
        print("一個交易日都沒抓到，不寫檔")
        return 1

    days = sorted(series)
    changed = twse.write_if_changed(TAIEX_PATH, {"d": days, "c": [series[d] for d in days]})
    print(f"taiex.json：{len(days)} 個交易日（{days[0]} ~ {days[-1]}），"
          f"本次抓到 {got} 筆，{'已更新' if changed else '無變化'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
