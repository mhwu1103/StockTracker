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

## 連續買賣超算在後端

「外資連買 N 天」要回頭看 N 天，而一天的檔案 43 KB —— 讓前端自己抓十幾天回來算
是幾百 KB 的代價，而且最長的那幾段可以連到資料起點，等於整段歷史都得下載。
所以連續天數在 `build_institutions.py` 算好，一天寫一個 `insti/streak/{日期}.json`
（只留 `RUN_MIN_DAYS` 天以上的，一天約 13 KB）。純衍生資料，每次都由 daily/ 重算。

判斷「連續」的三條規則，都是為了不讓它安靜地算出比實際更長的天數：

1. **相鄰性看交易日，不是看檔案順序。** 兩個市場只有一邊有資料的日子整天不寫檔
   （見 `fetch_institutions.py`），所以 daily/ 中間可能缺一個真正的交易日。
   照檔案順序往前接的話，那個缺口會被跳過 —— 缺的那天賣超也照樣算成連買。
   交易日的名單取自 `docs/data/close/twse/`（全市場行情，比法人資料早開始累積）。
2. **沒進當天檔案就斷。** 缺席代表三邊的估算金額都不到 `MIN_OKU`，外資那天動的
   是幾萬元的零頭；把它算成買超的一天，等於用資料檔的邊界去編造連續性。
3. **連到資料起點（或缺口）的那幾段標 `trunc`。** 起算日的前一個交易日沒有法人
   資料時，實際天數只可能更長，不可能更短，畫面上要標成「連 N+ 天」。

## 當日漲跌也算在後端

「買超」分頁要把買超排行與**逆勢買超**（法人買超、股價卻收黑）擺在一起，所以每一檔
都要有當天的漲跌。daily/ 只存收盤價，漲跌得拿前一個交易日的收盤價比 —— 那份資料
在 `docs/data/close/` 裡，本機就有，所以它與連續榜一樣是純衍生的：一天寫一個
`insti/chg/{日期}.json`（約 13 KB），由 `build_institutions.py` 每次重算，不寫進 daily/。

不用成交值排行那份現成的 `changePct`，是因為那份只留前 300 名，而法人資料一天有
九百多檔 —— 逆勢買超最有意思的常常正是排不進前 300 的中型股，少了它們，畫面上
「算不出來」與「沒有逆勢」會長得一模一樣。

## 跨日累計也算在後端

同一個理由：近 20 日累計要回頭讀 20 個 43 KB 的每日檔。一天寫一個
`insti/sum/{日期}.json`，含三邊 × 兩個窗口（5／20 日）的累計金額、累計股數與
期間漲跌。**累計買超不是連續買超** —— 前者不管中間翻不翻向，後者一翻就斷，
兩張榜挑出來的是不同的股票，所以 `streak/` 與 `sum/` 並存。

## 「平常的量」也一樣

力道標（今天這筆是平常的幾倍）要的是每一檔自己過去 20 天的中位數，同樣得回頭讀
20 個每日檔。一天寫一個 `insti/base/{日期}.json`，存的是**分母**不是倍數 ——
倍數由前端除出來，日後改顯示方式不必重算整段歷史。

## 個股頁要的是轉置

