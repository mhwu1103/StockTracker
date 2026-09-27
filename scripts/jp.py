"""共用邏輯：日股日線與「日股 × 台股」的族群對照。

## 這一支在回答什麼

`docs/data/jp_link.json` 是人工標的對照表：供應鏈上哪一檔日股對得上台股的哪一族。
這裡把兩邊的**漲跌幅並排**，回答「日本這一段在動，台股這一族跟上了沒」。

## 為什麼不算相關係數

美股那一頁算，這一頁不算，差別在時間：

    美股   台灣時間清晨收盤，在台股開盤之前 -> D 日對 D+1 日，因果方向只有一個
    日股   東京 9:00–15:30 JST ＝ 台北 8:00–14:30，比台股早開一小時、晚收一小時

日股與台股是**同一天、同一盤**，`us.py` 那套 D → D+1 的對齊套過來是錯的。
而同日的相關係數分不出「日股領先一小時」「台股領先」「兩邊都在反映昨夜美股」，
真正可用的領先只有台北 8:00–9:00 那一小時，**日線資料量不到**。

2026-09 實測過（122 個交易日）：同日原始相關普遍 +26~+70%，但兩邊各自扣掉
自己的大盤之後多數掉到 +5% 以內 —— 那些數字大半是「亞股一起動」，不是這一對
綁在一起。`^N225` 對 2330 的同日相關 +70%，比任何一組個股配對都高，就是證據。

所以這一頁只擺漲跌幅：一個看得懂、不會被誤讀成訊號的數字。

## 台股的價格從哪來

不另外跟 Yahoo 要。repo 的 `kline/` 已經有全市場的四價，重抓一次只是把每天
最吃請求數的那一步再放大一倍（美股那支 177 檔實測就要 148 秒）。

代價是期間最長只到「季」：`kline/` 從 2026-03-16 起，湊不出一年。這是資料的
限制不是參數，前端要講清楚。

## 配對的單位是子族群，不是族群

`jp_link.json` 標的是「哪幾檔日股對得上哪一族」，但一族裡的日股與台股其實分屬
不同的環節：半導體設備那一族，愛德萬對的是鴻勁與穎崴（測試座），東京威力科創
對的是弘塑與辛耘（製程設備）——把十檔日股堆成一排、台股再堆成一排，頁面上就
讀不出誰對誰。

所以配對的單位取**子族群**：`jp_link.json` 與 `themes.json` 的子族群名稱是對齊的
（那份對照表的 `_note` 就是這樣要求的），一邊給日股、一邊給台股，接起來就是一個
「這幾檔日股 → 這幾檔台股」的區塊。差距也是在區塊裡算：台股減的是**同一個子族**
的日股中位數，不是整族的。

只標在族群層、沒有落進任何子族的日股（記憶體那一族的愛德萬、AI 伺服器那一族的
日立），意思是「對到整族」，收在最後一個區塊裡，不能直接丟掉。

## 每一族挑哪幾檔台股

一族動輒五、六十檔，全列等於沒列。依**最近一個交易日的成交值**取前幾名 ——
那正是這個站在做的事，也是「這一族現在誰在動」最直接的答案。

但這個排序有個**看不見的破口**：成交值來自 `daily/all/<日期>.json`，那份榜只有
300 檔。名單外的一律算 0，同分時 `sorted` 是穩定排序，順序就退回 `themes.json`
的排列順序——不是成交值。2026-09-18 有 18 個子族群的名額是這樣填的，其中
「軍工／航太製造」「傳產／汽車零件」整組四檔全是 0，等於完全沒排序。

repo 裡沒有全市場成交值可以補這個洞：`kline/` 與 `close/` 只有四價沒有量，
`history/all/<年>.json` 也只記「進榜那幾天」的名次與成交值。所以 TW_TOP 取得寬
（理由寫在那個常數旁邊），讓排序失效時該列的還是列得出來。

只放邏輯，不負責 I/O 與排程 —— 那是 fetch_jp.py 與 build_jp.py 的事。
"""

from __future__ import annotations

import json
from pathlib import Path

import twse
# 台股的 K 線讀取與市場判斷在 us.py 裡已經寫好且每天在跑。模組名字是 `us`，
# 但那兩支函式與美股無關，複製一份到這裡只會多一個會走樣的副本。
import us

JP_DIR = twse.DATA_DIR / "jp"
MARKET_PATH = JP_DIR / "market.json"
INDEX_PATH = JP_DIR / "index.json"
LINK_PATH = twse.DATA_DIR / "jp_link.json"

# 日股大盤。不是給人看的標的，是族群漲跌要對照的基準。
JP_INDEX = "^N225"
TW_INDEX = "^TWII"

# 收盤價的單位與小數位數。日股是日圓、台股是台幣，兩邊不能互相比較，畫面上一定要
# 帶單位；指數與匯率則是點數與匯率，帶上「円」會是錯的。沒列到的一律當日股。
#
# 小數位數也得由資料決定，不能讓前端猜：日圓報價是 157.19，四捨五入成整數就
# 看不出當天的變化；日股的股價動輒五位數，給兩位小數只是雜訊。
CURRENCY = {JP_INDEX: "", TW_INDEX: "", "JPY=X": ""}
DECIMALS = {JP_INDEX: 0, TW_INDEX: 0, "JPY=X": 2}
JP_DECIMALS = 0
TW_DECIMALS = 2

