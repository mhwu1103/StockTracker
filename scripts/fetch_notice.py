"""抓注意股：證交所與櫃買每天公布的「注意交易資訊」（處置的前一步）。

    python scripts/fetch_notice.py               # 每日排程：今年（1 月時連去年）
    python scripts/fetch_notice.py --since 2021  # 第一次回補

    上市  https://www.twse.com.tw/rwd/zh/announcement/notice?startDate=YYYYMMDD&endDate=YYYYMMDD
    上櫃  https://www.tpex.org.tw/www/zh-tw/bulletin/attention?startDate=YYYY/MM/DD&endDate=YYYY/MM/DD

兩邊都可以一次查一整年。存成 `notice/<年>.json`：
[[日期, 代號, 名稱, [款, ...], 方向, 市場], ...]，依日期、代號排序。

- **款**：「注意交易資訊」欄裡標的「第一款」「(第五款)」……，一列可以同時有好幾款。
  證交所有些句子沒標款（例如「累積跌幅達 29.52%。且自營商賣出比率 100%﹝第五款﹞」——前半句單獨
  不夠第一款的門檻），只認有標出來的
- **方向**：內文只講漲幅 1、只講跌幅 −1、都沒有或兩者都有 0
- 只留股票與 ETF（twse.is_tracked_code）：權證、可轉債不要
- 同一檔同一天只留一列

處置是依注意的累積次數判定的（scripts/backtest_notice.py 用這份資料重建規則、算準確度）。
"""

from __future__ import annotations

import argparse
import re
import time

import twse
from fetch_disposal import cn_num, roc

OUT_DIR = twse.DATA_DIR / "notice"
TWSE_URL = "https://www.twse.com.tw/rwd/zh/announcement/notice"
TPEX_URL = "https://www.tpex.org.tw/www/zh-tw/bulletin/attention"
CLAUSE_RE = re.compile(r"第([一二三四五六七八九十]+)款")


def clauses(text: str) -> list:
    return sorted({cn_num(m) for m in CLAUSE_RE.findall(text)})


def direction(text: str) -> int:
    up, down = "漲幅" in text, "跌幅" in text
    return 1 if up and not down else -1 if down and not up else 0


def rows(fields: list, data: list, source: str, market: str) -> list:
    """欄位用名稱找，對不上就整份不要（寧可缺，不可錯）。"""
    want = {"code": ("證券代號",), "name": ("證券名稱",), "info": ("注意交易資訊",), "date": ("日期",)}
    idx = {}
    for key, labels in want.items():
        hit = [i for i, f in enumerate(fields) if any(lb in f for lb in labels)]
        if not hit:
            raise RuntimeError(f"{source} 找不到欄位「{labels[0]}」：{fields}")
        idx[key] = hit[0]
    out = {}
    for r in data:
        code = str(r[idx["code"]]).strip()
        if not twse.is_tracked_code(code):
            continue
        text = twse.strip_tags(r[idx["info"]])
        ks = clauses(text)
        if not ks:
            continue
        d = roc(r[idx["date"]])
        out[(d, code)] = [d, code, str(r[idx["name"]]).strip(), ks, direction(text), market]
    return list(out.values())


def fetch_year(year: int, sleep: float) -> list:
    j = twse.fetch_json(TWSE_URL, {"startDate": f"{year}0101", "endDate": f"{year}1231", "response": "json"})
    tw = rows(j.get("fields") or [], j.get("data") or [], "證交所", "twse") if j.get("stat") == "OK" else []
    time.sleep(sleep)
    j = twse.fetch_json(TPEX_URL, {"startDate": f"{year}/01/01", "endDate": f"{year}/12/31", "response": "json"})
    t = (j.get("tables") or [{}])[0]
    tp = rows(t.get("fields") or [], t.get("data") or [], "櫃買", "tpex") if t.get("data") else []
    print(f"  {year}：上市 {len(tw)} 筆、上櫃 {len(tp)} 筆")
    return sorted(tw + tp)


def main():
    ap = argparse.ArgumentParser(description="抓注意交易資訊")
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
