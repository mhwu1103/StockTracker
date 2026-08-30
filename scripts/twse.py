"""共用工具：抓取上市（證交所）與上櫃（櫃買中心）公開資料並正規化欄位。

四個資料來源產出的紀錄格式完全相同，差別只在市場與可查詢的日期：

                  當日（每日排程）        任一交易日（歷史回補）
    上市 TWSE     STOCK_DAY_ALL          MI_INDEX
    上櫃 TPEx     tpex_mainboard_quotes  dailyQuotes

排行分成三種範圍（scope）：all 全部、twse 上市、tpex 上櫃。
抓取端只產出 twse 與 tpex，all 由 build_history.py 合併兩者算出來。
"""

from __future__ import annotations

import json
import re
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
SITE_DIR = ROOT / "docs"
DATA_DIR = SITE_DIR / "data"
DAILY_DIR = DATA_DIR / "daily"
CLOSE_DIR = DATA_DIR / "close"
HISTORY_DIR = DATA_DIR / "history"
INDEX_PATH = DATA_DIR / "index.json"

# 多存 100 名，前端才能正確判斷前 200 名的「進榜／掉出榜」
TOP_N = 300

# 「進榜」的定義：成交值前 200 名。連續進榜天數以此為準，需與前端 app.js 的 TOP 一致。
STREAK_RANK = 200

TAIPEI = timezone(timedelta(hours=8))

STOCK_DAY_ALL_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
MI_INDEX_URL = "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX"

# 上櫃。openapi 那支不含權證；dailyQuotes 含權證，但會被 is_tracked_code 濾掉。
TPEX_QUOTES_URL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes"
TPEX_DAILY_URL = "https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes"

SCOPES = ("all", "twse", "tpex")
SCOPE_NAMES = {"all": "全部", "twse": "上市", "tpex": "上櫃"}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) StockTracker/1.0",
    "Accept": "application/json, text/plain, */*",
}

# 只追蹤普通股／特別股（4 碼 + 選擇性英文字母）與 ETF／ETN（00 開頭），
# 排除權證、牛熊證等 6 碼商品。
_CODE_RE = re.compile(r"^(?:\d{4}[A-Z]?|00\d{2,4}[A-Z]?)$")
_TAG_RE = re.compile(r"<[^>]*>")


# --------------------------------------------------------------------------- #
# 基礎工具
# --------------------------------------------------------------------------- #
def taipei_today() -> date:
    return datetime.now(TAIPEI).date()


def is_tracked_code(code: str) -> bool:
    return bool(_CODE_RE.match(str(code).strip()))


def strip_tags(raw) -> str:
    return _TAG_RE.sub("", str(raw)).replace("　", " ").strip()


def clean_number(raw):
    """'1,234,567' -> 1234567.0；'--'、''、'X'、None -> None"""
    if raw is None:
        return None
    text = strip_tags(raw).replace(",", "").replace("+", "").replace(" ", "")
    if text in ("", "--", "---", "X", "x", "N/A"):
        return None
    try:
        return float(text)
    except ValueError:
        return None


def roc_to_iso(roc) -> str:
    """民國日期 '1150814' 或 '115/08/14' -> '2026-08-14'"""
    text = str(roc).strip()
    if "/" in text:
        year, month, day = text.split("/")
    else:
        text = text.zfill(7)
        year, month, day = text[:-4], text[-4:-2], text[-2:]
    return f"{int(year) + 1911:04d}-{int(month):02d}-{int(day):02d}"


def change_pct(close, change):
    """由收盤價與漲跌價差回推漲跌百分比。"""
    if close is None or change is None:
        return None
    prev = close - change
    if prev <= 0:
        return None
    return round(change / prev * 100, 2)


def fetch_json(url, params=None, *, retries=3, timeout=30, backoff=3.0):
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            resp = requests.get(url, params=params, headers=HEADERS, timeout=timeout)
            resp.raise_for_status()
            return resp.json()
        except Exception as err:  # 網路錯誤、限流、非 JSON 回應都在此重試
            last_err = err
            if attempt < retries:
                wait = backoff * attempt
                print(f"  ! {type(err).__name__}: {err} — {wait:.0f} 秒後重試 ({attempt}/{retries})")
                time.sleep(wait)
    raise RuntimeError(f"抓取失敗 {url} params={params}：{last_err}")


