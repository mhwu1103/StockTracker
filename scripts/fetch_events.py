"""抓公司公告事件：法說會、財報與自結損益（公開資訊觀測站）。

    python scripts/fetch_events.py                     # 每日排程：最近 4 天的重大訊息＋今年的法說會一覽
    python scripts/fetch_events.py --since 2021-10-01  # 第一次回補（每個日曆日一次請求，約一個半小時）

兩個來源：

1. 每日重大訊息：POST https://mopsov.twse.com.tw/mops/web/ajax_t05st02
       step=0&year=<民國年>&month=<不補零>&day=<不補零>&firstin=true&off=1
   一次回一整天、全部公司（含全文，盤後旺季一天 3 MB）。「本日」包含前一日 17:30 以後的訊息，
   所以每個日曆日都要查（週末也有），同一則用（日期, 時間, 代號, 主旨）去重。
   step=1 或月日補零都會回「查無需求資料」。
   只留四種（其他的主旨一年三十萬則，網站放不下）：
   - fin：內文是「財務報告或年度自結財務資訊」的制式格式——季報、年報、年度自結都是這張表，
     有累計營收、營業利益、歸屬母公司淨利、EPS 與報導期間，可以跟去年同期比
   - self：主旨有「自結」但不是上面那張表（金融股每月自結盈餘、其他自願公布的）
   - conf：主旨提到法說會（「將於 X 月 X 日召開法人說明會」——這是市場**知道**有法說會的那天）
   - attn：達注意交易資訊標準而公布財務業務（多半附自結損益）
2. 法說會一覽：POST https://mopsov.twse.com.tw/mops/web/ajax_t100sb02_1
       step=1&TYPEK=sii／otc&year=<民國年>&month=all&firstin=true&off=1
   一次一整年，有召開日期、時間、擇要訊息。

存成：
- `events/<年>.json`：[[日期, 時間, 代號, 類別, 主旨, 數字或 null], ...]；
  fin 的數字是 {"p": [起, 迄], "rev": 營收, "op": 營業利益, "ni": 歸屬母公司淨利, "eps": EPS}（仟元、元）
- `events/conf_<年>.json`：[[代號, 召開日, 迄日或 null, 時間, 擇要訊息], ...]
只留上市（sii）與上櫃（otc），興櫃與公開發行不留。
"""

from __future__ import annotations

import argparse
import html
import re
import time
from datetime import date, timedelta
from pathlib import Path

import requests

import twse

OUT_DIR = twse.DATA_DIR / "events"
NEWS_URL = "https://mopsov.twse.com.tw/mops/web/ajax_t05st02"
CONF_URL = "https://mopsov.twse.com.tw/mops/web/ajax_t100sb02_1"
HEADERS = {"User-Agent": "Mozilla/5.0"}
MARKETS = ("sii", "otc")

FORM_RE = re.compile(r"<form[^>]*>(.*?)</form>", re.S)
HIDDEN_RE = re.compile(r"name='h(\d+)' value='([^']*)'", re.S)
TYPEK_RE = re.compile(r'TYPEK\.value="(\w+)"')
ROW_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S)
CELL_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.S)
ROC_RE = re.compile(r"(\d{2,3})/(\d{1,2})/(\d{1,2})")
FIN_KEY = "財務報告或年度自結財務資訊"
FIN_ITEMS = {"rev": r"4\.1月1日累計至本期止營業收入", "op": r"6\.1月1日累計至本期止營業利益",
             "ni": r"9\.1月1日累計至本期止歸屬於母公司業主淨利", "eps": r"10\.1月1日累計至本期止基本每股盈餘"}


def roc(s: str):
    m = ROC_RE.search(s or "")
    return f"{int(m.group(1)) + 1911:04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}" if m else None


