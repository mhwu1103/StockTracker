"""共用邏輯：美股日線與「美股 → 台股」的連動相關性。

## 這一支在回答什麼

`docs/data/us_link.json` 是人工標的對照表，星等是憑供應鏈關係給的。
這裡做的是把那份標註拿去**對資料驗證**：真的算一次相關係數，用百分比講出來。

## 對齊方式：美股 T 日 → 台股 T+1 日

美股收盤（台灣時間清晨）在台股開盤之前，所以因果方向只有一個：
**美股 D 日的日報酬，對上台股「D 之後的第一個交易日」的日報酬。**
同一個日曆日擺在一起是錯的——那等於拿台股當天的收盤去對美股還沒開盤的行情。

## 兩個相關係數

    r   原始相關：兩邊的日報酬直接算皮爾森相關係數
    x   超額相關：兩邊各自先扣掉自己市場的大盤（台股扣 ^TWII、美股扣 ^IXIC）再算

只看 r 會被「整個市場一起動」灌水：台股電子股彼此的相關本來就有五、六成，
對上任何一檔美股大型股都不會太難看。x 抽掉共同的市場因子，留下的才是
「這一對真的綁在一起」的部分。兩個都給，讓讀的人自己判斷。

## 資料範圍的硬限制

台股價格取自 `docs/data/kline/`，那是由 `close/` 轉置出來的，只從 2026-03-16 開始
（全市場四價是後來才存的）。所以相關性最長就是半年，再長算不出來——
這是資料的限制，不是參數可以調的，前端必須講清楚。

只放邏輯，不負責 I/O 與排程——那是 fetch_us.py 與 build_us.py 的事。
"""

from __future__ import annotations

import json
from bisect import bisect_right
from pathlib import Path

import twse

US_DIR = twse.DATA_DIR / "us"
MARKET_PATH = US_DIR / "market.json"
INDEX_PATH = US_DIR / "index.json"
LINK_PATH = twse.DATA_DIR / "us_link.json"

# 兩個大盤，用來算超額相關。不是給人看的標的，是拿來當減數的。
TW_INDEX = "^TWII"
US_INDEX = "^IXIC"

# 相關性的觀察窗（交易日）。120 差不多就是 kline 的全部，再長也沒有資料。
SPANS = (20, 60, 120)

# 少於這個點數就不給數字：十來天的相關係數只是雜訊，寧可留白
MIN_POINTS = 15

KLINE_CLOSE = 3            # kline 的 q 是 [開, 高, 低, 收]


# --------------------------------------------------------------------------- #
# 對照表
# --------------------------------------------------------------------------- #
def load_link() -> dict:
    return json.loads(LINK_PATH.read_text(encoding="utf-8"))


def load_themes() -> dict:
    return json.loads((twse.DATA_DIR / "themes.json").read_text(encoding="utf-8"))


def us_tickers(link: dict) -> dict:
    """對照表裡出現過的所有美股：代號 -> 中文名。含 benchmarks。

    同一檔會出現在好幾族（NVDA 出現在六族），名字以第一次出現的為準。
    """
    out = {}
    for row in link.get("benchmarks") or []:
        out.setdefault(row["t"], row["n"])
    for group in link["groups"]:
        for row in group.get("us") or []:
            out.setdefault(row["t"], row["n"])
        for sub in group.get("subs") or []:
            for row in sub.get("us") or []:
                out.setdefault(row["t"], row["n"])
    return out


def pairs_of(link: dict, themes: dict) -> dict:
    """美股 -> [(台股代號, 族群, 子族群, 強度)]。

    配對的範圍就是人工對照表畫出來的範圍：族群層級的美股配整族的成分股，
    子族群層級的配那一個子族群的。

    同一對會從兩個層級各進來一次（NVDA 在「晶圓代工 · 封測」是 ★★★、在子族群
    「晶圓代工」是 ★★☆）。這種時候**標籤取最具體的、強度取最高的**：
    子族群再列一次是把話說得更細，不是把這一對降級。

    但族群層級的標註不能無條件整族套下去：ANET 掛在「網通 · 交換器」是 ★★★，
    指的是交換器那一段，不是同一族底下的電信商。規則是——
    **子族群自己列了美股，就代表它自己講得清楚**，族群層級那些沒被它列到的標的
    對它降一級（★★★ 變 ★★☆）：那是講整族的泛稱，不是針對這一段的主張。
    子族群沒列（美股找不到對得上的同業）才整族照抄。
    """
    codes_of = {}
    for group in themes["groups"]:
        codes_of[group["name"]] = {sub["name"]: list(sub["codes"]) for sub in group["subs"]}

    out = {}
    for group in link["groups"]:
        name = group["name"]
        subs = codes_of.get(name) or {}
        own = {sub["name"]: {row["t"] for row in sub.get("us") or []}
               for sub in group.get("subs") or []}

        def mark(ticker, code, sub_name, strength):
            slot = out.setdefault(ticker, {})
            _, old_sub, old_s = slot.get(code, (name, "", 0))
            slot[code] = (name, sub_name or old_sub, max(strength, old_s))

        for row in group.get("us") or []:
            for sub_name, codes in subs.items():
                listed = own.get(sub_name) or set()
                strength = row["s"] if (not listed or row["t"] in listed) else max(1, row["s"] - 1)
                for code in codes:
                    mark(row["t"], code, "", strength)
        for sub in group.get("subs") or []:
            for row in sub.get("us") or []:
                for code in subs.get(sub["name"]) or []:
                    mark(row["t"], code, sub["name"], row["s"])
    return {t: [(c, *v) for c, v in sorted(rows.items())] for t, rows in out.items()}


