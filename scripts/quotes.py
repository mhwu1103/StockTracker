"""共用工具：抓取上游報價（TrendForce 免費頁）與原物料／指數（Yahoo Finance）。

這一支只管「抓下來、解析成統一格式」，序列與索引由 build_quotes.py 算。

## 兩種來源，兩種存法

TrendForce 的免費價格頁只顯示「現在」那一筆，看不到歷史（走勢圖在會員區），
所以歷史只能自己一天一天累積 —— 抓到的每一次都存成一份快照：

    docs/data/quotes/daily/YYYY-MM-DD.json     以「抓取日」為檔名的快照

Yahoo Finance 的 chart API 一次就給得出好幾年的日線，不必累積，每次重抓覆蓋即可：

    docs/data/quotes/market.json               原物料與指數的完整序列

## 報價的日期不是抓取的日期

同一頁上的表格更新頻率天差地遠：現貨每天動、合約半月或一個月才動一次、
鋰電池材料一個月一次。所以每張表都記自己的 Last Update（asof），
build_quotes.py 依 asof 去重 —— 不然一筆月更的合約價會被畫成 30 個一樣高的點。

## 抓不到的東西

被動元件（MLCC／晶片電阻）與功率元件（MOSFET／IGBT／SiC）沒有可自動抓的公開
成品報價，報價握在付費通路手上。這裡收的是它們的上游原料價（銅、銀、鈀、多晶矽），
kind 標成 "cost" 而不是 "price"，前端必須照這個欄位講清楚兩者的差別。
"""

from __future__ import annotations

import hashlib
import html as html_mod
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import requests

import twse

QUOTES_DIR = twse.DATA_DIR / "quotes"
SNAPSHOT_DIR = QUOTES_DIR / "daily"
SERIES_DIR = QUOTES_DIR / "series"
MARKET_PATH = QUOTES_DIR / "market.json"
QUOTES_INDEX_PATH = QUOTES_DIR / "index.json"

TF_BASE = "https://www.trendforce.com.tw"
YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) StockTracker/1.0",
    "Accept": "text/html,application/json,*/*",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
}

# --------------------------------------------------------------------------- #
# 品類
#
# cat 是前端的篩選與檔名單位（series/{cat}.json 一個檔）。
# kind：price 成品報價／cost 上游原料價／index 指數與匯率 —— 前端要據此標示。
# --------------------------------------------------------------------------- #
CATS = [
    {"key": "dram", "name": "記憶體 · DRAM", "kind": "price", "source": "TrendForce"},
    {"key": "flash", "name": "記憶體 · NAND", "kind": "price", "source": "TrendForce"},
    {"key": "lcd", "name": "面板", "kind": "price", "source": "TrendForce"},
    {"key": "pv", "name": "太陽能", "kind": "price", "source": "TrendForce"},
    {"key": "battery", "name": "鋰電池材料", "kind": "price", "source": "TrendForce"},
    {"key": "metal", "name": "金屬原料", "kind": "cost", "source": "Yahoo Finance"},
    {"key": "energy", "name": "能源", "kind": "cost", "source": "Yahoo Finance"},
    {"key": "index", "name": "指數 · 匯率", "kind": "index", "source": "Yahoo Finance"},
]
CAT_NAMES = {c["key"]: c["name"] for c in CATS}
CAT_KINDS = {c["key"]: c["kind"] for c in CATS}

