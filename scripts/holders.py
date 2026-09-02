"""共用工具：抓取集保戶股權分散表（TDCC），解出「大戶／散戶各佔幾成」。

## 一個檔案就是全市場的一週

集保結算所每週五結算一次，把每一檔的股東依持股張數分成 15 級（另有第 16 級
「差異數調整」與第 17 級「合計」），整份以 CSV 公開：

    https://opendata.tdcc.com.tw/getOD.ashx?id=1-5

一次 2.3 MB、四千多檔、六萬八千列，但**只給最新那一週** —— 帶 date 參數也沒用，
回來的還是同一份。所以歷史跟報價一樣得自己累積，抓到的每一週存成一份快照：

    docs/data/holders/weekly/YYYY-MM-DD.json    檔名是「資料日」，不是抓取日

## 存的是「累積級距梯」，不是每一級的人數與股數

15 級 × 人數與股數 × 三千多檔，一週就是十幾 MB。但只存幾個併好的桶又會把
「大戶」寫死成某一個門檻 —— 400 張以上算大戶還是 1,000 張才算，本來就該是
畫面上可以選的東西。折衷是存**累積比例**：

    cum1 .. cum15    第 N 級（含）以上的持股，佔集保庫存數的比例

任何一個門檻都是直接查表：「400 張以上」就是 cum12、「千張大戶」就是 cum15；
「100 張以下的散戶」是 cum1 − cum10（cum1 已經排除了不屬於任何級距的差異數調整）。
單一級距要的話就是相鄰兩項相減。換句話說，官方那張表在「比例」這個維度上的
解析度全都留著了，以後想看哪個門檻都不必重抓一次。

比例之外還存了大戶那幾層的**人數**：

    p10 .. p15       第 N 級（含）以上有幾個集保帳戶

因為比例會被「跨門檻」騙。一個原本持有 900 張的帳戶買到 1,100 張，他整個部位會從
400~1000 張那一層一次跳到千張那一層 —— 比例搬動一大塊，人數卻只多一個。少了人數
就分不出「有人從市場上買進來」與「原本就在的人跨過了那條線」，而後者在小型股上
非常常見（一檔七萬張的股票，一個千張帳戶就是 1.3 個百分點）。

人數只留 p10~p15，對齊前端門檻選單給得出的那六個張數；散戶人數是合計減去 p10。
下面那九級的人數沒有留 —— 「散戶裡有幾個人持有 5~10 張」不是這一頁會問的問題。

比例一律由「股數 ÷ 第 17 級的合計股數」現算，不是把官方那欄四捨五入到小數點後
兩位的百分比加起來 —— 每一級各差 0.005、累加十幾級就會差到 0.05 個百分點，
而這一頁在看的週變化本來就常常只有 0.1 個百分點。

## 這些數字不等於「主力」

集保的分級是**帳戶**的持股，不是實質股東：

* 外資的持股掛在保管銀行的帳戶底下，一家保管銀行就是一個千張大戶帳戶。
  台積電的千張大戶比例常年在八成以上，那是外資與國發基金，不是有人在偷偷吃貨。
* 公司派、董監、庫藏股同樣落在大戶級距，他們不會因為股價漲跌就進出。
* 未集保的實體股票不在這份資料裡，分母是集保庫存數而不是發行股數。

所以這一份能講的是「**這一週集中度往哪個方向動**」，不是「主力今天買了多少」。

## 兩個入口，兩種形狀

    opendata 的 CSV      全市場 × 最新一週      一次一個請求
    官網的個股查詢頁     一檔   × 任一週        一次一個請求，但一次只有一檔

第二個入口（`qryStock`）的下拉選單留著近一年的週資料日，是唯一補得到「上週」的
地方 —— opendata 那份被下一週蓋掉就沒了。代價是它一次只給一檔，補一段歷史等於
「週數 × 檔數」次請求，所以只能補一批看得最多的股票，補出來的那幾週因此是
**部分涵蓋**的，快照要用 partial 與 why 標明白。
"""

from __future__ import annotations

import csv
import io
import json
import re
from collections import Counter
from pathlib import Path

import requests

import twse

HOLDERS_DIR = twse.DATA_DIR / "holders"
WEEKLY_DIR = HOLDERS_DIR / "weekly"
STOCK_DIR = HOLDERS_DIR / "stock"
HOLDERS_INDEX_PATH = HOLDERS_DIR / "index.json"

TDCC_URL = "https://opendata.tdcc.com.tw/getOD.ashx?id=1-5"
# 官網的個股股權分散表查詢。下拉選單留著近一年的週資料日，是唯一補得到「上週」的地方。
TDCC_STOCK_URL = "https://www.tdcc.com.tw/portal/zh/smWeb/qryStock"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) StockTracker/1.0",
    "Accept": "text/csv,text/plain,*/*",
}

