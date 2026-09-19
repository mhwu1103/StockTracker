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