上面四份都是「一天 → 所有股票」，個股頁要的是反過來的「一檔 → 所有天」。所以還有
第五份 `insti/stock/{代號}.json`，一檔一個檔（形狀與 `holders/stock/` 一致）。
不讓前端抓幾十天的每日檔自己轉：一天 43 KB，抓 60 天是 2.6 MB，而使用者要的只有
其中一檔。
"""

from __future__ import annotations

import json
from collections import namedtuple
from datetime import date
from pathlib import Path

import twse

INSTI_DIR = twse.DATA_DIR / "insti"
INSTI_DAILY_DIR = INSTI_DIR / "daily"
INSTI_RUN_DIR = INSTI_DIR / "streak"
INSTI_CHG_DIR = INSTI_DIR / "chg"
INSTI_SUM_DIR = INSTI_DIR / "sum"
INSTI_BASE_DIR = INSTI_DIR / "base"
INSTI_STOCK_DIR = INSTI_DIR / "stock"
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
F_NAME, F_FO, F_TR, F_DE, F_CLOSE = (FIELDS.index(k) for k in FIELDS)

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
# 連續買賣超（外資）
# --------------------------------------------------------------------------- #
# 檔案格式版號，與 SNAPSHOT_VERSION 各自獨立：daily/ 沒動、只改連續榜的欄位時
# 只有這一個要加一。
RUN_VERSION = 1

# 幾天以上才寫進檔案。三天是「連續」這個詞最低的門檻，兩天在一天的檔案裡就看得出來。
RUN_MIN_DAYS = 3

# 只算外資。投信與自營商的資料同樣在 daily/ 裡，但這一份要回答的是「外資有沒有
# 一路買下去」—— 三邊都存進來會讓檔案大三倍，而畫面上一次只看得懂一種。
RUN_LEG = "fo"

# 一段連續買（賣）超存的八個值，順序即 index。前端的 R_NAME/R_DAYS/… 必須一致。
#   name   簡稱
#   days   連續天數，正的是連買、負的是連賣
#   lots   這段期間的累計買賣超股數
#   oku    這段期間的累計估算金額（億元，逐日以當日收盤價換算後相加）
#   since  這段連續的起算日（第一個同向的交易日）
#   close  最後一天（也就是檔名那天）的收盤價
#   ret    起算日「前一個交易日」收盤到最後一天收盤的漲跌（%），算不出來為 null
#   trunc  1 代表起算日的前一個交易日沒有法人資料，實際天數只可能更長
RUN_FIELDS = ("name", "days", "lots", "oku", "since", "close", "ret", "trunc")

# 一段還在進行中的連續買（賣）超。days 帶正負號，其餘都是累加值。
Run = namedtuple("Run", "market name days lots oku since close trunc")


def foreign_table(payload: dict) -> dict:
    """一天的檔案 -> {代號: (市場, 簡稱, 外資買賣超股數, 收盤價)}。"""
    out = {}
    for market, stocks in (payload.get("stocks") or {}).items():
        for code, row in stocks.items():
            out[code] = (market, row[F_NAME], row[F_FO], row[F_CLOSE])
    return out


def adjacent_flags(dates: list, trading: list) -> list:
    """dates[i] 的前一個交易日是不是就是 dates[i-1]。

    dates 是有法人資料的日子、trading 是全部交易日。第 0 個永遠是 False ——
    它前面那個交易日（如果有）本來就沒有法人資料。不在 trading 裡的日期同樣算 False：
    對不上全市場行情的日期不該被拿來接續，寧可斷在那裡。
    """
    slot = {d: i for i, d in enumerate(trading)}
    flags = []
    for i, date_iso in enumerate(dates):
        at = slot.get(date_iso)
        flags.append(bool(i and at and slot.get(dates[i - 1]) == at - 1))
    return flags


def foreign_runs(days: list):
    """逐日推進每一檔的連續買（賣）超。

    days 是 [(日期, 前一天是否相鄰, foreign_table 的結果)]，由舊到新。
    每一天產出 {代號: Run}，只含當天外資有明確方向（股數不為零）的那些。

    往前接的條件有三個：前一個交易日相鄰、那天這一檔也在（沒進檔案就是斷）、
    而且方向相同。任何一個不成立就從今天重新起算。
    """
    prev = {}
    for date_iso, adjacent, table in days:
        cur = {}
        for code, (market, name, shares, close) in table.items():
            if not shares:
                continue
            up = shares > 0
            base = prev.get(code) if adjacent else None
            if base and (base.days > 0) == up:
                cur[code] = base._replace(
                    market=market, name=name,
                    days=base.days + (1 if up else -1),
                    lots=base.lots + shares,
                    oku=base.oku + oku(shares, close),
                    close=close)
            else:
                cur[code] = Run(market, name, 1 if up else -1, shares,
                                oku(shares, close), date_iso, close, not adjacent)
        prev = cur
        yield date_iso, cur


def run_return(run: Run, base_close) -> float:
    """起算日前一個交易日的收盤 -> 最後一天的收盤，漲跌幾 %。

    基準取「起算日的前一天」而不是起算日本身：外資是在起算日當天買的，那天的
    收盤價已經含了這筆買盤推上去的部分，拿它當起點會少算第一天。
    """
    if not base_close:
        return None
    return round((run.close / base_close - 1) * 100, 2)


def build_run_payload(date_iso: str, runs: dict, first: str, returns: dict) -> dict:
    """一天的連續榜檔案。runs 是 foreign_runs 的產出，returns 是 {代號: 漲跌%}。"""
    stocks = {m: {} for m in MARKETS}
    buy = sell = 0
    for code, run in sorted(runs.items()):
        if abs(run.days) < RUN_MIN_DAYS:
            continue
        stocks[run.market][code] = [
            run.name, run.days, int(run.lots), round(run.oku, 2), run.since,
            run.close, returns.get(code), 1 if run.trunc else 0,
        ]
        if run.days > 0:
            buy += 1
        else:
            sell += 1
    return {
        "date": date_iso,
        "v": RUN_VERSION,
        "fields": list(RUN_FIELDS),
        "leg": RUN_LEG,
        "min": RUN_MIN_DAYS,
        # 法人資料最早的那一天。起算日等於它的那幾段，天數只可能更長（trunc=1）
        "first": first,
        "n": buy + sell,
        "buy": buy,
        "sell": sell,
        "stocks": stocks,
    }


# --------------------------------------------------------------------------- #
# 當日漲跌
# --------------------------------------------------------------------------- #
# 「買超」分頁的第二個軸：法人買超的這一檔，今天自己是漲還是跌。
#
# daily/ 每一檔只存收盤價，漲跌要拿前一個交易日的收盤價來比，而那份資料在
# docs/data/close/ 裡、本機就有 —— 所以這一份與連續榜一樣是**純衍生**的，
# 由 build_institutions.py 每次從頭重算，不寫進 daily/。daily/ 存的是從官方抓
# 回來的東西，把算得出來的欄位塞進去，日後要改算法就得把整段歷史重抓一次。
#
# 為什麼不拿 daily/{範圍}/*.json 那份現成的 changePct 就好：那份只留成交值前 300 名，
# 而法人資料一天有九百多檔。「逆勢買超」最有意思的通常正是成交值排不進前 300 的
# 中型股 —— 用前 300 名那份的話它們的漲跌整欄留白，而**留白與「沒有逆勢」在畫面上
# 長得一模一樣**，等於安靜地把答案刪掉一半。
#
# 一天一個檔，九百多檔約 13 KB。代號在上市與上櫃之間不重複，所以不分市場、
# 攤平成一張表；讀的人本來就是拿代號去查。
CHG_VERSION = 1


def chg_path(date_iso: str) -> Path:
    return INSTI_CHG_DIR / f"{date_iso}.json"


def close_file(date_iso: str, market: str) -> dict:
    """docs/data/close/{市場}/{日期}.json 的 {代號: 收盤價}。檔案不在就回空的。"""
    path = twse.close_path(date_iso, market)
    return (read_json(path).get("c") or {}) if path.exists() else {}


def payload_closes(payload: dict) -> dict:
    """一天的每日檔 -> {市場: {代號: 收盤價}}。"""
    return {market: {code: row[F_CLOSE] for code, row in stocks.items()}
            for market, stocks in (payload.get("stocks") or {}).items()}


def build_chg_payload(date_iso: str, prev_iso, closes: dict, prev_closes: dict) -> dict:
    """一天的漲跌檔。closes 與 prev_closes 都是 {市場: {代號: 收盤價}}。

    前一個交易日沒有這一檔（剛上市、停牌整天、那天的 close/ 還沒抓）就不收 ——
    算不出來的漲跌寧可缺欄，也不要塞一個 0 進去假裝它今天收平盤。
    """
    chg = {}
    missing = 0
    for market, table in closes.items():
        before = (prev_closes or {}).get(market) or {}
        for code, close in table.items():
            base = before.get(code)
            if not base or not close:
                missing += 1
                continue
            chg[code] = round((close / base - 1) * 100, 2)
    return {
        "date": date_iso,
        "v": CHG_VERSION,
        # 拿來當基準的那一個交易日。畫面上要講得出漲跌是「對比哪一天」
        "prev": prev_iso,
        "n": len(chg),
        # 算不出漲跌的檔數。整份都算不出來（prev 是 None）時這個數字才會大
        "miss": missing,
        "chg": dict(sorted(chg.items())),
    }


# --------------------------------------------------------------------------- #
# 跨日累計
# --------------------------------------------------------------------------- #
# 「買超」分頁的第三個軸：同一批法人，**這幾天下來**買了多少。
#
# 當日的分項在 daily/ 裡就有，跨日的沒有 —— 近 20 日累計要回頭讀 20 個 43 KB 的
# 每日檔，讓前端自己抓是 800 KB 的代價。與連續榜同一個理由，算在後端。
#
# ## 累計買超不是連續買超
#
# 兩份檔案各自回答不同的問題，缺一不可：
#
#   連買（streak/）  每一個交易日都站在同一邊，中間翻向就斷。問的是「有沒有一路買」
#   累計（這一份）    這段期間的淨額，中間翻不翻向不管。問的是「總共買了多少」
#
# 一檔可以在 20 個交易日裡累計買超 50 億、而中間有 8 天是賣的 —— 連買榜看不到它，
# 累計榜看得到。反過來一檔連買 12 天但每天只有幾千萬，連買榜排在最前面，
# 累計榜上根本排不進去。
#
# ## 沒進當天檔案的那些天算 0，不是算缺
#
# 連續榜遇到「沒進當天檔案」是**斷掉**，因為那會讓天數憑空變長。累計這邊相反：
# 缺席代表三邊的估算金額都不到 MIN_OKU（0.05 億），那天真的幾乎沒有淨額，
# 算成 0 就是正確答案。把它當成缺口而整段不算，反而會把一堆真的有在買的個股刷掉。
#
# ## 窗口不足要標出來
#
# 資料起點附近（或 daily/ 中間缺了交易日時）湊不滿 20 天。**湊不滿的累計看起來
# 跟「那段時間法人沒什麼動作」一模一樣**，所以每一列都帶 days（實際算了幾天），
# 不足的畫面上要標，沿用連買頁「連 N+ 天」的同一個精神。
#
# ## 期間漲跌的基準與連買頁一致
#
# 取窗口第一天的**前一個交易日**收盤：法人是在第一天當天買的，那天的收盤價已經含了
# 這筆買盤推上去的部分，拿它當起點會少算第一天。
SUM_VERSION = 2

# 兩個窗口。5 日是一週、20 日是一個月，都是市場上講累計買超時的習慣長度。
SUM_WINDOWS = (5, 20)

# ## 留哪些：按榜取前 N，不是單一金額門檻
#
# daily/ 用的是「三邊的估算金額都不到 MIN_OKU 就不存」那種單一門檻。同一招套在累計
# 上會有系統性偏差：**外資的金額比投信大一個量級**，拿 max(三邊) 去砍，砍掉的幾乎
# 都是投信有意思的中型股 —— 而那正是這張榜該挑出來的東西。
#
# 所以改成按榜取：每個市場、每一邊各留前 SUM_KEEP 名。四邊是畫面上的四個 pill
# （外資、投信、自營，加上三邊相加的三大法人），每一張榜都完整到 100 名深，
# 而畫面只排前 30 —— 榜尾不可能因為檔案的邊界而憑空少幾檔。
#
# 分市場取是因為頂部的範圍選單：只看上櫃時，那張榜要從上櫃自己的前 100 名裡排。
# 某檔若排得進合併後的前 N 名，它在自己市場裡必然也在前 N 名內（README 對「全部」
# 範圍的同一個論證），所以兩個市場各取前 100 再聯集，對三種範圍都夠用。
SUM_KEEP = 100

# 但排第幾名都一樣是零頭的那些不留：絕對值不到這個數（億元）就算進了前 100 也丟掉。
SUM_FLOOR = 0.1

# 一檔的靜態欄位，兩個窗口共用一份，省掉重複。
SUM_META_FIELDS = ("name", "market", "close")

# 每一個窗口、每一檔存的十一個值，順序即 index。
#   fo/tr/de        三邊的累計估算金額（億，逐日以當日收盤價換算後相加）
#   lfo/ltr/lde     三邊的累計買賣超股數
#   ret             期間漲跌（%）：窗口第一天的前一個交易日收盤 -> 當日收盤
#   pfo/ptr/pde     三邊「與淨額同方向那幾天」的股數加權收盤均價（見 avg_prices）
#   psum            三大法人那一邊的同一個數字
#
# 均價為什麼要另外算、不能拿 fo ÷ lfo：見 avg_prices() 的說明。簡單說淨額是相減的
# 結果，拿它當分母會算出負的價格。
#
# 「實際算了幾個交易日」不在這裡 —— 同一天同一個窗口裡，每一檔的天數都一樣，
# 它是窗口的性質不是個股的性質，所以放在窗口那一層（w.{窗口}.days）。
SUM_FIELDS = ("fo", "tr", "de", "lfo", "ltr", "lde", "ret",
              "pfo", "ptr", "pde", "psum")


def sum_path(date_iso: str) -> Path:
    return INSTI_SUM_DIR / f"{date_iso}.json"


def leg_table(payload: dict) -> dict:
    """一天的每日檔 -> {代號: (市場, 簡稱, 外資, 投信, 自營, 收盤價)}。

    foreign_table() 只取外資那一段，這一份三邊都要。
    """
    out = {}
    for market, stocks in (payload.get("stocks") or {}).items():
        for code, row in stocks.items():
            out[code] = (market, row[F_NAME], row[F_FO], row[F_TR], row[F_DE], row[F_CLOSE])
    return out


def window_span(adjacent: list) -> list:
    """每一天往前「連續相鄰交易日」有多長（含自己）。

    adjacent 是 adjacent_flags() 的結果。中間缺了一個真正的交易日就從那裡重新算起
    —— 跨過缺口的累計會把缺的那幾天當成沒發生，而它們其實是不知道。
    """
    span = []
    for i, ok in enumerate(adjacent):
        span.append(span[i - 1] + 1 if i and ok else 1)
    return span


def accumulate(dates: list, tables: dict, at: int, days: int):
    """dates[at] 往前 days 個交易日的累計。

    回傳 ({代號: [fo, tr, de, lfo, ltr, lde]}, {代號: (市場, 簡稱)})。
    tables 是 {日期: leg_table 的結果}；某一天沒有這一檔就當那天是 0（見模組說明）。

    第二份取窗口內**最後一次**出現時的市場與簡稱：有些個股今天沒進檔案（當天三邊
    都只有零頭）但前幾天有，它照樣該進累計榜，名字得拿得出來。簡稱偶爾會變
    （改名、轉上市），以最近的那一次為準。
    """
    total = {}
    ident = {}
    for i in range(at - days + 1, at + 1):
        for code, (market, name, fo, tr, de, close) in tables[dates[i]].items():
            row = total.get(code)
            if row is None:
                row = total[code] = [0.0, 0.0, 0.0, 0, 0, 0]
            row[0] += oku(fo, close)
            row[1] += oku(tr, close)
            row[2] += oku(de, close)
            row[3] += fo
            row[4] += tr
            row[5] += de
            ident[code] = (market, name)
    return total, ident


def sum_keep(totals: dict, ident: dict) -> set:
    """每個市場、每一邊各留前 SUM_KEEP 名（依累計金額絕對值）的聯集。理由見上面。

    totals 是 {代號: [fo, tr, de, ...]}、ident 是 {代號: (市場, 簡稱)}。
    """
    keep = set()
    legs = (lambda r: r[0], lambda r: r[1], lambda r: r[2],
            lambda r: r[0] + r[1] + r[2])      # 第四邊是三大法人合計
    for market in MARKETS:
        here = [(c, r) for c, r in totals.items() if ident[c][0] == market]
        for leg in legs:
            ranked = sorted(here, key=lambda kv: abs(leg(kv[1])), reverse=True)
            for code, row in ranked[:SUM_KEEP]:
                if abs(leg(row)) >= SUM_FLOOR:
                    keep.add(code)
    return keep


def avg_prices(dates: list, tables: dict, at: int, days: int, totals: dict) -> dict:
    """窗口內「與淨額同方向」那幾天的股數加權收盤均價。

    -> {代號: [外資, 投信, 自營, 三大法人]}，算不出來的那一格是 None。

    ## 為什麼不能直接用 累計金額 ÷ 累計股數

    那個商數看起來就是均價，實際上不是：淨額是**相減**的結果，拿它當分母沒有物理
    意義。實測近 20 日有外資淨額的 1,412 檔，只有 228 檔期間內是單邊（只買或只賣），
    其餘 1,184 檔有買有賣 —— 而用淨額算出來的「均價」有 219 檔落在期間的價格區間外，
    包括負的價格（竹陞科技 -4,849 元）與台積電的 2,597 元（期間收盤只在 2,350~2,440）。

    ## 只取同方向的那幾天

    淨買超就只看買進的那幾天、淨賣超就只看賣出的那幾天。權重全部同號，所以結果
    必定落在那幾天的收盤價區間內（實測 1,409/1,412 落在區間內，其餘 3 檔的偏差是
    1e-15 等級的浮點誤差，四捨五入到兩位小數就沒了）。

    ## 它描述的是那幾天，不是淨額

    一檔買 10,000 張、賣 9,900 張的股票，淨額只有 100 張，但均價描述的是那 10,000 張。
    畫面上要標成「買均／賣均」而不是「均價」，而且**絕對不能叫它法人成本** ——
    官方的個股資料只有股數，這裡的收盤價本來就不是成交均價（見模組說明）。
    """
    # leg_table 的 fo / tr / de，第四個是三邊相加
    picks = (lambda r: r[2], lambda r: r[3], lambda r: r[4],
             lambda r: r[2] + r[3] + r[4])
    # 代號 -> 每一邊 [買進金額, 買進股數, 賣出金額, 賣出股數]
    acc = {}
    for i in range(at - days + 1, at + 1):
        for code, row in tables[dates[i]].items():
            if code not in totals:
                continue
            close = row[5]
            slot = acc.get(code)
            if slot is None:
                slot = acc[code] = [[0.0, 0.0, 0.0, 0.0] for _ in picks]
            for k, pick in enumerate(picks):
                shares = pick(row)
                if shares > 0:
                    slot[k][0] += shares * close
                    slot[k][1] += shares
                elif shares < 0:
                    slot[k][2] += shares * close
                    slot[k][3] += shares

    out = {}
    for code, slot in acc.items():
        total = totals[code]
        # totals 的後三個是累計股數；第四邊的淨額是三者相加
        nets = (total[3], total[4], total[5], total[3] + total[4] + total[5])
        row = []
        for k, net in enumerate(nets):
            buy_amt, buy_sh, sell_amt, sell_sh = slot[k]
            if net > 0 and buy_sh:
                row.append(round(buy_amt / buy_sh, 2))
            elif net < 0 and sell_sh:
                row.append(round(sell_amt / sell_sh, 2))
            else:
                row.append(None)
        out[code] = row
    return out


def build_sum_payload(date_iso: str, wins: dict, meta: dict) -> dict:
    """一天的累計檔。

    wins 是 {窗口長度: (實際天數, {代號: SUM_FIELDS 那十一個值})}，
    meta 是 {代號: [簡稱, 市場, 當日收盤價]}，只留真的有進到某一個窗口的那些。
    """
    kept = {str(w): {"days": days, "rows": dict(sorted(rows.items()))}
            for w, (days, rows) in wins.items()}
    used = {code for block in kept.values() for code in block["rows"]}
    return {
        "date": date_iso,
        "v": SUM_VERSION,
        "wins": list(SUM_WINDOWS),
        "keep": SUM_KEEP,
        "floor": SUM_FLOOR,
        "fields": {"meta": list(SUM_META_FIELDS), "win": list(SUM_FIELDS)},
        "n": {w: len(b["rows"]) for w, b in kept.items()},
        "meta": {c: meta[c] for c in sorted(used) if c in meta},
        "w": kept,
    }

# --------------------------------------------------------------------------- #
# 平常的量（力道標的分母）
# --------------------------------------------------------------------------- #
# 「買超」分頁的第四個軸：今天這筆買賣超，**對這一檔來說**算大嗎。
#
# 頁面上已經有「佔成交值」，但它問的是「相對於**今天的量**大不大」。力道標問的是
# 另一件事：「相對於**這一檔自己的平常**大不大」。兩個都需要 —— 一檔平常每天被外資
# 買賣幾百萬、今天忽然買超 2 億，佔成交值可能只有 3%（因為今天量也放大了），
# 但對這一檔來說是空前的。
#
# 這一份存的是**分母**（平常的量），不是倍數。倍數由前端除出來 —— 存分母的話，
# 同一份檔案換個顯示方式（例如日後要改成分位數）不必重算整段歷史。
#
# ## 中位數，不是平均
#
# 平均會被過去 20 天裡某一天的大額整個吃掉，算出來的「平常」其實是那一天。
# 中位數不會。
#
# ## 不含今天
#
# 「平常」取今天**之前**那 BASE_WINDOW 個有法人資料的交易日。含今天的話，今天那筆
# 大額會墊高自己的分母，力道標會系統性地偏小。
#
# ## 不要求相鄰
#
# 連續榜與累計檔都很在意「相鄰的交易日」，這一份不用：中位數是統計量，不是連續性。
# 中間缺一天不會讓「這一檔平常被買多少」這個問題變得不成立，所以取的是「前 N 個
# **有法人資料**的交易日」，缺口照跨。
#
# ## 分母的地板：夾住，不是藏起來
#
# 最大的坑是分母趨近 0：平常沒人動的個股，今天動一次就是 50 倍、200 倍 ——
# 那個數字看起來最聳動，資訊量卻最低。
#
# 第一版想的是「中位數不到 0.1 億就不給力道標」。實測否決了它：1,445 檔曾進過每日檔
# 的個股裡，有 570 檔的外資日金額中位數是 **0**（大部分交易日根本沒進檔案），
# 再加 98 檔不到 0.05 億 —— 藏起來等於對 58% 的個股留白，而那裡面正好是最有意思的
# 那一類（平常沒人碰、今天忽然有人買三億）。
#
# 所以改成**夾**：前端算的是 今日金額 ÷ max(中位數, daily 的收錄門檻)。
# 比 MIN_OKU（0.05 億）小的數字，每日檔裡根本沒有記錄，所以那是這份資料的**解析度
# 下限** —— 真正的中位數是多少我們不知道，只知道它在那之下。拿它當地板，
# 等於說「最多只能講到這個倍數」，而不是假裝那一格沒有答案。
BASE_VERSION = 1

# 拿今天之前幾個「有法人資料的交易日」來算「平常」。與累計檔的長窗口同長，
# 讓兩者講的是同一段期間。
BASE_WINDOW = 20

# 前面至少要有幾天才給得出「平常」。少於這個數就整天不寫任何一檔 —— 用三、四天
# 算出來的中位數不是「平常」，是「剛好那幾天」。
BASE_MIN_DAYS = 10


def base_path(date_iso: str) -> Path:
    return INSTI_BASE_DIR / f"{date_iso}.json"


def median(values: list) -> float:
    """中位數。偶數筆取中間兩個的平均，空的回 0。"""
    if not values:
        return 0.0
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


# 存的四個值，順序即 index。前三個對應畫面上的三個 pill，第四個是「三大法人」。
#
# 第四個**必須另外算**，不能拿前三個相加：中位數不可加。某一檔可能外資與投信天天
# 一買一賣、各自的中位數都是 3 億，而三邊相加後的淨額中位數只有 0.2 億 ——
# 拿 3+3+0 當「三大法人的平常」，力道標會系統性地偏小到看不出任何異常。
BASE_FIELDS = ("fo", "tr", "de", "sum")


def daily_norms(dates: list, tables: dict, at: int) -> dict:
    """dates[at] 那一天每一檔的「平常的量」-> {代號: [外資, 投信, 自營, 三大法人]}（億）。

    取 dates[at] **之前**最多 BASE_WINDOW 個有法人資料的交易日，每一邊各取
    日金額絕對值的中位數。那幾天沒進檔案的算 0 —— 缺席代表三邊都不到 MIN_OKU，
    那天這一檔確實幾乎沒有淨額，算 0 就是對的。

    只算 dates[at] 當天在檔案裡的那些代號：力道標是掛在今天的列上的，
    今天不在榜上的個股算了也沒有地方顯示。
    """
    window = dates[max(0, at - BASE_WINDOW):at]
    if len(window) < BASE_MIN_DAYS:
        return {}
    history = [tables[d] for d in window]
    out = {}
    for code in tables[dates[at]]:
        past = [table.get(code) for table in history]
        legs = [round(median([
            abs(oku(row[index], row[5])) if row else 0.0 for row in past
        ]), 2) for index in (2, 3, 4)]      # leg_table 的 fo / tr / de
        # 三大法人：先把每一天的三邊相加再取絕對值，才是「那一天三大法人淨動多少」
        legs.append(round(median([
            abs(oku(row[2] + row[3] + row[4], row[5])) if row else 0.0 for row in past
        ]), 2))
        out[code] = legs
    return out


def build_base_payload(date_iso: str, norms: dict, used: int) -> dict:
    """一天的「平常的量」檔。

    used 是實際拿幾個交易日算的 —— 同一天所有個股都一樣（它是窗口的性質，
    不是個股的性質），所以放在最上層。
    """
    return {
        "date": date_iso,
        "v": BASE_VERSION,
        "win": BASE_WINDOW,
        # 實際用了幾個交易日。小於 win 代表資料起點附近，湊不滿
        "used": used,
        "min": BASE_MIN_DAYS,
        "n": len(norms),
        "fields": list(BASE_FIELDS),
        # {代號: [外資, 投信, 自營, 三大法人]}，日買賣超金額絕對值的中位數（億）
        "base": dict(sorted(norms.items())),
    }

# --------------------------------------------------------------------------- #
# 個股序列（轉置）
# --------------------------------------------------------------------------- #
# 個股頁要的是「這一檔過去幾週法人怎麼進出」，而 daily/ 存的是「一天 → 所有股票」。
# 方向剛好相反，所以要轉置一次 —— 成交值排行遇過一模一樣的問題（解法是
# `history/{範圍}/{年}.json`），集保那邊也有 `holders/stock/{代號}.json`。
#
# ## 為什麼不讓前端自己抓幾天回來轉
#
# 個股頁的期間可以選到「全部」。一天的每日檔 43 KB，抓 60 天是 2.6 MB，
# 而使用者要的只是其中一檔 —— 那 935 分之 934 的資料全部白抓。
#
# ## 一檔一個檔，不切年
#
# 跟 `holders/stock/` 一樣的形狀。不照 `kline/` 那樣切月，是因為個股頁的期間
# 有「全部」這一個選項：切月的話那個選項要抓十幾個檔，而法人資料一檔一年也才
# 約 7.5 KB（245 個交易日 × 4 個數字），整段抓回來一次反而便宜。
#
# 日後真的長到不能一次抓（幾年之後），`d` 是獨立的日期陣列，切年很容易。
#
# ## 只存有進每日檔的那幾天
#
# 三邊的估算金額都不到 MIN_OKU 的那幾天不進 daily/，這裡也就沒有。`d` 因此是
# **稀疏**的，不是每一個交易日都有。畫面要拿 index 的交易日去對齊，而不是假設
# `d` 是連續的 —— 缺的那幾天代表「那天法人動的是零頭」，不是「沒有資料」。
#
# ## 用 write_if_changed
#
# 每次都由 daily/ 從頭重算全部一千多檔，直接寫的話每天就是一千多個檔的差異，
# 而其中有幾百檔今天根本沒動。內容沒變就不重寫（與 build_holders.py 同一招）。
STOCK_VERSION = 1

# 每一天存的四個值，順序即 index。前端的 S_FO/S_TR/… 必須與這裡一致。
STOCK_FIELDS = ("fo", "tr", "de", "close")


def stock_path(code: str) -> Path:
    return INSTI_STOCK_DIR / f"{code}.json"


def transpose(dates: list, tables: dict) -> dict:
    """{日期: leg_table} -> {代號: {n, m, d, v}}，由舊到新。

    簡稱與市場取**最後一次**出現時的值：簡稱偶爾會變（改名、轉上市），
    畫面上該顯示現在的那一個。
    """
    out = {}
    for date_iso in dates:
        for code, (market, name, fo, tr, de, close) in tables[date_iso].items():
            row = out.get(code)
            if row is None:
                row = out[code] = {"n": name, "m": market, "d": [], "v": []}
            row["n"] = name
            row["m"] = market
            row["d"].append(date_iso)
            row["v"].append([int(fo), int(tr), int(de), close])
    return out


def build_stock_payload(code: str, row: dict) -> dict:
    """一檔的序列檔。格式與 holders/stock/ 對齊：fields 說明欄位、d 是日期、v 是值。"""
    return {
        "c": code,
        "n": row["n"],
        "m": row["m"],
        "fields": list(STOCK_FIELDS),
        "d": row["d"],
        "v": row["v"],
    }

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


def run_path(date_iso: str) -> Path:
    return INSTI_RUN_DIR / f"{date_iso}.json"


def existing_dates() -> list:
    if not INSTI_DAILY_DIR.exists():
        return []
    return sorted(p.stem for p in INSTI_DAILY_DIR.glob("*.json"))


def read_json(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path: Path, payload) -> Path:
    return twse.write_json(path, payload)