# 漲跌幅要看的幾段（交易日）。沒有「年」：台股的 kline 只有半年多。
SPANS = ((1, "昨日"), (5, "週"), (21, "月"), (63, "季"))

# 每個「子族群」區塊最多列幾檔台股。這是子族層級不是族群層級的數字。
#
# 本來是 4，理由是「四檔乘上一族三、四個子族還是十幾檔，再多就把區塊撐得比一個
# 畫面高」。那個理由沒錯，錯的是它預設「排序會把最該看的四檔挑出來」——上面
# docstring 講的破口讓這個前提在中小型股的子族群裡不成立：4 個名額有一半是靠
# themes.json 的排列順序填的，而不是成交值。
#
# 改成 10：多數子族群的成員數本來就在 10 以內，排序失效也不再有代價，該列的都列了。
# 成員超過 10 的那幾個大族（AI 伺服器的機殼、半導體設備的製程設備）仍然靠排序砍，
# 但那幾族的成員多半進得了 300 檔榜，成交值是真的有值，排序在那裡才是有效的。
#
# 代價有兩個，都是有意識吞下的：區塊變長（台股 182 檔 -> 306 檔），而且列進冷門股
# 會把區塊的台股中位數——也就是差距欄的基準——往下拉。寧可基準寬一點，也不要頁面上
# 少掉本來就該在這一族裡的公司。
TW_TOP = 10

# 沒有落進任何子族的那一塊叫什麼。不是一個子族群的名字，是「對到整族」的意思。
REST_NAME = "對到整族"


def load_link() -> dict:
    return json.loads(LINK_PATH.read_text(encoding="utf-8"))


def load_themes() -> dict:
    return json.loads((twse.DATA_DIR / "themes.json").read_text(encoding="utf-8"))


def jp_tickers(link: dict) -> dict:
    """對照表裡出現過的所有日股：代號 -> 中文名。含 benchmarks。

    同一檔會出現在好幾族（信越化學橫跨四族），名字以第一次出現的為準。
    """
    out = {}
    for row in link.get("benchmarks") or []:
        out.setdefault(row["t"], row["n"])
    for group in link["groups"]:
        for row in group.get("jp") or []:
            out.setdefault(row["t"], row["n"])
        for sub in group.get("subs") or []:
            for row in sub.get("jp") or []:
                out.setdefault(row["t"], row["n"])
    return out


def theme_codes(themes: dict) -> dict:
    """族群名 -> 該族所有成分股代號（攤平子族群，去重但保留順序）。"""
    out = {}
    for group in themes["groups"]:
        seen = []
        for sub in group["subs"]:
            for code in sub["codes"]:
                if code not in seen:
                    seen.append(code)
        out[group["name"]] = seen
    return out


def theme_sub_codes(themes: dict) -> dict:
    """族群名 -> {子族群名: 成分股代號}。子族群是日股對照的配對單位。

    與 theme_codes 的差別只在攤不攤平。兩個都要：區塊裡的台股按子族取，
    而「沒被任何子族用掉的」要拿整族的清單來扣。
    """
    return {group["name"]: {sub["name"]: list(sub["codes"]) for sub in group["subs"]}
            for group in themes["groups"]}


def latest_values(path: Path) -> dict:
    """最近一個交易日的 {代號: 成交值}。用來決定每一族列哪幾檔。"""
    payload = json.loads(path.read_text(encoding="utf-8"))
    return {row["code"]: row.get("value") or 0 for row in payload.get("stocks") or []}


def pick_tw(codes: list, values: dict, top: int = TW_TOP) -> list:
    """從一族的成分股裡挑成交值最大的幾檔。

    沒進過前 200 大的沒有成交值，排在有值的後面 —— 它們多半也沒有 kline，
    build 階段會自己掉出去。
    """
    ranked = sorted(codes, key=lambda c: -(values.get(c) or 0))
    return ranked[:top]


def pct(new, old):
    return None if not old else round((new / old - 1) * 100, 2)


def changes(series: list) -> list:
    """由收盤序列算各段漲跌幅，對齊 SPANS。不夠長的那一段留 None。

    傳進來的序列要先濾掉 None：缺的日子不能佔掉一格，否則「五個交易日前」
    會被算成更早的某一天。
    """
    vals = [c for c in series if c is not None]
    if len(vals) < 2:
        return [None] * len(SPANS)
    return [pct(vals[-1], vals[-1 - span]) if len(vals) > span else None
            for span, _ in SPANS]


def tw_series(code: str, dates: list) -> list:
    """台股個股對齊在給定日期軸上的收盤價，缺的日子是 None。"""
    closes = us.tw_closes(code)
    return [closes.get(d) for d in dates] if closes else []
