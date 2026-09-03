"""共用工具：抓上市與上櫃的三大法人買賣超，換算成金額。

## 兩支端點，同一種形狀

                       上市                              上櫃
    端點               rwd/zh/fund/T86                   www/zh-tw/insti/dailyTrade
    範圍               全部（不含權證、牛熊證）          股票 + ETF + ETN
    可查日期           任一交易日                        任一交易日

兩支都能指定日期，所以這一支不像成交值排行那樣分「當日」與「歷史回補」兩條路
—— 抓今天與補上週走的是同一段程式，`fetch_institutions.py` 只是換個日期參數。

## 官方只給股數，金額是估算出來的

市場上講「外資買超幾億」，指的是金額；但這兩支端點**從頭到尾只有股數**，
沒有任何一欄是金額（證交所的金額只出到 BFI82U 那張全市場彙總表，沒有分到個股）。
所以這裡的金額一律是

    買賣超金額（估）＝ 買賣超股數 × 當日收盤價

真正的成交均價不等於收盤價，當天振幅越大誤差越大。拿全市場合計去對官方那張
彙總表（下面的 `total`），2026-09-03 那天上市外資差 7.7%、上櫃外資差 12.5% ——
量級與方向是對的，但**這不是精確值**，靠門檻邊緣的個股會因為這幾個百分點進出榜。
畫面上一定要標明是估算，別讓它看起來像官方數字。

全市場的「合計」則有官方的精確數字（證交所 BFI82U、櫃買 insti/summary 兩張
三大法人買賣金額彙總表），所以每一天的檔案裡兩種都存：`total` 是官方合計，
`est` 是同一天把個股估算值加總起來的結果。兩者並存才講得出「這份估算差多少」，
也才不會讓畫面上那個最顯眼的數字是估算出來的。

收盤價不重抓：`docs/data/close/{twse,tpex}/` 已經存了全市場的四價，直接讀那份，
只有那一天的檔案還沒生出來（本機手動跑、或排程順序被打亂）才現抓一次。

## 「外資」是外陸資加上外資自營商

T86 把外資拆成「外陸資（不含外資自營商）」與「外資自營商」兩段，櫃買那邊也有
同樣的拆法並多給一欄合計。市場口中的外資買超指的是合計，所以這裡存的是兩段相加。

## 只留金額有意義的那些

全市場一天有兩千多檔沾到法人的買賣，但其中一大半是幾百股、幾萬元的零頭
（法人的零股交易、ETF 的實物申贖尾數）。三邊的估算金額都不到 `MIN_OKU`（500 萬元）
的就不存 —— 一天的檔案從 90 KB 掉到 43 KB，而被丟掉的那些在任何法人分析上都不是
訊號。門檻本身寫進檔案的 `cut` 欄位，讀的人才知道這份資料的邊界在哪。

`est` 是在**套門檻之前**加總的，所以它是整個市場的估算合計，不是榜上那幾檔的和
—— 這樣它才能拿去跟官方的 `total` 對照。
"""

from __future__ import annotations

import json
from collections import namedtuple
from datetime import date
from pathlib import Path

import twse

INSTI_DIR = twse.DATA_DIR / "insti"
INSTI_DAILY_DIR = INSTI_DIR / "daily"
INSTI_INDEX_PATH = INSTI_DIR / "index.json"

# 上市：三大法人買賣超日報。selectType=ALLBUT0999 是「全部（不含權證、牛熊證）」
T86_URL = "https://www.twse.com.tw/rwd/zh/fund/T86"
# 上櫃：三大法人買賣超彙總表。sect=EW 涵蓋股票、ETF 與 ETN
TPEX_INSTI_URL = "https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade"

# 全市場合計的官方金額（元）。個股只有股數，唯一有金額的就是這兩張彙總表。
BFI82U_URL = "https://www.twse.com.tw/rwd/zh/fund/BFI82U"
TPEX_SUMMARY_URL = "https://www.tpex.org.tw/www/zh-tw/insti/summary"

# 檔案格式版號。欄位一改就加一 —— 舊格式混進來只會算出安靜的錯誤答案。
SNAPSHOT_VERSION = 1

# 每一檔存的五個值，順序即 index。前端的 I_NAME/I_FOREIGN/… 必須與這裡一致。
#   name   簡稱
#   fo     外資買賣超股數（外陸資 + 外資自營商）
#   tr     投信買賣超股數
#   de     自營商買賣超股數（自行買賣 + 避險）
#   close  當日收盤價，金額由前端乘出來
FIELDS = ("name", "fo", "tr", "de", "close")

# 三邊的估算金額都不到這個數（億元）就不存。理由見模組說明。
MIN_OKU = 0.05