# --------------------------------------------------------------------------- #
# TrendForce
#
# 一個品類抓一頁就夠：同品類所有分頁的表格都在同一份 HTML 裡（含未點開的那些）。
# 名單上沒有的分頁是刻意不收的：lpddr_spot、mobileDram_contract、wafer_contract、
# emmc_spot、emmc_contract 只列品項不給數字（會員才看得到），
# lcd/shipment 是出貨量不是報價。
#
# themes 對應 docs/data/themes.json 的 [大族群, 子族群]，前端用它把報價疊上
# 該族群的成交值。名字必須逐字對得上，改 themes.json 時要一起改
# （build_quotes.py 會檢查並在對不上時警告）。
# --------------------------------------------------------------------------- #
TF_CATS = [
    {
        "cat": "dram",
        "page": "/price/dram/dram_spot",
        "tabs": [
            {"tab": "dram_spot", "label": "DRAM 現貨價", "unit": "美元／顆", "freq": "每日",
             "themes": [["記憶體", "DRAM／NAND／利基型"]]},
            {"tab": "dram_contract", "label": "DRAM 合約價", "unit": "美元／條", "freq": "每月",
             "themes": [["記憶體", "DRAM／NAND／利基型"]]},
            {"tab": "module_spot", "label": "模組現貨價", "unit": "美元／條", "freq": "每週",
             "themes": [["記憶體", "控制 IC 與模組"]]},
            {"tab": "gddr_spot", "label": "GDDR 現貨價", "unit": "美元／顆", "freq": "每週",
             "themes": [["記憶體", "DRAM／NAND／利基型"]]},
        ],
    },
    {
        "cat": "flash",
        "page": "/price/flash/flash_spot",
        "tabs": [
            {"tab": "flash_spot", "label": "NAND 現貨價", "unit": "美元／顆", "freq": "每週",
             "themes": [["記憶體", "DRAM／NAND／利基型"]]},
            {"tab": "flash_contract", "label": "NAND 合約價（記憶卡／UFD）", "unit": "美元／片",
             "freq": "每月", "themes": [["記憶體", "DRAM／NAND／利基型"]]},
            {"tab": "wafer_spot", "label": "NAND Wafer 現貨價", "unit": "美元／片", "freq": "每週",
             "themes": [["記憶體", "DRAM／NAND／利基型"]]},
            {"tab": "memCard_spot", "label": "記憶卡現貨價", "unit": "美元／張", "freq": "每週",
             "themes": [["記憶體", "控制 IC 與模組"]]},
            {"tab": "pcc_oem_ssd_contract", "label": "PC OEM SSD 合約價", "unit": "美元／台",
             "freq": "每季", "themes": [["記憶體", "控制 IC 與模組"]]},
            {"tab": "ssd_street", "label": "SSD 通路價", "unit": "美元／台", "freq": "每週",
             "themes": [["記憶體", "控制 IC 與模組"]]},
        ],
    },
    {
        "cat": "lcd",
        "page": "/price/lcd/panel",
        "tabs": [
            {"tab": "panel", "label": "大尺寸面板價", "unit": "美元／片", "freq": "每月",
             "themes": [["光學 · 面板", "面板／背光／電子紙"]]},
            {"tab": "smartphone", "label": "手機面板價", "unit": "美元／片", "freq": "每月",
             "themes": [["光學 · 面板", "面板／背光／電子紙"]]},
            {"tab": "street", "label": "終端售價", "unit": "美元／台", "freq": "每月",
             "themes": [["光學 · 面板", "面板／背光／電子紙"]]},
        ],
    },
    {
        "cat": "pv",
        "page": "/price/pv",
        "tabs": [
            {"tab": "polysilicon", "label": "多晶矽", "unit": "每公斤", "freq": "每週",
             "themes": [["重電 · 電網 · 綠能", "離岸風電／太陽能"],
                        ["功率元件 · 第三代半導體", "SiC／矽晶圓基板"]]},
            {"tab": "wafer", "label": "矽晶圓", "unit": "每片", "freq": "每週",
             "themes": [["重電 · 電網 · 綠能", "離岸風電／太陽能"],
                        ["晶圓代工 · 封測", "矽晶圓／再生晶圓"]]},
            {"tab": "cell", "label": "電池片", "unit": "每瓦", "freq": "每週",
             "themes": [["重電 · 電網 · 綠能", "離岸風電／太陽能"]]},
            {"tab": "module", "label": "模組", "unit": "每瓦", "freq": "每週",
             "themes": [["重電 · 電網 · 綠能", "離岸風電／太陽能"]]},
            {"tab": "pv_glass", "label": "光伏玻璃", "unit": "每平方公尺", "freq": "每週",
             "themes": [["重電 · 電網 · 綠能", "離岸風電／太陽能"]]},
        ],
    },
    {
        "cat": "battery",
        "page": "/price/battery-price/battery_cell_and_pack",
        "tabs": [
            {"tab": "battery_cell_and_pack", "label": "電池芯及電池包", "unit": "", "freq": "每月",
             "themes": [["重電 · 電網 · 綠能", "電池／儲能"]]},
            {"tab": "precursor_and_cathode_material", "label": "前驅體及正極材料", "unit": "",
             "freq": "每月", "themes": [["重電 · 電網 · 綠能", "電池／儲能"]]},
            {"tab": "anode_material", "label": "負極材料", "unit": "", "freq": "每月",
             "themes": [["重電 · 電網 · 綠能", "電池／儲能"]]},
            {"tab": "separator", "label": "隔離膜", "unit": "", "freq": "每月",
             "themes": [["重電 · 電網 · 綠能", "電池／儲能"]]},
            {"tab": "electrolyte", "label": "電解液", "unit": "", "freq": "每月",
             "themes": [["重電 · 電網 · 綠能", "電池／儲能"]]},
            # 硫酸鎳與電解鈷同時是 MLCC 內電極與端電極的金屬，所以也掛到被動元件
            {"tab": "li_co_ni", "label": "鋰、鈷、鎳", "unit": "", "freq": "每月",
             "themes": [["重電 · 電網 · 綠能", "電池／儲能"],
                        ["被動元件", "電容／電阻"]]},
            {"tab": "other", "label": "其他材料", "unit": "", "freq": "每月",
             "themes": [["重電 · 電網 · 綠能", "電池／儲能"]]},
        ],
    },
]