# 級距編號。第 16 級是差異數調整、第 17 級是合計，兩者都不是「某一段持股區間」。
LEVEL_TOTAL = 17
LEVEL_MAX = 15          # 真正代表持股區間的級距只有 1~15

# 15 個級距各自的下界（股）。CSV 那一邊直接給級距編號，個股查詢頁沒有 ——
# 它的「序」欄只是列號：有「差異數調整」那一列的股票合計排在第 17 列、沒有的排在
# 第 16 列（2454 就沒有）。照序號讀，後者的合計會被當成第 16 級而整筆被丟掉，
# 所以那一邊改認級距文字的下界，再對回這裡的編號。
LEVEL_FLOORS = (1, 1000, 5001, 10001, 15001, 20001, 30001, 40001, 50001,
                100001, 200001, 400001, 600001, 800001, 1000001)
FLOOR_TO_LEVEL = {floor: i + 1 for i, floor in enumerate(LEVEL_FLOORS)}
# 每一級的下界換算成「張」（1 張 = 1,000 股）。第 1 級是 1~999 股，不到一張，
# 所以下界寫 0；其餘的下界都是「N 張又 1 股」，講成「N 張以上」正是市場的說法。
LOT_FLOORS = (0, 1, 5, 10, 15, 20, 30, 40, 50, 100, 200, 400, 600, 800, 1000)
# 張數門檻 -> 級距編號。前端的門檻選單只能從這裡挑，官方的表就這個解析度。
LEVEL_OF_LOTS = {lots: i + 1 for i, lots in enumerate(LOT_FLOORS)}

# 要留人數的級距，與前端門檻選單的六個張數（100/200/400/600/800/1000）一一對應
PEOPLE_LEVELS = (10, 11, 12, 13, 14, 15)

# 快照裡每一檔的 17 個數字，順序即 index。前端與 build_holders.py 都照這個順序讀。
#   cum1..cum15  第 N 級（含）以上佔集保庫存數的比例（%）
#   holders      股東人數（集保帳戶數）
#   lots         集保庫存張數
FIELDS = (tuple(f"cum{i}" for i in range(1, LEVEL_MAX + 1))
          + tuple(f"p{i}" for i in PEOPLE_LEVELS)
          + ("holders", "lots"))

# 快照格式版號。欄位一改就加一 —— 舊格式的檔案混進來會算出安靜的錯誤答案，
# 那比整個掛掉還糟，所以 build_holders.py 讀到對不上的版號會直接停下來。
SNAPSHOT_VERSION = 3


def fetch_csv(*, url: str = TDCC_URL, timeout: int = 120) -> str:
    """抓回整份 CSV。UTF-8 帶 BOM，用 utf-8-sig 解才不會讓第一個欄名多一顆 ﻿。"""
    res = requests.get(url, headers=HEADERS, timeout=timeout)
    res.raise_for_status()
    return res.content.decode("utf-8-sig", errors="replace")


def parse_csv(text: str) -> tuple:
    """CSV -> (資料日 YYYY-MM-DD, {代號: [千張%, 大戶%, 散戶%, 股東人數, 張數]}, 是否被截斷)。

    只留與本站排行同一套規則的代號（普通股、特別股、ETF／ETN，排除權證），
    以及集保庫存數大於 0 的 —— 合計是 0 的那些在畫面上只會是一排 0.00%。

    第三個回傳值是「這份檔案有沒有被切掉一半」。網頁典藏館的抓取上限是 1 MB，
    2.3 MB 的原始檔會在中途被硬生生截斷 —— 檔案結尾少了換行就是那個樣子。
    被切掉的那一段代號（大約 5300 以後）在那一週看起來會像是「沒有資料」，
    但它其實只是沒被典藏到，所以要標出來，別讓人以為那些股票當週退出了集保。
    """
    reader = csv.reader(io.StringIO(text))
    header = next(reader, None)
    if not header or len(header) < 6:
        raise RuntimeError("CSV 沒有表頭或欄位數不對，來源格式可能改了")

    days = Counter()
    levels = {}
    last_code = ""
    for row in reader:
        if len(row) < 6:
            continue
        day, code, level = row[0].strip(), row[1].strip(), row[2].strip()
        if not day.isdigit() or len(day) != 8 or not level.isdigit():
            continue
        if not twse.is_tracked_code(code):
            continue
        shares = twse.clean_number(row[4])
        people = twse.clean_number(row[3])
        if shares is None:
            continue
        days[day] += 1
        last_code = code
        levels.setdefault(code, {})[int(level)] = (people, shares)

    if not days:
        raise RuntimeError("CSV 解不出任何一列（來源格式可能改了）")

    # 整份理應只有一個資料日，但真的混了別天的話以列數最多的那天為準，並講出來。
    day_raw, _ = days.most_common(1)[0]
    if len(days) > 1:
        others = ", ".join(f"{d}×{n}" for d, n in days.most_common()[1:])
        print(f"  · 這份 CSV 混了不只一個資料日，取列數最多的 {day_raw}（另有 {others}）")
    date_iso = f"{day_raw[:4]}-{day_raw[4:6]}-{day_raw[6:]}"

    stocks = {}
    for code, by_level in levels.items():
        row = summarise(by_level)
        if row:
            stocks[code] = row
    if not stocks:
        raise RuntimeError("解得出資料日卻沒有任何一檔有庫存，來源格式可能改了")

    # 檔案結尾沒有換行，或最後一檔連合計那一列都湊不齊 —— 兩者都是被截斷的樣子
    partial = not text.endswith("\n") or (last_code and last_code not in stocks)
    return date_iso, dict(sorted(stocks.items())), bool(partial)