# --------------------------------------------------------------------------- #
# 台股價格
# --------------------------------------------------------------------------- #
def tw_market_of(code: str) -> str:
    """個股在哪個市場——kline 的路徑要用。查不到回空字串。"""
    for market in ("twse", "tpex"):
        if (twse.KLINE_DIR / market / code).is_dir():
            return market
    return ""


def tw_closes(code: str) -> dict:
    """個股的日收盤價 {日期: 收盤}，由 kline/ 的月檔拼回來。沒有這一檔就回空的。"""
    market = tw_market_of(code)
    if not market:
        return {}
    out = {}
    for path in sorted((twse.KLINE_DIR / market / code).glob("*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        month = payload["month"]
        for day, price in zip(payload["d"], payload["q"]):
            out[f"{month}-{day:02d}"] = price[KLINE_CLOSE]
    return out


def returns(closes: dict, dates: list) -> dict:
    """{日期: 日報酬}。只有「前一個交易日也有價」的日子才算得出報酬。

    dates 是市場自己的交易日軸（已排序）：用它而不是用 closes 自己的鍵，
    才能看得出中間是不是缺了一天——缺的那天不該把報酬算成兩天的合計。
    """
    out = {}
    prev_date = None
    for date in dates:
        price = closes.get(date)
        if price is None:
            prev_date = None          # 斷掉了，下一天不能拿更早的價當前一日
            continue
        if prev_date is not None:
            base = closes[prev_date]
            if base:
                out[date] = price / base - 1
        prev_date = date
    return out


# --------------------------------------------------------------------------- #
# 相關係數
# --------------------------------------------------------------------------- #
def align(us_returns: dict, tw_returns: dict, tw_dates: list) -> list:
    """把美股 D 日的報酬對上台股「D 之後第一個交易日」的報酬。

    回傳 [(台股日期, 美股報酬, 台股報酬)]，依台股日期排序。
    同一個台股交易日可能對上兩個美股日（台股放假），只留最後一個美股日——
    連假之後開盤反應的是最近的那一晚，不是更早那幾晚的合計。
    """
    picked = {}
    for date, value in us_returns.items():
        i = bisect_right(tw_dates, date)
        if i >= len(tw_dates):
            continue                   # 美股已經收了，台股還沒開那一天
        picked[tw_dates[i]] = (date, value)
    rows = []
    for tw_date, (_, us_value) in sorted(picked.items()):
        tw_value = tw_returns.get(tw_date)
        if tw_value is not None:
            rows.append((tw_date, us_value, tw_value))
    return rows


def pearson(xs: list, ys: list):
    """皮爾森相關係數。點數不夠或其中一邊完全不動就回 None。"""
    n = len(xs)
    if n < MIN_POINTS:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    sxy = sxx = syy = 0.0
    for x, y in zip(xs, ys):
        dx, dy = x - mx, y - my
        sxy += dx * dy
        sxx += dx * dx
        syy += dy * dy
    if sxx <= 0 or syy <= 0:
        return None
    return sxy / (sxx * syy) ** 0.5


def corr_pct(rows: list, span: int):
    """最近 span 個對齊日的相關係數，四捨五入成整數百分比。"""
    tail = rows[-span:]
    r = pearson([x for _, x, _ in tail], [y for _, _, y in tail])
    return None if r is None else round(r * 100)


# 滾動窗至少要湊得出這麼多個，那個「範圍」才講得出穩定度。
#
# 120 日窗在目前的 130 個交易日上只湊得出 11 個窗，而且彼此重疊九成以上 ——
# 那個範圍講的是同一段資料被切了 11 次，不是它在半年裡怎麼擺盪。寧可留白。
# kline 的歷史長出來之後，120 日窗會自己開始有數字，格式不必改。
MIN_WINDOWS = 20


def rolling_corr(rows: list, span: int) -> list:
    """滑動窗的相關係數序列，每次往後挪一個對齊日。

    用**滾動和**算，不是每個窗重跑一次 pearson()：後者是 O(n·span)，2,137 組配對
    乘三個觀察窗要跑好幾分鐘，而這是每天都要跑的建置步驟。這裡是 O(n)。

    日報酬的量級是 1e-2，滾動和的相消最多吃掉四、五位有效數字，float64 還剩十位以上，
    對一個四捨五入成整數百分比的結果綽綽有餘。
    """
    n = len(rows)
    if n < span + MIN_WINDOWS - 1:
        return []
    xs = [x for _, x, _ in rows]
    ys = [y for _, _, y in rows]
    sx = sy = sxy = sxx = syy = 0.0
    out = []
    for i in range(n):
        x, y = xs[i], ys[i]
        sx += x; sy += y; sxy += x * y; sxx += x * x; syy += y * y
        if i >= span:
            o, p = xs[i - span], ys[i - span]
            sx -= o; sy -= p; sxy -= o * p; sxx -= o * o; syy -= p * p
        if i >= span - 1:
            cov = sxy - sx * sy / span
            vx = sxx - sx * sx / span
            vy = syy - sy * sy / span
            out.append(None if vx <= 0 or vy <= 0 else cov / (vx * vy) ** 0.5)
    return out


def corr_range(rows: list, span: int):
    """滾動相關在整段資料裡的擺盪範圍 (最低, 最高)，整數百分比。

    回答的是「這個相關係數穩不穩」——同樣是 +50%，一路都在 40~60 之間，
    與半年前還是 −20%、最近才衝上來，是完全不同的兩件事，而單一個數字分不出來。
    窗數不夠就回 (None, None)。
    """
    vals = [v for v in rolling_corr(rows, span) if v is not None]
    if len(vals) < MIN_WINDOWS:
        return None, None
    return round(min(vals) * 100), round(max(vals) * 100)