MARKETS = ("twse", "tpex")

# 一檔的買賣超股數。三個數字都是「淨」的，正買超、負賣超。
Net = namedtuple("Net", "code name foreign trust dealer")


# --------------------------------------------------------------------------- #
# 上市：T86
# --------------------------------------------------------------------------- #
# T86 的欄位位置。這張表歷年來沒動過，但位置讀錯不會報錯、只會把投信的數字寫到
# 自營商欄上，所以抓回來要先拿欄名對一次。
TWSE_COLS = {
    "foreign": (4, ("外", "買賣超")),          # 外陸資買賣超股數（不含外資自營商）
    "foreign_dealer": (7, ("外資自營商", "買賣超")),
    "trust": (10, ("投信", "買賣超")),
    "dealer": (11, ("自營商", "買賣超")),
    "total": (18, ("三大法人", "買賣超")),
}


def _check_twse_fields(fields: list) -> None:
    """欄名對不上就停下來。位置讀錯算出來的東西是安靜的錯，比抓不到還糟。"""
    if not fields or len(fields) <= max(i for i, _ in TWSE_COLS.values()):
        raise RuntimeError(f"T86 只回了 {len(fields or [])} 個欄位，來源格式可能改了")
    for name, (index, keywords) in TWSE_COLS.items():
        label = str(fields[index])
        if not all(word in label for word in keywords):
            raise RuntimeError(f"T86 第 {index} 欄是「{label}」，不像是{name}那一欄，來源格式可能改了")


def fetch_twse(day: date) -> list:
    """上市某一日的三大法人買賣超。非交易日回空 list。"""
    payload = twse.fetch_json(T86_URL, {
        "date": day.strftime("%Y%m%d"),
        "selectType": "ALLBUT0999",
        "response": "json",
    })
    # 非交易日的 stat 是「很抱歉，沒有符合條件的資料!」，不是錯誤
    rows = payload.get("data") or []
    if not rows:
        return []
    if payload.get("stat") != "OK":
        raise RuntimeError(f"T86 回應 stat={payload.get('stat')}")
    # 帶了日期卻回別天的資料，寧可整筆不要 —— 存錯日期的檔案沒有人看得出來
    got = str(payload.get("date") or "")
    if got and got != day.strftime("%Y%m%d"):
        raise RuntimeError(f"T86 要的是 {day}，回來的卻是 {got}")

    _check_twse_fields(payload.get("fields") or [])
    col = {name: index for name, (index, _) in TWSE_COLS.items()}
    width = max(col.values()) + 1
    out = []
    for row in rows:
        if len(row) < width:
            raise RuntimeError(f"T86 有一列只有 {len(row)} 欄（要 {width}），來源格式可能改了")
        code = twse.strip_tags(row[0])
        if not twse.is_tracked_code(code):
            continue
        nums = {name: twse.clean_number(row[index]) or 0.0 for name, index in col.items()}
        foreign = nums["foreign"] + nums["foreign_dealer"]
        got_total = nums["total"]
        want_total = foreign + nums["trust"] + nums["dealer"]
        # 四段加起來就是官方那一欄的合計。對不上代表欄位位置錯了或多了一種法人。
        if abs(got_total - want_total) > 1:
            raise RuntimeError(
                f"T86 {code} 的四段加總 {want_total:,.0f} 與合計欄 {got_total:,.0f} 對不起來，"
                "來源格式可能改了")
        out.append(Net(code, twse.strip_tags(row[1]), foreign, nums["trust"], nums["dealer"]))
    return out


# --------------------------------------------------------------------------- #
# 上櫃：三大法人買賣超彙總表
# --------------------------------------------------------------------------- #
# 櫃買那張表的 24 欄裡，除了前兩欄以外全叫「買進股數／賣出股數／買賣超股數」，
# 欄名認不出誰是誰 —— 分組的順序是唯一的線索：
#
#   2~4    外資及陸資（不含外資自營商）        11~13  投信
#   5~7    外資自營商                          14~16  自營商（自行買賣）
#   8~10   外資及陸資合計                      17~19  自營商（避險）
#                                               20~22  自營商合計
#                                               23     三大法人買賣超合計
#
# 所以這一邊改用「數字之間的關係」來驗：每一組的買 − 賣要等於買賣超，合計組要等於
# 兩個子組相加，最後一欄要等於三邊相加。順序真的被改動時這些等式會一起垮掉。
TPEX_COLS = {"foreign": 10, "trust": 13, "dealer": 22, "total": 23}
TPEX_WIDTH = 24
# (合計欄, 子項欄...)：合計必須等於子項相加
TPEX_SUMS = (
    (10, 4, 7),          # 外資合計 = 外陸資 + 外資自營商
    (22, 16, 19),        # 自營商合計 = 自行買賣 + 避險
    (23, 10, 13, 22),    # 三大法人 = 外資 + 投信 + 自營商
)
# (買, 賣, 淨)：每一組的三欄
TPEX_TRIPLES = ((2, 3, 4), (5, 6, 7), (8, 9, 10), (11, 12, 13),
                (14, 15, 16), (17, 18, 19), (20, 21, 22))