TF_TAB_SPECS = {
    (c["cat"], t["tab"]): dict(t, cat=c["cat"], page=c["page"])
    for c in TF_CATS for t in c["tabs"]
}

TF_PAGE_URLS = {c["cat"]: TF_BASE + c["page"] for c in TF_CATS}

# --------------------------------------------------------------------------- #
# Yahoo Finance
#
# 這一組是「上游成本」與「大環境」，不是任何一族的成品報價 —— 被動元件與功率元件
# 沒有公開報價，能誠實給的就只有它們的原料價，why 就是拿來講這件事的。
# --------------------------------------------------------------------------- #
YAHOO_ITEMS = [
    {"id": "cu", "cat": "metal", "sym": "HG=F", "name": "銅（COMEX）", "unit": "美元／磅",
     "themes": [["CCL · 上游材料", "玻纖布／銅箔／樹脂"], ["重電 · 電網 · 綠能", "電線電纜"]],
     "why": "銅箔、銅箔基板與電線電纜的主要原料"},
    {"id": "au", "cat": "metal", "sym": "GC=F", "name": "黃金", "unit": "美元／盎司",
     "themes": [["晶圓代工 · 封測", "封裝測試"], ["PCB · 載板", "IC 載板（ABF／BT）"]],
     "why": "打線封裝的金線與載板鍍金的原料"},
    {"id": "ag", "cat": "metal", "sym": "SI=F", "name": "白銀", "unit": "美元／盎司",
     "themes": [["被動元件", "電容／電阻"], ["重電 · 電網 · 綠能", "離岸風電／太陽能"]],
     "why": "MLCC 端電極與太陽能導電銀漿的原料"},
    {"id": "pd", "cat": "metal", "sym": "PA=F", "name": "鈀", "unit": "美元／盎司",
     "themes": [["被動元件", "電容／電阻"]],
     "why": "MLCC 內電極的貴金屬，改用鎳電極之後仍是高階品的成本項"},
    {"id": "al", "cat": "metal", "sym": "ALI=F", "name": "鋁", "unit": "美元／噸",
     "themes": [["AI 伺服器", "散熱（氣冷／液冷）"], ["AI 伺服器", "機殼／機構件／滑軌"]],
     "why": "散熱模組與機構件的原料"},
    {"id": "brent", "cat": "energy", "sym": "BZ=F", "name": "布蘭特原油", "unit": "美元／桶",
     "themes": [["傳產", "塑化"]],
     "why": "塑化的上游原料成本"},
    {"id": "sox", "cat": "index", "sym": "^SOX", "name": "費城半導體指數", "unit": "點",
     "themes": [["晶圓代工 · 封測", "晶圓代工"]],
     "why": "半導體的國際大環境，台股半導體族群多半跟著它走"},
    {"id": "usdtwd", "cat": "index", "sym": "TWD=X", "name": "美元／新台幣", "unit": "元",
     "themes": [],
     "why": "報價多以美元計，匯率決定同一個報價換回台幣是多少"},
]