def text(raw: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", raw))).strip()


def value(content: str, pattern: str):
    """制式表格的一個數字；括號或負號是負的，空的或「不適用」回 None。"""
    m = re.search(pattern + r"[^:：]*[:：]\s*([^\n]*)", content)
    if not m:
        return None
    s = m.group(1).replace("$", "").replace("NT", "").replace("元", "").strip()
    neg = s.startswith("(") or s.startswith("-") or s.startswith("−")
    n = twse.clean_number(re.sub(r"[()\-−\s]", "", s))
    if n is None:
        return None
    n = -n if neg else n
    return int(n) if n == int(n) else n


def for_subsidiary(subject: str) -> bool:
    """代子公司公告的：數字是子公司的，卻掛在母公司代號下"""
    return subject.startswith("代") or "代子公司" in subject or "代重要子公司" in subject or subject.startswith("重要子公司")


def classify(subject: str, content: str):
    if for_subsidiary(subject):
        return None, None
    if FIN_KEY in content:
        m = re.search(r"起訖日期[^:：]*[:：]\s*(\d+/\d+/\d+)\s*[~～-]\s*(\d+/\d+/\d+)", content)
        nums = {k: value(content, p) for k, p in FIN_ITEMS.items()}
        nums["p"] = [roc(m.group(1)), roc(m.group(2))] if m else None
        return "fin", nums
    if "自結" in subject:
        return "self", None
    if "法人說明會" in subject or "法說會" in subject:
        return "conf", None
    if "注意交易資訊" in subject:
        return "attn", None
    return None, None


def post(url: str, data: dict, session: requests.Session, ok: str, retries: int = 4):
    """回應的文字；查無資料回 ""，抓失敗回 None。"""
    for k in range(retries):
        try:
            r = session.post(url, data=data, headers=HEADERS, timeout=60)
            t = r.content.decode("utf-8", errors="replace")
            if "查無" in t:
                return ""
            if ok in t:
                return t
            # 太頻繁時觀測站回一頁「請稍後再試」之類的東西，退一下再來
        except requests.RequestException:
            pass
        time.sleep(10 * (k + 1))
    return None


def fetch_news(day: date, session: requests.Session):
    t = post(NEWS_URL, {"encodeURIComponent": "1", "step": "0", "firstin": "true", "off": "1",
                        "year": str(day.year - 1911), "month": str(day.month), "day": str(day.day)},
             session, "發言日期")
    if t is None:
        return None
    out = []
    for form in FORM_RE.findall(t):
        f = {k[-1]: v for k, v in HIDDEN_RE.findall(form)}   # h<列><欄>：欄 0 名稱 1 代號 2 日期 3 時間 4 主旨 8 內文
        mk = TYPEK_RE.search(form)
        if not f.get("1") or not mk or mk.group(1) not in MARKETS:
            continue
        subject = re.sub(r"\s+", "", html.unescape(f.get("4", "")))
        kind, nums = classify(subject, html.unescape(f.get("8", "")))
        if not kind:
            continue
        d, tm = f.get("2", ""), f.get("3", "").zfill(6)
        out.append([f"{d[:4]}-{d[4:6]}-{d[6:8]}", f"{tm[:2]}:{tm[2:4]}", f["1"].strip(), kind, subject[:120], nums])
    return out


def fetch_conf(year: int, market: str, session: requests.Session):
    t = post(CONF_URL, {"encodeURIComponent": "1", "step": "1", "firstin": "true", "off": "1",
                        "TYPEK": market, "year": str(year - 1911), "month": "all"}, session, "召開法人說明會日期")
    if t is None:
        return None
    out = []
    for row in ROW_RE.findall(t):
        cells = [text(c) for c in CELL_RE.findall(row)]
        if len(cells) < 6 or not re.match(r"\d{4}[A-Z]?$", cells[0]):
            continue
        days = ROC_RE.findall(cells[2])
        if not days:
            continue
        start, end = (roc("/".join(x)) for x in (days[0], days[-1]))
        out.append([cells[0], start, end if end != start else None, cells[3][:5], cells[5][:80]])
    return out


def load(path):
    return twse.read_json(path) if path.exists() else []


def main():
    ap = argparse.ArgumentParser(description="抓法說會、財報與自結損益公告")
    ap.add_argument("--since", help="重大訊息從哪一天開始（YYYY-MM-DD）；預設最近 4 天")
    ap.add_argument("--until", help="到哪一天（含）；預設今天")
    ap.add_argument("--out", help="寫到哪個資料夾；預設 docs/data/events（分段平行回補時各寫各的，再合併）")
    ap.add_argument("--sleep", type=float, default=3.0)
    args = ap.parse_args()
    out_dir = Path(args.out) if args.out else OUT_DIR
    today = date.fromisoformat(args.until) if args.until else twse.taipei_today()
    since = date.fromisoformat(args.since) if args.since else today - timedelta(days=3)
    days = [since + timedelta(n) for n in range((today - since).days + 1)]
    session = requests.Session()
    failed = []

    by_year = {}

    def flush():
        for y, rows in by_year.items():
            seen, uniq = set(), []
            for r in sorted(rows, key=lambda r: (r[0], r[1], r[2])):
                key = (r[0], r[1], r[2], r[4])
                if key not in seen:
                    seen.add(key)
                    uniq.append(r)
            twse.write_if_changed(out_dir / f"{y}.json", uniq)

    for n, day in enumerate(days, 1):
        got = fetch_news(day, session)
        time.sleep(args.sleep)
        if got is None:
            failed.append(day.isoformat())
            continue
        for r in got:
            y = int(r[0][:4])
            if y not in by_year:
                by_year[y] = load(out_dir / f"{y}.json")
            by_year[y].append(r)
        if n % 30 == 0 or n == len(days):
            flush()
            print(f"  {day}（{n}/{len(days)}）", flush=True)

    years = range(since.year, today.year + 1) if args.since else [today.year] + ([today.year + 1] if today.month == 12 else [])
    for y in years:
        rows = []
        for market in MARKETS:
            got = fetch_conf(y, market, session)
            time.sleep(args.sleep)
            if got is None:
                failed.append(f"conf {y} {market}")
                rows = None
                break
            rows += got
        if rows is not None:
            twse.write_if_changed(out_dir / f"conf_{y}.json", sorted(set(map(tuple, rows)), key=lambda r: (r[1], r[0])))
    total = sum(len(v) for v in by_year.values())
    print(f"公告事件：{len(days)} 天，涉及年份共 {total} 筆" + (f"；失敗 {len(failed)}：{failed[:10]}" if failed else ""))


if __name__ == "__main__":
    main()
