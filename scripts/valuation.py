"""價值頁（value.html）的資料來源：本益比／殖利率／股淨比，與月營收。

## 本益比、殖利率、股淨比

    上市  https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?date=YYYYMMDD&selectType=ALL
    上櫃  https://www.tpex.org.tw/www/zh-tw/afterTrading/peQryDate?date=YYYY/MM/DD

兩邊都是證交所／櫃買自己算的「近四季 EPS」本益比，虧損的公司是空的或 N/A。
一個日期一次給全市場，而且查得到好幾年前。

**只存每個月最後一個交易日**：`value/pe/<市場>/YYYY-MM.json`。這一頁要的是「這一檔的
本益比落在它自己過去五年的哪一格」，那個區間用每月一個點就畫得出來；逐日存的話五年
是兩個市場各一千多個檔案、四十幾 MB，換來的只是區間的邊緣準一點點。當月那一檔每天
被覆寫成最新一天，所以它永遠是「目前」，月份一過就凍住成那個月的月底。

代價要說清楚：每月一點會**低估**真正的年內最高與最低（月中的極值取不到），所以「平均
最低本益比」會比逐日算的略高、「平均最高」略低 —— 便宜與昂貴兩道門檻都往中間收一點。

## 月營收

    上市  https://mopsov.twse.com.tw/nas/t21/sii/t21sc03_<民國年>_<月>_0.html
    上櫃  https://mopsov.twse.com.tw/nas/t21/otc/t21sc03_<民國年>_<月>_0.html

公開資訊觀測站的靜態彙總表，一個月一頁、Big5、全市場。openapi 的 t187ap05 只給最新
一個月，要看「成長有沒有在加速」「是不是一年來新高」就得有前面幾個月，所以走這條。
結尾的 `_0` 是國內公司，`_1` 是 KY 等外國公司，兩頁都要。

存成 `value/rev/YYYY-MM.json`：{代號: [當月營收（千元）, 年增率 %]}。
"""

from __future__ import annotations

import re
from datetime import date, timedelta

import requests

import twse

VALUE_DIR = twse.DATA_DIR / "value"
PE_DIR = VALUE_DIR / "pe"
REV_DIR = VALUE_DIR / "rev"

TWSE_PE_URL = "https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d"
TPEX_PE_URL = "https://www.tpex.org.tw/www/zh-tw/afterTrading/peQryDate"
MOPS_REV_URL = "https://mopsov.twse.com.tw/nas/t21/{board}/t21sc03_{roc}_{month}_{kind}.html"

MARKETS = ("twse", "tpex")
BOARDS = {"twse": "sii", "tpex": "otc"}


def pe_path(market: str, month: str):
    return PE_DIR / market / f"{month}.json"


def rev_path(month: str):
    return REV_DIR / f"{month}.json"


def _num(raw):
    v = twse.clean_number(raw)
    return None if v is None else round(float(v), 2)


def _check_fields(fields: list, want: dict, source: str) -> dict:
    """欄位名 -> 位置。對不上就直接停：欄位順序換了卻照舊位置讀，每一格都會是合法的數字。"""
    out = {}
    for key, label in want.items():
        hits = [i for i, f in enumerate(fields) if label in f]
        if not hits:
            raise RuntimeError(f"{source} 欄位格式已改變，找不到「{label}」：{fields}")
        out[key] = hits[0]
    return out


def fetch_pe(market: str, day: date):
    """那一天全市場的 {代號: [本益比, 殖利率, 股淨比]}；不是交易日回 None。"""
    if market == "twse":
        raw = twse.fetch_json(TWSE_PE_URL, {"date": day.strftime("%Y%m%d"),
                                            "selectType": "ALL", "response": "json"})
        if raw.get("stat") != "OK":
            return None
        fields, rows = raw.get("fields") or [], raw.get("data") or []
    else:
        raw = twse.fetch_json(TPEX_PE_URL, {"date": day.strftime("%Y/%m/%d"), "response": "json"})
        tables = raw.get("tables") or []
        if not tables or not tables[0].get("data"):
            return None
        fields, rows = tables[0].get("fields") or [], tables[0]["data"]

    col = _check_fields(fields, {"code": "代號", "pe": "本益比", "yld": "殖利率", "pb": "淨值比"},
                        market)
    out = {}
    for row in rows:
        code = str(row[col["code"]]).strip()
        if not twse.is_tracked_code(code):
            continue
        out[code] = [_num(row[col["pe"]]), _num(row[col["yld"]]), _num(row[col["pb"]])]
    return out or None


def fetch_pe_on_or_before(market: str, day: date, *, tries: int = 15):
    """day 當天或往前最近一個交易日的 (日期, 資料)。月底常是週末或連假，最多往回找 tries 天。

    15 天是給農曆年的：2025 年的封關是 1/22，從 1/31 往回找要 9 天。
    """
    for back in range(tries):
        d = day - timedelta(days=back)
        got = fetch_pe(market, d)
        if got:
            return d, got
    return None, None


ROW_RE = re.compile(
    r"<tr align=right><td align=center>([0-9A-Z]{4,6})</td><td align=left>[^<]*</td>"
    r"((?:<[tT][dD][^>]*>[^<]*</[tT][dD]>){5})",
)
CELL_RE = re.compile(r"<[tT][dD][^>]*>([^<]*)</[tT][dD]>")


def fetch_revenue(market: str, year: int, month: int):
    """那個月全市場的 {代號: [當月營收（千元）, 年增率 %]}；還沒公布回 None。

    欄位依序是：當月營收、上月營收、去年當月營收、上月比較增減%、去年同月增減%……
    只取第一與第五欄。表頭是跨兩列的合併儲存格，用位置讀比用名字讀可靠；而位置對不對，
    由「年增率 ≈ 當月 ÷ 去年當月 − 1」逐列驗證（見下）。
    """
    out = {}
    checked = bad = 0
    for kind in ("0", "1"):
        url = MOPS_REV_URL.format(board=BOARDS[market], roc=year - 1911, month=month, kind=kind)
        try:
            resp = requests.get(url, headers=twse.HEADERS, timeout=40)
        except requests.RequestException as err:
            raise RuntimeError(f"抓不到 {url}：{err}") from err
        if resp.status_code == 404:
            continue
        resp.raise_for_status()
        html = resp.content.decode("big5-hkscs", errors="replace")
        for code, cells in ROW_RE.findall(html):
            vals = [twse.clean_number(c) for c in CELL_RE.findall(cells)]
            now, last_year, yoy = vals[0], vals[2], vals[4]
            if now is None:
                continue
            # 去年同月是 0 或負數（有公司真的申報負營收）時，年增率沒有意義
            if not last_year or last_year <= 0:
                yoy = None
            # 位置讀錯的話這條等式幾乎不可能成立。個別幾列可能是公司自己申報的數字
            # 對不上，所以看比例：整頁有一成對不上，才是欄位位移了
            if yoy is not None:
                checked += 1
                if abs((now / last_year - 1) * 100 - yoy) > 1:
                    bad += 1
            out[code] = [int(now), None if yoy is None else round(float(yoy), 1)]
    if checked and bad / checked > 0.1:
        raise RuntimeError(f"{market} {year}-{month:02d} 月營收有 {bad}/{checked} 列的年增率對不上，欄位可能位移了")
    return out or None
