"""抓融資融券餘額 -> docs/data/margin/daily/<日期>.json。

MK 從 2022 年起每個時期都拿融資當底部指標：融資大減、斷頭潮、融資餘額跌回某條線、
維持率掉到 140% 上下。網站原本沒有這份資料。

來源（都是每日一張全市場表）：
    上市  https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=YYYYMMDD&selectType=ALL
          第一張表是信用交易統計（融資金額的合計在這裡），第二張是每一檔的餘額
    上櫃  https://www.tpex.org.tw/www/zh-tw/margin/balance?date=YYYY/MM/DD
          每一檔的餘額，合計（張、融資金）在 summary

每天的檔：
    {"date", "v", "tw": [融資金額(仟元), 融資餘額(張), 融券餘額(張)], "tp": [同上],
     "s": {代號: [融資餘額(張), 融券餘額(張)]}}
個股只存有融資或融券餘額的，ETF 也存——融資金額的合計包含 ETF，算維持率要對得起來。

日期軸跟著 close/twse/：有收盤檔、還沒有融資檔的日子才抓，預設只看最近 14 天。

用法：
    python scripts/fetch_margin.py                       # 最近 14 天缺的
    python scripts/fetch_margin.py --since 2021-10-01    # 回補
    python scripts/fetch_margin.py --since 2021-10-01 --only tpex   # 兩個來源可以分開平行跑
    python scripts/fetch_margin.py --since 2021-10-01 --calendar <長歷史>/docs/data/close/twse
"""

from __future__ import annotations

import argparse
import time
from datetime import date

import twse

TWSE_URL = "https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN"
TPEX_URL = "https://www.tpex.org.tw/www/zh-tw/margin/balance"
OUT_DIR = twse.DATA_DIR / "margin" / "daily"
VERSION = 1


def num(x) -> int:
    x = str(x).replace(",", "").strip()
    return int(float(x)) if x not in ("", "-", "--") else 0


def check(fields, want: dict, src: str):
    """欄位位置讀錯不會報錯，只會把融券寫成融資，所以先拿欄名對一次。"""
    for i, word in want.items():
        if i >= len(fields) or word not in str(fields[i]):
            raise RuntimeError(f"{src} 第 {i} 欄是「{fields[i] if i < len(fields) else '（沒有）'}」，"
                               f"不像「{word}」，來源格式可能改了")


def fetch_twse(day: date):
    raw = twse.fetch_json(TWSE_URL, {"date": day.strftime("%Y%m%d"), "selectType": "ALL", "response": "json"})
    if raw.get("stat") != "OK" or len(raw.get("tables") or []) < 2:
        return None
    summary, detail = raw["tables"][0], raw["tables"][1]
    rows = {r[0]: r for r in summary["data"]}
    fin = next(v for k, v in rows.items() if k.startswith("融資(交易單位)"))
    short = next(v for k, v in rows.items() if k.startswith("融券(交易單位)"))
    amt = next(v for k, v in rows.items() if k.startswith("融資金額"))
    check(detail["fields"], {0: "代號", 6: "今日餘額", 12: "今日餘額"}, "MI_MARGN")
    stocks = {}
    for r in detail["data"]:
        f, s = num(r[6]), num(r[12])
        if f or s:
            stocks[r[0].strip()] = [f, s]
    return [num(amt[5]), num(fin[5]), num(short[5])], stocks


def fetch_tpex(day: date):
    raw = twse.fetch_json(TPEX_URL, {"date": day.strftime("%Y/%m/%d"), "response": "json"})
    tables = raw.get("tables") or []
    if not tables or not tables[0].get("data"):
        return None
    t = tables[0]
    check(t["fields"], {0: "代號", 6: "資餘額", 14: "券餘額"}, "上櫃融資融券餘額")
    stocks = {}
    for r in t["data"]:
        f, s = num(r[6]), num(r[14])
        if f or s:
            stocks[r[0].strip()] = [f, s]
    summ = {r[1]: r for r in (t.get("summary") or [])}
    tot = summ.get("合計(張)")
    amt = summ.get("融資金(仟元)")
    if not tot or not amt:
        raise RuntimeError("上櫃融資融券餘額沒有合計列，來源格式可能改了")
    return [num(amt[6]), num(tot[6]), num(tot[14])], stocks


def main() -> int:
    ap = argparse.ArgumentParser(description="抓融資融券餘額")
    ap.add_argument("--since", help="從哪一天開始補（YYYY-MM-DD）；沒給就是最近 14 個交易日")
    ap.add_argument("--only", choices=("twse", "tpex"), help="只抓一邊（回補時兩邊可以分開平行跑）")
    ap.add_argument("--calendar", help="交易日軸改用這個資料夾裡的檔名（回補到網站兩年以前時，"
                    "指向長歷史解壓後的 close/twse）")
    ap.add_argument("--sleep", type=float, default=3.0)
    args = ap.parse_args()

    from pathlib import Path
    cal = Path(args.calendar) if args.calendar else twse.DATA_DIR / "close" / "twse"
    days = sorted({p.stem for p in cal.glob("*.json")} | {p.stem for p in (twse.DATA_DIR / "close" / "twse").glob("*.json")})
    days = [d for d in days if d >= args.since] if args.since else days[-14:]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    done = fail = 0
    for d in days:
        path = OUT_DIR / f"{d}.json"
        cur = twse.read_json(path) if path.exists() else {}
        sides = [m for m in (("twse", "tw"), ("tpex", "tp")) if (not args.only or m[0] == args.only) and m[1] not in cur]
        if not sides:
            continue
        for src, key in sides:
            try:
                got = (fetch_twse if src == "twse" else fetch_tpex)(date.fromisoformat(d))
            except Exception as err:   # 單日失敗不擋整批，下次排程會再補
                print(f"  ! {d} {src}：{err}")
                fail += 1
                continue
            finally:
                time.sleep(args.sleep)
            if got is None:
                print(f"  {d} {src}：沒有資料")
                continue
            # 兩邊平行跑時會同時寫同一個檔，寫之前重讀一次
            cur = twse.read_json(path) if path.exists() else {}
            cur.update({"date": d, "v": VERSION, key: got[0]})
            cur.setdefault("s", {}).update(got[1])
            twse.write_json(path, cur)
            done += 1
            print(f"  {d} {src}：融資 {got[0][0] / 1e5:,.0f} 億、{len(got[1])} 檔")
    print(f"完成 {done}、失敗 {fail}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