# --------------------------------------------------------------------------- #
# 紀錄組裝
# --------------------------------------------------------------------------- #
def make_record(code, name, volume, value, close, change, open_=None):
    """把任一來源的一列資料轉成統一格式；不該追蹤或無成交者回傳 None。

    open_（開盤價）是後來才加的欄位，四個來源都拿得到。這一天的資料若是在加欄位
    之前抓的，檔案裡就沒有 open，前端要能容忍它不存在（見 docs/app.js 的爆量分頁）。
    """
    code = str(code).strip()
    if not is_tracked_code(code):
        return None
    trade_value = clean_number(value)
    if not trade_value:
        return None
    close_price = clean_number(close)
    return {
        "code": code,
        "name": strip_tags(name),
        "value": int(trade_value),
        "volume": int(clean_number(volume) or 0),
        "close": close_price,
        "open": clean_number(open_),
        "changePct": change_pct(close_price, clean_number(change)),
    }


def build_payload(date_iso: str, source: str, records: list, top_n: int = TOP_N) -> dict:
    ordered = sorted(records, key=lambda r: r["value"], reverse=True)
    top = []
    for rank, rec in enumerate(ordered[:top_n], start=1):
        item = dict(rec)
        item["rank"] = rank
        top.append(item)
    return {
        "date": date_iso,
        "source": source,
        "marketCount": len(ordered),
        "marketValue": sum(r["value"] for r in ordered),
        "stocks": top,
    }


def daily_path(date_iso: str, scope: str = "twse") -> Path:
    return DAILY_DIR / scope / f"{date_iso}.json"


def close_path(date_iso: str, scope: str = "twse") -> Path:
    return CLOSE_DIR / scope / f"{date_iso}.json"


def history_path(year, scope: str = "twse") -> Path:
    return HISTORY_DIR / scope / f"{year}.json"


def write_json(path: Path, payload) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    return path


def write_daily(payload: dict, scope: str = "twse") -> Path:
    return write_json(daily_path(payload["date"], scope), payload)


def write_closes(date_iso: str, scope: str, records: list) -> Path:
    """把當日「全市場」的收盤價另存一份，給均線用。

    daily/ 只留成交值前 300 名，算均線卻需要連續 N 個交易日的收盤價——
    一檔只要有幾天掉出前 300，那段就是空的，均線就算不出來（60 日線只有一半的
    榜上股票湊得齊）。所以收盤價要全市場都留，檔案也才不到 daily 的一半大。
    """
    closes = {r["code"]: r["close"] for r in records if r["close"] is not None}
    return write_json(
        close_path(date_iso, scope),
        {"date": date_iso, "c": {c: closes[c] for c in sorted(closes)}},
    )


# --------------------------------------------------------------------------- #
# 來源一：當日全部上市收盤行情（OpenAPI）
# --------------------------------------------------------------------------- #
def fetch_stock_day_all():
    rows = fetch_json(STOCK_DAY_ALL_URL)
    if not rows:
        raise RuntimeError("STOCK_DAY_ALL 回傳空資料")
    date_iso = roc_to_iso(rows[0]["Date"])
    records = []
    for row in rows:
        rec = make_record(
            row.get("Code"),
            row.get("Name"),
            row.get("TradeVolume"),
            row.get("TradeValue"),
            row.get("ClosingPrice"),
            row.get("Change"),
            row.get("OpeningPrice"),
        )
        if rec:
            records.append(rec)
    return date_iso, records


