"""抓處置股：證交所與櫃買公布的處置有價證券（分盤撮合、預收款券）。

    python scripts/fetch_disposal.py               # 每日排程：今年（1 月時連去年）
    python scripts/fetch_disposal.py --since 2021  # 第一次回補

    上市  https://www.twse.com.tw/rwd/zh/announcement/punish?startDate=YYYYMMDD&endDate=YYYYMMDD
    上櫃  https://www.tpex.org.tw/www/zh-tw/bulletin/disposal?startDate=YYYY/MM/DD&endDate=YYYY/MM/DD

兩邊都可以一次查一整年（日期是「公布日」）。存成 `disposal/<年>.json`：
[[公布日, 代號, 名稱, 處置起日, 處置迄日, 第幾次, 撮合間隔分鐘, 市場], ...]，依公布日排序。

- **第幾次**：「處置措施」欄的「第一次處置」「第二次處置」；櫃買寫成「再次處置」的記成 2
- **撮合間隔**：處置內容裡的「約每五分鐘」「約每 20 分鐘」，第一次多半 5 分鐘、第二次 20 分鐘
- 只留股票與 ETF（twse.is_tracked_code）：可轉債、權證、櫃買的「本日無處置資料」空列不要
- 同一檔、同一天公布、同一段期間的重複列只留一筆
- 期間是**日曆日**的起迄（含週末），換成交易日由用的那一邊處理

處置是交易所依「公布注意交易資訊」的累積次數判定的：例如連續三個營業日、或連續五個營業日、
或最近十個營業日有六個營業日被公布注意（第一款），隔天起處置 10 個營業日；再犯是第二次處置。
"""

from __future__ import annotations

import argparse
import re
import time

import twse

OUT_DIR = twse.DATA_DIR / "disposal"
TWSE_URL = "https://www.twse.com.tw/rwd/zh/announcement/punish"
TPEX_URL = "https://www.tpex.org.tw/www/zh-tw/bulletin/disposal"
ROC_RE = re.compile(r"(\d+)\D+(\d+)\D+(\d+)")
SPAN_RE = re.compile(r"(\d+\D\d+\D\d+)\D+(\d+\D\d+\D\d+)")
MIN_RE = re.compile(r"每\s*([0-9]+|[一二三四五六七八九十]+)\s*分鐘")
CN = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def roc(text: str) -> str:
    y, m, d = ROC_RE.search(str(text)).groups()
    return f"{int(y) + 1911:04d}-{int(m):02d}-{int(d):02d}"


def cn_num(s: str) -> int:
    if s.isdigit():
        return int(s)
    if "十" in s:
        a, _, b = s.partition("十")
        return (CN.get(a, 1) if a else 1) * 10 + (CN.get(b, 0) if b else 0)
    return CN.get(s, 0)


def times(text: str) -> int:
    t = str(text)
    if "第一次" in t:
        return 1
    if "第二次" in t or "再次" in t:
        return 2
    m = re.search(r"第([一二三四五六七八九十]+)次", t)
    return cn_num(m.group(1)) if m else 1


def rows(fields: list, data: list, source: str, market: str) -> list:
    """欄位用名稱找，對不上就整份不要（寧可缺，不可錯）。"""
    want = {"pub": ("公布日期",), "code": ("證券代號",), "name": ("證券名稱",), "span": ("處置起訖", "處置起迄"),
            "how": ("處置措施",), "body": ("處置內容",)}
    idx = {}
    for key, labels in want.items():
        hit = [i for i, f in enumerate(fields) if any(lb in f for lb in labels)]
        if not hit:
            raise RuntimeError(f"{source} 找不到欄位「{labels[0]}」：{fields}")
        idx[key] = hit[0]
    out = []
    for r in data:
        code = str(r[idx["code"]]).strip()
        if not twse.is_tracked_code(code):         # 可轉債、權證、空列都不要
            continue
        span = SPAN_RE.search(str(r[idx["span"]]))
        if not span:
            continue
        m = MIN_RE.search(str(r[idx["body"]]))
        name = re.sub(r"\(.*?\)", "", str(r[idx["name"]])).strip()
        out.append([roc(r[idx["pub"]]), code, name, roc(span.group(1)), roc(span.group(2)),
                    times(r[idx["how"]]), cn_num(m.group(1)) if m else None, market])
    return out


def fetch_year(year: int, sleep: float) -> list:
    j = twse.fetch_json(TWSE_URL, {"startDate": f"{year}0101", "endDate": f"{year}1231", "response": "json"})
    tw = rows(j.get("fields") or [], j.get("data") or [], "證交所", "twse") if j.get("stat") == "OK" else []
    time.sleep(sleep)
    j = twse.fetch_json(TPEX_URL, {"startDate": f"{year}/01/01", "endDate": f"{year}/12/31", "response": "json"})
    t = (j.get("tables") or [{}])[0]
    tp = rows(t.get("fields") or [], t.get("data") or [], "櫃買", "tpex") if t.get("data") else []
    got = sorted({tuple(x[:2] + x[3:5]): x for x in tw + tp}.values())
    print(f"  {year}：上市 {len(tw)} 筆、上櫃 {len(tp)} 筆")
    return got


def main():
    ap = argparse.ArgumentParser(description="抓處置有價證券")
    ap.add_argument("--since", type=int, help="從哪一年開始（預設今年；1 月連去年）")
    ap.add_argument("--sleep", type=float, default=3.0)
    args = ap.parse_args()
    today = twse.taipei_today()
    first = args.since or (today.year - 1 if today.month == 1 else today.year)
    for year in range(first, today.year + 1):
        data = fetch_year(year, args.sleep)
        if data:
            twse.write_if_changed(OUT_DIR / f"{year}.json", data)
        time.sleep(args.sleep)


if __name__ == "__main__":
    main()
