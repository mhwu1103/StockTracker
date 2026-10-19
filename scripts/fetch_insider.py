"""抓內部人持股轉讓事前申報（董監、經理人、大股東要賣股之前的申報）。

    python scripts/fetch_insider.py                     # 每日排程：最近 5 個交易日
    python scripts/fetch_insider.py --since 2021-10-01  # 第一次回補（約 2,500 次請求，兩個多小時）

來源是公開資訊觀測站「內部人持股轉讓事前申報日報表」：
    POST https://mopsov.twse.com.tw/mops/web/ajax_t56sb12
         step=2&year=<民國年>&month=<兩位數>&day=<兩位數>&report=SY（上市）／OY（上櫃）&firstin=true
月、日**一定要補零**，「6」會查無資料、「06」才查得到——之前誤以為舊資料不在線上，是這個原因。
證交所與櫃買的開放資料（t187ap12_L／mopsfin_t187ap12_O）只有當天，回不了頭。

存成 `insider/<年>.json`：[[申報日, 代號, 身分, 轉讓方式, 預定轉讓股數, 目前持股, 有效期間起, 迄, 市場], ...]。
股數都是「自有持股＋保留運用決定權信託股數」。不存申報人與受讓人的姓名——回測與頁面都用不到。

當天的申報要等觀測站「產製」完才查得到；還沒好就回「尚未產製」，那一天記成失敗、下一次排程（往回抓 5 個交易日）會補上。

轉讓方式常見的有：一般交易（在市場上賣）、鉅額逐筆／鉅額配對、盤後定價、贈與、信託、洽特定人。
只有前三種是在市場上賣，其他是家族之間搬股票或信託，不是賣壓。
"""

from __future__ import annotations

import argparse
import html
import re
import time
from datetime import date, timedelta

import requests

import twse

OUT_DIR = twse.DATA_DIR / "insider"
URL = "https://mopsov.twse.com.tw/mops/web/ajax_t56sb12"
REPORTS = {"twse": "SY", "tpex": "OY"}
ROW_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S)
CELL_RE = re.compile(r"<t[dh][^>]*>(.*?)</t[dh]>", re.S)
SPAN_RE = re.compile(r"(\d+/\d+/\d+)\s*~\s*(\d+/\d+/\d+)")
HEADERS = {"User-Agent": "Mozilla/5.0"}


def roc(s: str) -> str:
    y, m, d = s.strip().split("/")
    return f"{int(y) + 1911:04d}-{int(m):02d}-{int(d):02d}"


def num(s):
    v = twse.clean_number(s)
    return int(v) if v is not None else 0


def fetch_day(day: date, market: str, session: requests.Session, retries: int = 4):
    """那一天的申報列；查無資料回 []，抓失敗回 None。"""
    data = {"encodeURIComponent": "1", "step": "2", "year": str(day.year - 1911), "month": f"{day.month:02d}",
            "day": f"{day.day:02d}", "report": REPORTS[market], "firstin": "true"}
    for k in range(retries):
        try:
            r = session.post(URL, data=data, headers=HEADERS, timeout=30)
            text = r.content.decode("utf-8", errors="replace")
            if "無持股轉讓" in text or "查無" in text:
                return []
            if "尚未產製" in text:                  # 當天的還沒出來（排程跑得比觀測站早），明天再補
                return None
            if "總計" in text:
                break
            # 太頻繁時觀測站回一頁「請稍後再試」之類的東西，退一下再來
        except requests.RequestException:
            pass
        time.sleep(10 * (k + 1))
    else:
        return None
    out = []
    for row in ROW_RE.findall(text):
        cells = [re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", c))).strip() for c in CELL_RE.findall(row)]
        # 上市 17 格、上櫃 16 格（沒有最後的「是否申報持股未完成轉讓」）；有時前面多一格「異動情形」（例如更正）
        if cells and not re.match(r"\d+/\d+/\d+$", cells[0]):
            cells = cells[1:]
        if len(cells) < 16 or not re.match(r"\d+/\d+/\d+$", cells[0]):
            continue
        span = SPAN_RE.search(cells[15])
        out.append([roc(cells[0]), cells[1], cells[3], cells[5],
                    num(cells[11]) + num(cells[12]), num(cells[9]) + num(cells[10]),
                    roc(span.group(1)) if span else None, roc(span.group(2)) if span else None, market])
    return out


def trading_days(since: date, until: date) -> list:
    """taiex.json 的交易日；今天還不在裡面的話補上（排程在收盤後跑，taiex 可能已經更新）。"""
    days = [date.fromisoformat(d) for d in (twse.read_json(twse.DATA_DIR / "taiex.json") or {}).get("d", [])]
    out = [d for d in days if since <= d <= until]
    if until.weekday() < 5 and (not out or out[-1] < until):
        out.append(until)
    return out


def main():
    ap = argparse.ArgumentParser(description="抓內部人持股轉讓事前申報")
    ap.add_argument("--since", help="從哪一天開始（YYYY-MM-DD）；預設最近 5 個交易日")
    ap.add_argument("--sleep", type=float, default=3.0)
    args = ap.parse_args()
    today = twse.taipei_today()
    if args.since:
        days = trading_days(date.fromisoformat(args.since), today)
    else:
        days = trading_days(today - timedelta(days=12), today)[-5:]
    by_year = {}
    session = requests.Session()
    failed = []
    for n, day in enumerate(days, 1):
        for market in REPORTS:
            got = fetch_day(day, market, session)
            time.sleep(args.sleep)
            if got is None:
                failed.append(f"{day} {market}")
                continue
            y = day.year
            if y not in by_year:
                path = OUT_DIR / f"{y}.json"
                by_year[y] = twse.read_json(path) if path.exists() else []
            iso = day.isoformat()
            by_year[y] = [r for r in by_year[y] if not (r[0] == iso and r[8] == market)] + got
        if n % 50 == 0 or n == len(days):
            for y, rows in by_year.items():
                twse.write_if_changed(OUT_DIR / f"{y}.json", sorted(rows, key=lambda r: (r[0], r[8], r[1])))
            print(f"  {day}（{n}/{len(days)}）", flush=True)
    total = sum(len(v) for v in by_year.values())
    print(f"內部人轉讓申報：{len(days)} 天，涉及年份共 {total} 筆" + (f"；失敗 {len(failed)}：{failed[:10]}" if failed else ""))


if __name__ == "__main__":
    main()