# --------------------------------------------------------------------------- #
# 來源二：指定日期全部上市收盤行情（歷史回補）
# --------------------------------------------------------------------------- #
def fetch_mi_index(day: date):
    """回傳 (date_iso, records)；非交易日回傳 None。"""
    payload = fetch_json(
        MI_INDEX_URL,
        {"date": day.strftime("%Y%m%d"), "type": "ALLBUT0999", "response": "json"},
    )
    if not payload or payload.get("stat") != "OK":
        return None

    table = next(
        (t for t in payload.get("tables") or [] if "每日收盤行情" in (t.get("title") or "")),
        None,
    )
    if table is None or not table.get("data"):
        return None

    fields = [re.sub(r"\s", "", str(f)) for f in table.get("fields") or []]

    def idx(label):
        for i, field in enumerate(fields):
            if field.startswith(label):
                return i
        return None

    i_code, i_name = idx("證券代號"), idx("證券名稱")
    i_volume, i_value = idx("成交股數"), idx("成交金額")
    i_close, i_diff, i_sign = idx("收盤價"), idx("漲跌價差"), idx("漲跌(+/-)")
    i_open = idx("開盤價")
    if None in (i_code, i_name, i_volume, i_value, i_close, i_diff):
        raise RuntimeError(f"MI_INDEX 欄位格式已改變：{fields}")

    records = []
    for row in table["data"]:
        diff = clean_number(row[i_diff])
        if diff is not None and i_sign is not None and strip_tags(row[i_sign]).startswith("-"):
            diff = -diff
        rec = make_record(row[i_code], row[i_name], row[i_volume], row[i_value], row[i_close], diff,
                          row[i_open] if i_open is not None else None)
        if rec:
            records.append(rec)

    if not records:
        return None
    return day.isoformat(), records


# --------------------------------------------------------------------------- #
# 來源三：當日全部上櫃收盤行情（OpenAPI）
# --------------------------------------------------------------------------- #
def fetch_tpex_quotes():
    rows = fetch_json(TPEX_QUOTES_URL)
    if not rows:
        raise RuntimeError("tpex_mainboard_quotes 回傳空資料")
    date_iso = roc_to_iso(rows[0]["Date"])
    records = []
    for row in rows:
        rec = make_record(
            row.get("SecuritiesCompanyCode"),
            row.get("CompanyName"),
            row.get("TradingShares"),
            row.get("TransactionAmount"),
            row.get("Close"),
            row.get("Change"),          # 這裡的漲跌已自帶正負號
            row.get("Open"),
        )
        if rec:
            records.append(rec)
    return date_iso, records


# --------------------------------------------------------------------------- #
# 來源四：指定日期全部上櫃收盤行情（歷史回補）
# --------------------------------------------------------------------------- #
def fetch_tpex_daily(day: date):
    """回傳 (date_iso, records)；非交易日回傳 None。

    非交易日的 stat 一樣是 ok，只是 data 為空，所以要看筆數而不是看 stat。
    """
    payload = fetch_json(
        TPEX_DAILY_URL,
        {"date": day.strftime("%Y/%m/%d"), "type": "EW", "response": "json"},
    )
    table = next(
        (t for t in (payload or {}).get("tables") or [] if t.get("data")),
        None,
    )
    if table is None:
        return None

    fields = [re.sub(r"\s", "", str(f)) for f in table.get("fields") or []]

    def idx(label):
        for i, field in enumerate(fields):
            if field.startswith(label):
                return i
        return None

    i_code, i_name = idx("代號"), idx("名稱")
    i_volume, i_value = idx("成交股數"), idx("成交金額")
    i_close, i_diff = idx("收盤"), idx("漲跌")
    i_open = idx("開盤")
    if None in (i_code, i_name, i_volume, i_value, i_close, i_diff):
        raise RuntimeError(f"TPEx dailyQuotes 欄位格式已改變：{fields}")

    records = []
    for row in table["data"]:
        rec = make_record(row[i_code], row[i_name], row[i_volume], row[i_value],
                          row[i_close], row[i_diff],
                          row[i_open] if i_open is not None else None)
        if rec:
            records.append(rec)

    if not records:
        return None
    return day.isoformat(), records


# --------------------------------------------------------------------------- #
# 既有資料查詢
# --------------------------------------------------------------------------- #
def existing_dates(scope: str = "twse") -> list:
    return _stems(DAILY_DIR / scope)


def existing_close_dates(scope: str = "twse") -> list:
    return _stems(CLOSE_DIR / scope)


def _stems(folder: Path) -> list:
    if not folder.exists():
        return []
    return sorted(p.stem for p in folder.glob("*.json"))
