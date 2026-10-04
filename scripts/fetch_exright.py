"""抓除權息：每一次除權息當天的「除權息前收盤」與「除權息參考價」，用來還原股價。

    python scripts/fetch_exright.py               # 每日排程：今年與去年
    python scripts/fetch_exright.py --since 2019  # 第一次回補

    上市  https://www.twse.com.tw/rwd/zh/exRight/TWT49U?startDate=YYYYMMDD&endDate=YYYYMMDD
    上櫃  https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ?startDate=YYYY/MM/DD&endDate=YYYY/MM/DD

兩邊都是官方的「除權除息計算結果表」，一次可以查一整年。

## 為什麼需要

`value/pe/` 存的月底收盤是**沒還原**的。6～9 月除息的股票，股價會在除息那個月掉一截
（殖利率 6% 就是 -6%），拿它算「這一檔幾月常跌」，賣出清單就會被高殖利率股塞滿——那是
發股利，不是季節性。

存成 `exright/<年>.json`：{代號: [[日期, 還原因子], ...]}，還原因子 = 參考價 ÷ 前收盤
（< 1）。那個月的報酬除以當月所有因子的乘積，就是含息的報酬。上市與上櫃的代號不重複，
併在同一份。
"""

from __future__ import annotations

import argparse
import re
import time

import twse

OUT_DIR = twse.DATA_DIR / "exright"
TWSE_URL = "https://www.twse.com.tw/rwd/zh/exRight/TWT49U"
TPEX_URL = "https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ"
ROC_RE = re.compile(r"(\d+)\D+(\d+)\D+(\d+)")


def roc(text: str) -> str:
    """'113年01月04日' 或 '113/01/04' -> '2024-01-04'"""
    y, m, d = ROC_RE.search(str(text)).groups()
    return f"{int(y) + 1911:04d}-{int(m):02d}-{int(d):02d}"


def rows(fields: list, data: list, source: str) -> list:
    """[(代號, 日期, 因子)]。欄位用名稱找，對不上就整份不要（寧可缺，不可錯）。"""
    # 證交所的日期欄叫「資料日期」、櫃買叫「除權息日期」；參考價要避開「減除股利參考價」
    want = {"date": ("除權息日期", "資料日期"), "code": ("代號",), "prev": ("前收盤",),
            "ref": ("除權息參考價", "除權參考價")}
    idx = {}
    for key, labels in want.items():
        hit = [i for i, f in enumerate(fields) if any(lb in f for lb in labels)]
        if not hit:
            raise RuntimeError(f"{source} 找不到欄位「{labels[0]}」：{fields}")
        idx[key] = hit[0]
    out = []
    for r in data:
        code = str(r[idx["code"]]).strip()
        prev, ref = twse.clean_number(r[idx["prev"]]), twse.clean_number(r[idx["ref"]])
        if not twse.is_tracked_code(code) or not prev or not ref or ref >= prev:
            continue
        out.append((code, roc(r[idx["date"]]), round(ref / prev, 6)))
    return out


def fetch_year(year: int, sleep: float) -> dict:
    got = {}
    j = twse.fetch_json(TWSE_URL, {"startDate": f"{year}0101", "endDate": f"{year}1231", "response": "json"})
    tw = rows(j.get("fields") or [], j.get("data") or [], "證交所") if j.get("stat") == "OK" else []
    time.sleep(sleep)
    j = twse.fetch_json(TPEX_URL, {"startDate": f"{year}/01/01", "endDate": f"{year}/12/31", "response": "json"})
    t = (j.get("tables") or [{}])[0]
    tp = rows(t.get("fields") or [], t.get("data") or [], "櫃買") if t.get("data") else []
    for code, d, f in tw + tp:
        got.setdefault(code, []).append([d, f])
    for v in got.values():
        v.sort()
    print(f"  {year}：上市 {len(tw)} 筆、上櫃 {len(tp)} 筆")
    return got


def main():
    ap = argparse.ArgumentParser(description="抓除權息計算結果")
    ap.add_argument("--since", type=int, help="從哪一年開始（預設去年）")
    ap.add_argument("--sleep", type=float, default=3.0)
    args = ap.parse_args()
    this = twse.taipei_today().year
    for year in range(args.since or this - 1, this + 1):
        data = fetch_year(year, args.sleep)
        if data:
            twse.write_if_changed(OUT_DIR / f"{year}.json", data)
        time.sleep(args.sleep)


if __name__ == "__main__":
    main()