YAHOO_BY_ID = {y["id"]: y for y in YAHOO_ITEMS}

# --------------------------------------------------------------------------- #
# HTML 解析
#
# 沒有 bs4，用正規表示式硬解。TrendForce 的價格表是後端算好直接吐 HTML 的，
# 結構規律：一個 <div id="{tab}" class="price-content"> 配一張 table.price-table。
#
# 兩個一定要處理的細節：
#   1. 同一列同時排了 desktop-only 與 mobile-only 兩套欄位，手機版那份把前兩欄
#      併成一格。不丟掉的話欄位就對不齊 —— 一律只留桌機版。
#   2. 漲跌欄的 CSS class 不可信（▲ 配 fall-trend 的情況確實存在），
#      方向要看數字自己的正負號，沒帶正負號才看箭頭。
# --------------------------------------------------------------------------- #
_CELL_RE = re.compile(r"<(t[dh])\b([^>]*)>(.*?)</\1\s*>", re.S | re.I)
_TR_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S | re.I)
_CUR_RE = re.compile(r"(?:[（(](USD|RMB|USX|TWD|EUR|JPY)[）)]\s*)+$")
_ASOF_RE = re.compile(r"Last Update[^0-9]*(\d{4}-\d{2}-\d{2})")
_BLOCK_RE = re.compile(r'<div id="([A-Za-z_]+)" class="price-content"')
# 註解掉的表格列要整段丟掉。不先拿掉的話 <!-- … > 只會被當成一個標籤剝掉，
# 殘餘的 --> 會黏在品項名後面，變成一條「同一個報價、名字多兩個字」的假序列。
_HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.S)

# 標題裡出現這些字就是數值欄，不是品項名稱欄
VALUE_HEADS = ("高點", "低點", "均價", "平均", "漲跌", "Avg", "Last", "走勢圖")


def _text(raw: str) -> str:
    """去標籤、還原實體、壓掉多餘空白。▲▼ 這種箭頭會留下來，漲跌方向要靠它。"""
    text = html_mod.unescape(re.sub(r"<[^>]+>", " ", raw))
    return re.sub(r"\s+", " ", text).replace("　", " ").strip()


def _cells(tr_html: str) -> list:
    """一列 -> [(tag, text)]。丟掉手機專用欄，依 colspan 展開對齊標題。"""
    out = []
    for m in _CELL_RE.finditer(tr_html):
        tag, attrs, inner = m.group(1).lower(), m.group(2), m.group(3)
        if "mobile-only" in attrs:
            continue
        span = re.search(r'colspan\s*=\s*"?(\d+)', attrs)
        out.extend([(tag, _text(inner))] * (int(span.group(1)) if span else 1))
    return out


def _pick(header, *keys, exclude=()):
    """第一個標題含 keys 之一（且不含 exclude）的欄位序號；找不到回 None。"""
    for i, head in enumerate(header):
        if any(k in head for k in keys) and not any(x in head for x in exclude):
            return i
    return None