def summarise(by_level: dict):
    """一檔的 15 級明細 -> [cum1..cum15, p10..p15, 股東人數, 張數]；沒有庫存就回 None。

    兩段都是由最高的一級往下累加，所以 cum15 是千張大戶的持股比例、p15 是千張大戶
    有幾個帳戶；cum1 是全部 15 級的合計（比 100% 少掉的就是差異數調整那一列）。
    """
    total = by_level.get(LEVEL_TOTAL)
    if not total:
        return None
    people, shares = total
    if not shares or shares <= 0:
        return None

    ladder = []
    running = 0.0
    for level in range(LEVEL_MAX, 0, -1):
        entry = by_level.get(level)
        running += entry[1] if entry else 0.0
        ladder.append(round(running / shares * 100, 2))
    ladder.reverse()

    heads = []
    counted = 0
    for level in range(LEVEL_MAX, min(PEOPLE_LEVELS) - 1, -1):
        entry = by_level.get(level)
        counted += int(entry[0] or 0) if entry else 0
        if level in PEOPLE_LEVELS:
            heads.append(counted)
    heads.reverse()

    return ladder + heads + [int(people or 0), round(shares / 1000)]      # 股 -> 張


def build_snapshot(date_iso: str, stocks: dict, *, source: str,
                   partial: bool = False, truncated: bool = False) -> dict:
    """一份快照。

    source 是哪裡來的：live 現抓、wayback 網頁典藏館、stock 官網逐檔查詢頁，
    mixed 則是同一週被兩種來源補過。

    partial 為真代表「這一份不是全市場」，畫面上一定要講得出理由，不然少掉的那些
    看起來就像退出了集保。理由本身不存在快照裡 —— 存的是 source 與 truncated
    這兩個事實，句子由 build_holders.py 的 why_of() 組出來。把整句話寫進每一份快照，
    那句話會跟著當時的檔數一起過期（補到一半那次寫的「只涵蓋 3 檔」補完就不對了）。
    """
    payload = {
        "date": date_iso,
        "v": SNAPSHOT_VERSION,
        "source": source,
        "n": len(stocks),
        "fields": list(FIELDS),
    }
    if partial:
        payload["partial"] = True
    if truncated:
        payload["truncated"] = True
    payload["stocks"] = stocks
    return payload


# --------------------------------------------------------------------------- #
# 逐檔查詢頁
# --------------------------------------------------------------------------- #
_TOKEN_RE = re.compile(r'name="SYNCHRONIZER_TOKEN" value="([^"]+)"')
_SCADATE_RE = re.compile(r'<option value="(\d{8})"')
_ROW_RE = re.compile(
    r"<tr[^>]*>\s*<td[^>]*>\s*[^<]*?\s*</td>"          # 序：只是列號，不可信
    r"\s*<td[^>]*>\s*([^<]*?)\s*</td>"                 # 持股分級：這才認得出級距
    r"\s*<td[^>]*>\s*([-\d,]*)\s*</td>"                # 人數（差異數調整那列可能是空的）
    r"\s*<td[^>]*>\s*([-\d,]*)\s*</td>",               # 股數（可能是負的）
    re.S,
)


def form_token(page_html: str) -> str:
    """表單的一次性 CSRF token。每送出一次就換一個，回應裡會帶著下一個。"""
    found = _TOKEN_RE.search(page_html)
    if not found:
        raise RuntimeError("查詢頁上找不到 SYNCHRONIZER_TOKEN，版面可能改了")
    return found.group(1)


def form_dates(page_html: str) -> list:
    """下拉選單裡的週資料日（YYYYMMDD，新的在前）。官方只保存一年，約 51 個。"""
    return sorted(set(_SCADATE_RE.findall(page_html)), reverse=True)