def _check_tpex_row(code: str, nums: list) -> None:
    for triple in TPEX_TRIPLES:
        buy, sell, net = (nums[i] for i in triple)
        if abs(buy - sell - net) > 1:
            raise RuntimeError(
                f"櫃買 {code} 第 {triple} 欄的買賣超不等於買進減賣出，欄位順序可能改了")
    for total, *parts in TPEX_SUMS:
        if abs(nums[total] - sum(nums[i] for i in parts)) > 1:
            raise RuntimeError(
                f"櫃買 {code} 第 {total} 欄不等於第 {parts} 欄相加，欄位順序可能改了")


def fetch_tpex(day: date) -> list:
    """上櫃某一日的三大法人買賣超。非交易日回空 list。"""
    payload = twse.fetch_json(TPEX_INSTI_URL, {
        "type": "Daily",
        "sect": "EW",
        "date": day.strftime("%Y/%m/%d"),
        "id": "",
        "response": "json",
    })
    tables = payload.get("tables") or []
    rows = (tables[0].get("data") if tables else None) or []
    if not rows:
        return []
    got = str(payload.get("date") or "")
    if got and got != day.strftime("%Y%m%d"):
        raise RuntimeError(f"櫃買三大法人要的是 {day}，回來的卻是 {got}")

    out = []
    checked = 0
    for row in rows:
        if len(row) < TPEX_WIDTH:
            raise RuntimeError(f"櫃買三大法人只回了 {len(row)} 欄（要 {TPEX_WIDTH}），來源格式可能改了")
        code = twse.strip_tags(row[0])
        if not twse.is_tracked_code(code):
            continue
        nums = [twse.clean_number(cell) or 0.0 for cell in row[:TPEX_WIDTH]]
        # 整列都是 0 的驗不出任何等式，所以只挑真的有數字的前 50 檔來對
        if checked < 50 and any(nums[2:]):
            _check_tpex_row(code, nums)
            checked += 1
        out.append(Net(code, twse.strip_tags(row[1]),
                       nums[TPEX_COLS["foreign"]], nums[TPEX_COLS["trust"]],
                       nums[TPEX_COLS["dealer"]]))
    if not checked:
        raise RuntimeError("櫃買三大法人整份都是 0，資料可能還沒出來")
    return out


FETCHERS = {"twse": fetch_twse, "tpex": fetch_tpex}


# --------------------------------------------------------------------------- #
# 全市場合計（官方金額）
# --------------------------------------------------------------------------- #
# 兩張彙總表的「單位名稱」對到三邊。兩邊的列名不一樣：證交所把外資與自營商各拆成
# 兩列、沒有小計；櫃買則是小計與明細都給（明細前面有個全角空白）。所以名字要完全
# 相符才收 —— 用「含有外資」之類的模糊比對，會在櫃買那邊把小計與明細加兩次。
TWSE_TOTAL_ROWS = {
    "外資及陸資(不含外資自營商)": "fo",
    "外資自營商": "fo",
    "投信": "tr",
    "自營商(自行買賣)": "de",
    "自營商(避險)": "de",
}
TPEX_TOTAL_ROWS = {
    "外資及陸資合計": "fo",
    "投信": "tr",
    "自營商合計": "de",
}


def _parse_totals(rows: list, spec: dict, source: str) -> dict:
    """彙總表的列 -> {fo, tr, de}（億元）。少了任何一列就停下來。"""
    total = {"fo": 0.0, "tr": 0.0, "de": 0.0}
    seen = set()
    for row in rows or []:
        name = twse.strip_tags(row[0]).replace(" ", "")
        if name not in spec:
            continue
        net = twse.clean_number(row[3])
        if net is None:
            raise RuntimeError(f"{source} 的「{name}」買賣超讀不出數字")
        total[spec[name]] += net / 1e8
        seen.add(name)
    missing = set(spec) - seen
    if missing:
        raise RuntimeError(f"{source} 少了這幾列：{'、'.join(sorted(missing))}，來源格式可能改了")
    return {k: round(v, 2) for k, v in total.items()}