def _signed_pct(text: str):
    """'▲ 0.31 %' -> 0.31；'▼ -0.80 %' -> -0.8；'— 0.00 %' -> 0.0；沒數字回 None。"""
    if "%" not in text:
        return None
    m = re.search(r"([+-]?\d+(?:\.\d+)?)\s*%", text.replace(",", ""))
    if not m:
        return None
    value = float(m.group(1))
    # 數字自己帶正負號就聽它的，沒帶才看箭頭（▲ 漲、▼ 跌、— 平）
    if not m.group(1).startswith(("+", "-")) and "▼" in text:
        value = -value
    return 0.0 if value == 0 else value    # '-0.00 %' 別留成 -0.0


def parse_price_page(page_html: str) -> dict:
    """一份 TrendForce 價格頁 -> {tab: {"title", "asof", "rows": [...]}}。

    只有數字真的解得出來的分頁才會出現在結果裡：會員專屬的那幾個分頁 HTML 上
    只有品項名沒有數字，解出來 rows 是空的，直接不收。
    """
    out = {}
    page_html = _HTML_COMMENT_RE.sub("", page_html)
    marks = list(_BLOCK_RE.finditer(page_html))
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(page_html)
        block = page_html[m.start():end]
        body = block.split("</table>")[0]
        rows = _parse_table(body)
        if not rows:
            continue
        title_m = re.search(r'class="price-title">\s*([^<]*)', block)
        asof_m = _ASOF_RE.search(block)
        out[m.group(1)] = {
            "title": html_mod.unescape(title_m.group(1)).strip() if title_m else m.group(1),
            "asof": asof_m.group(1) if asof_m else None,
            "rows": rows,
        }
    return out


def _parse_table(body: str) -> list:
    header = None
    rows = []
    for tr in _TR_RE.findall(body):
        cells = _cells(tr)
        if not cells:
            continue
        if cells[0][0] == "th":
            if header is None:
                header = [c[1] for c in cells]
            continue
        if header is None:
            continue
        row = _parse_row(header, cells, tr)
        if row:
            rows.append(row)
    return rows


def _parse_row(header, cells, tr_html: str):
    # 品項名稱欄一定在最前面連著；中間斷掉之後的非數值欄不是名字（例如走勢圖）
    keep = []
    for i, head in enumerate(header):
        if any(k in head for k in VALUE_HEADS):
            break
        keep.append(i)
    if not keep:
        keep = [0]

    avg = _pick(header, "均價", "盤平均", "平均", exclude=("Last", "漲跌"))
    if avg is None:
        return None
    high = _pick(header, "盤高點")
    high = high if high is not None else _pick(header, "高點")
    low = _pick(header, "盤低點")
    low = low if low is not None else _pick(header, "低點")

    def cell(i):
        return cells[i][1] if i is not None and i < len(cells) else ""

    value = twse.clean_number(cell(avg))
    if value is None:
        return None

    # 漲跌可能有兩欄：面板那幾張表是「差價」與「百分比」各一欄（環比與同比還各一組），
    # 要的是第一個真的帶 % 的那欄，挑到差價欄會整欄變成 None。
    change = None
    for i, head in enumerate(header):
        if "漲跌" not in head:
            continue
        change = _signed_pct(cell(i))
        if change is not None:
            break

    name = " ".join(x for x in (cell(i) for i in keep) if x)
    cur = "USD"
    cur_m = _CUR_RE.search(name)
    if cur_m:
        cur = cur_m.group(1)
        name = _CUR_RE.sub("", name).strip()
    if not name:
        return None

    # 每一列的走勢圖連結帶一個穩定的 type 編號，拿它當品項 ID 最不怕改名；
    # 沒有連結的表只能用名字的雜湊，那種表改名就會斷成新的一條序列。
    type_m = re.search(r"type=(\d+)", tr_html)
    key = type_m.group(1) if type_m else "h" + hashlib.md5(name.encode("utf-8")).hexdigest()[:8]

    return {
        "key": key,
        "name": name,
        "value": value,
        "change": change,
        "high": twse.clean_number(cell(high)),
        "low": twse.clean_number(cell(low)),
        "cur": cur,
    }