def level_of(label: str):
    """「1,000-5,000」-> 2、「1,000,001以上」-> 15、「合 計」-> 17；其餘（差異數調整）-> None。

    認的是級距的下界而不是整串文字，這樣「1,000,001以上」寫成「1,000,001 以上」
    或換個破折號都還讀得出來。
    """
    text = label.replace("　", " ").strip()
    if "合" in text and "計" in text:
        return LEVEL_TOTAL
    head = re.split(r"[-–—~]|以上", text)[0].replace(",", "").strip()
    return FLOOR_TO_LEVEL.get(int(head)) if head.isdigit() else None


def parse_stock_page(page_html: str) -> dict:
    """個股查詢頁的結果表 -> {級距編號: (人數, 股數)}；沒有合計那一列就回空的。

    沒有合計就等於沒有分母，寧可整筆當作沒查到 —— 半份資料算出來的比例是錯的。
    """
    levels = {}
    for label, people, shares in _ROW_RE.findall(page_html):
        level = level_of(label)
        if level is None:
            continue
        share_count = twse.clean_number(shares)
        if share_count is None:
            continue
        levels[level] = (twse.clean_number(people), share_count)
    return levels if LEVEL_TOTAL in levels else {}


# --------------------------------------------------------------------------- #
# 檔案
# --------------------------------------------------------------------------- #
def is_truncated(payload: dict) -> bool:
    """這一份是不是「檔案被切斷」造成的不完整。

    早期的快照沒有 truncated 這個欄位，那時候唯一會產生不完整的來源就是網頁典藏館
    的 1 MB 上限，所以舊檔用 source 反推。
    """
    if "truncated" in payload:
        return bool(payload["truncated"])
    return bool(payload.get("partial")) and payload.get("source") == "wayback"


def snapshot_path(date_iso: str) -> Path:
    return WEEKLY_DIR / f"{date_iso}.json"


def stock_path(code: str) -> Path:
    return STOCK_DIR / f"{code}.json"


def snapshot_dates() -> list:
    if not WEEKLY_DIR.exists():
        return []
    return sorted(p.stem for p in WEEKLY_DIR.glob("*.json"))


def read_json(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path: Path, payload) -> Path:
    return twse.write_json(path, payload)


def write_if_changed(path: Path, payload) -> bool:
    """內容沒變就不重寫。每週重算一次全部個股序列，不這樣做就是一千多個空白差異。"""
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return True


def save_snapshot(date_iso: str, stocks: dict, *, source: str,
                  partial: bool = False, truncated: bool = False) -> tuple:
    """寫入快照，回傳 (是否真的寫了, 說明)。

    同一個資料日已經有現抓版本時，不讓典藏館的版本蓋掉它 —— 典藏是那一天的
    網頁快照，現抓的是官方當下的檔案，兩者理應相同，但真要選就選後者。
    被截斷的典藏也不准蓋掉完整的那一份，理由同上：少一半的不能取代齊全的。
    """
    path = snapshot_path(date_iso)
    payload = build_snapshot(date_iso, stocks, source=source,
                             partial=partial, truncated=truncated)
    if path.exists():
        old = read_json(path)
        if source == "wayback" and old.get("source") == "live":
            return False, "已有現抓版本，不用典藏版蓋掉"
        if partial and not old.get("partial") and len(old.get("stocks") or {}) >= len(stocks):
            return False, "已有較完整的版本，不用截斷版蓋掉"
        if old == payload:
            return False, "內容與已存的完全相同"
    write_json(path, payload)
    return True, f"{len(stocks)} 檔" + ("（檔案被截斷）" if partial else "")


def merge_snapshot(date_iso: str, stocks: dict, *, source: str) -> tuple:
    """把逐檔補來的資料併進那一週的快照，回傳 (新增檔數, 併完之後的總檔數)。

    已經有的代號一律不動：全市場那一份是官方的原始檔，逐檔頁只是拿來補洞的。
    併過的那一週在 source 上標成 mixed，讓人看得出它是兩種來源湊出來的。
    """
    path = snapshot_path(date_iso)
    if not path.exists():
        ok, _ = save_snapshot(date_iso, dict(sorted(stocks.items())),
                              source=source, partial=True)
        return (len(stocks) if ok else 0), len(stocks)

    old = read_json(path)
    merged = dict(old.get("stocks") or {})
    added = 0
    for code, row in stocks.items():
        if code not in merged:
            merged[code] = row
            added += 1
    if not added:
        return 0, len(merged)

    old_source = old.get("source") or source
    payload = build_snapshot(
        date_iso, dict(sorted(merged.items())),
        source=old_source if old_source == source else "mixed",
        # 補進來幾檔並不會讓一份截斷的檔案變完整，兩個旗標都照舊帶著走
        partial=bool(old.get("partial")),
        truncated=is_truncated(old),
    )
    write_json(path, payload)
    return added, len(merged)