def fetch_twse_total(day: date) -> dict:
    """上市三大法人買賣金額彙總（官方金額）。"""
    payload = twse.fetch_json(BFI82U_URL, {
        "dayDate": day.strftime("%Y%m%d"),
        "type": "day",
        "response": "json",
    })
    return _parse_totals(payload.get("data"), TWSE_TOTAL_ROWS, "BFI82U")


def fetch_tpex_total(day: date) -> dict:
    """上櫃三大法人買賣金額彙總（官方金額）。"""
    payload = twse.fetch_json(TPEX_SUMMARY_URL, {
        "type": "Daily",
        "date": day.strftime("%Y/%m/%d"),
        "response": "json",
    })
    tables = payload.get("tables") or []
    rows = (tables[0].get("data") if tables else None) or []
    return _parse_totals(rows, TPEX_TOTAL_ROWS, "櫃買三大法人買賣金額彙總表")


TOTAL_FETCHERS = {"twse": fetch_twse_total, "tpex": fetch_tpex_total}


# --------------------------------------------------------------------------- #
# 收盤價
# --------------------------------------------------------------------------- #
def load_closes(day: date) -> dict:
    """{市場: {代號: 收盤價}}。先讀 close/ 的當日檔，沒有才現抓。

    排程裡 `backfill.py` 跑在前面，close/ 的當日檔那時已經寫好了，正常情況下
    這裡一個請求都不會發。本機單獨跑這一支、或排程順序被改動時才走現抓那條路。
    """
    closes = {}
    for market in MARKETS:
        path = twse.close_path(day.isoformat(), market)
        if path.exists():
            table = (read_json(path).get("c") or {})
        else:
            got = (twse.fetch_mi_index(day) if market == "twse"
                   else twse.fetch_tpex_daily(day))
            records = got[1] if got else []
            table = {r["code"]: r["close"] for r in records if r.get("close") is not None}
        if not table:
            raise RuntimeError(
                f"{twse.SCOPE_NAMES[market]} {day} 沒有收盤價，"
                "金額算不出來。請先跑 fetch_daily.py 或 backfill.py")
        closes[market] = table
    return closes


def oku(shares: float, close: float) -> float:
    """股數 × 收盤價 -> 億元。"""
    return shares * close / 1e8


# --------------------------------------------------------------------------- #
# 檔案
# --------------------------------------------------------------------------- #
def build_payload(date_iso: str, by_market: dict, closes: dict, totals: dict = None) -> dict:
    """一天的檔案。

    by_market 是 {市場: [Net, ...]}、closes 是 load_closes() 的結果，
    totals 是官方合計 {市場: {fo, tr, de}}；抓不到就給 None，畫面會退回用 est。
    """
    stocks = {}
    est = {}
    raw = {}
    no_price = []
    for market in MARKETS:
        rows = by_market.get(market) or []
        table = closes[market]
        raw[market] = len(rows)
        running = {"fo": 0.0, "tr": 0.0, "de": 0.0}
        kept = {}
        for net in rows:
            close = table.get(net.code)
            if close is None:
                # 當天完全沒成交（暫停交易、全額交割股沒人買）卻有法人異動，多半是
                # 盤後鉅額或錯帳更正。沒有價就沒有金額，整筆不收並在檔案裡記筆數。
                if net.foreign or net.trust or net.dealer:
                    no_price.append(net.code)
                continue
            amounts = [oku(net.foreign, close), oku(net.trust, close), oku(net.dealer, close)]
            for key, value in zip(("fo", "tr", "de"), amounts):
                running[key] += value
            if max(abs(v) for v in amounts) < MIN_OKU:
                continue
            kept[net.code] = [net.name, int(net.foreign), int(net.trust), int(net.dealer), close]
        stocks[market] = dict(sorted(kept.items()))
        est[market] = {k: round(v, 2) for k, v in running.items()}

    payload = {
        "date": date_iso,
        "v": SNAPSHOT_VERSION,
        "fields": list(FIELDS),
        "cut": MIN_OKU,
        "n": sum(len(v) for v in stocks.values()),
        "raw": raw,
        # 全市場合計（億元）。total 是官方彙總表的精確金額，est 是把個股的估算值
        # 在套 cut 之前加總起來的 —— 兩者的差距就是「收盤價當均價」這件事的誤差。
        "est": est,
        "noPrice": len(no_price),
    }
    if totals:
        payload["total"] = totals
    payload["stocks"] = stocks
    return payload


def daily_path(date_iso: str) -> Path:
    return INSTI_DAILY_DIR / f"{date_iso}.json"


def existing_dates() -> list:
    if not INSTI_DAILY_DIR.exists():
        return []
    return sorted(p.stem for p in INSTI_DAILY_DIR.glob("*.json"))


def read_json(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path: Path, payload) -> Path:
    return twse.write_json(path, payload)