# --------------------------------------------------------------------------- #
# 抓取
# --------------------------------------------------------------------------- #
def fetch_text(url, *, retries=3, timeout=30, backoff=3.0) -> str:
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=timeout)
            resp.raise_for_status()
            if not resp.encoding or resp.encoding.lower() == "iso-8859-1":
                resp.encoding = resp.apparent_encoding or "utf-8"
            return resp.text
        except Exception as err:
            last_err = err
            if attempt < retries:
                wait = backoff * attempt
                print(f"  ! {type(err).__name__}: {err} —— {wait:.0f} 秒後重試 ({attempt}/{retries})")
                time.sleep(wait)
    raise RuntimeError(f"抓取失敗 {url}：{last_err}")


def fetch_tf_cat(cat_spec: dict, *, url=None) -> dict:
    """抓一個 TrendForce 品類，回傳 {(cat, tab): {"title","asof","rows"}}。

    名單外的分頁一律丟掉：那一頁上還有別的品類的表格，不篩就會混進來。
    """
    parsed = parse_price_page(fetch_text(url or (TF_BASE + cat_spec["page"])))
    out = {}
    for tab_spec in cat_spec["tabs"]:
        table = parsed.get(tab_spec["tab"])
        if table:
            out[(cat_spec["cat"], tab_spec["tab"])] = table
    return out


def series_id(cat: str, tab: str, key: str) -> str:
    return f"{cat}:{tab}:{key}"


def fetch_yahoo(sym: str, *, rng="5y") -> list:
    """回傳 [(date_iso, close)]，只留有收盤價的日子。"""
    payload = json.loads(fetch_text(f"{YAHOO_CHART}{quote(sym)}?range={rng}&interval=1d"))
    result = (payload.get("chart") or {}).get("result") or []
    if not result:
        raise RuntimeError(f"Yahoo 沒有回傳 {sym} 的資料")
    node = result[0]
    stamps = node.get("timestamp") or []
    quotes = (node.get("indicators") or {}).get("quote") or [{}]
    closes = quotes[0].get("close") or []
    offset = node.get("meta", {}).get("gmtoffset") or 0
    out = []
    for stamp, close in zip(stamps, closes):
        if close is None:
            continue
        # 用該市場自己的當地日期，才不會把美股的收盤算到隔天去
        day = datetime.fromtimestamp(stamp + offset, timezone.utc).date().isoformat()
        out.append((day, round(float(close), 4)))
    return out


# --------------------------------------------------------------------------- #
# 讀寫
# --------------------------------------------------------------------------- #
def write_json(path: Path, payload) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return path


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def snapshot_path(date_iso: str) -> Path:
    return SNAPSHOT_DIR / f"{date_iso}.json"


def series_path(cat: str) -> Path:
    return SERIES_DIR / f"{cat}.json"


def snapshot_dates() -> list:
    if not SNAPSHOT_DIR.exists():
        return []
    return sorted(p.stem for p in SNAPSHOT_DIR.glob("*.json"))


def build_snapshot(tables: dict, *, source: str) -> dict:
    """把 fetch_tf_cat 的結果組成一份快照。"""
    payload = {
        "fetched": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "source": source,
        "tables": {},
        "items": {},
    }
    for (cat, tab), table in sorted(tables.items()):
        spec = TF_TAB_SPECS.get((cat, tab))
        if not spec:
            continue
        payload["tables"][f"{cat}:{tab}"] = {
            "title": table["title"],
            "asof": table["asof"],
            "label": spec["label"],
        }
        for row in table["rows"]:
            payload["items"][series_id(cat, tab, row["key"])] = {
                "t": f"{cat}:{tab}",
                "n": row["name"],
                "v": row["value"],
                "c": row["change"],
                "lo": row["low"],
                "hi": row["high"],
                "cur": row["cur"],
            }
    return payload
