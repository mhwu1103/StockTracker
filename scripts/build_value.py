"""價值頁的判斷：把每天的行情、本益比、月營收，照「逢低、看位階」的價值派規則轉成結論。

    python scripts/build_value.py      -> docs/data/value.json

## 這一頁的思維，拆成五組可以機械判斷的規則

這套規則來自一位台股存股／價值派作者一段期間的產業文與交易紀錄，這裡只留**方法**，
不留出處也不留文章。他看市場的前提只有一句：**台股長期往上、權值股帶著大盤走，所以大跌是
撿便宜的時候**。其餘都是從那一句推出來的：

1. **大盤：該不該撿**
   - 在高檔（離 60 日高點不到 3%）不追，等下跌。
   - 下跌就買一點、大跌多買一點；**股災那天不選股**，直接買市值型 ETF。
   - 永遠分批、永遠留現金：資金切成五份，離 60 日高點每多跌 5% 動用一份，最後一份不動。
   - **台積電下跌就是進場訊號**：它佔大盤四成，業績好的時候跌下來會有買盤。
   - 大盤在區間裡盤整時，**正 2 會被每日重設與複利磨耗**，預期盤整就不碰槓桿 ETF。

2. **題材：量價齊揚**
   他的產業文幾乎都是同一個寫法：哪裡在漲價、缺貨 → 往上下游找受惠股 → 看獲利成長 →
   再看本益比。這裡把「漲價、缺貨」換成兩個抓得到的訊號：
   - **量**：子族群月營收年增率的中位數（≥ 20% 叫量增，比上個月多 5 個百分點以上叫加速），
     以及有幾成公司營收創一年新高（他說「7 月營收全創新高」時就是這個）。
   - **價**：報價頁裡對到這個子族群的報價，近三個月漲跌的中位數（≥ 5% 叫價漲）。

3. **個股：本益比在它自己的哪一格**
   他幾乎只用一把尺：本益比跟**它自己的**歷史比，不跟別人比。做法照他用的那種 APP：
   近五年每一年各取最低、平均、最高本益比，五年平均起來當三道門檻：

       本益比 ≤ 平均最低        便宜
       本益比 ≤ 平均            相對便宜（「低於歷史平均，代表目前不貴」）
       本益比 <  平均最高        偏貴
       本益比 ≥ 平均最高        昂貴

   他看的是**法人預估明年**的本益比，這裡拿得到的只有近四季的。缺的那一段用營收補：
   他說「現在的昂貴可能是未來的便宜」，意思是獲利成長會把本益比壓下來。所以用近三個月
   營收年增率粗估「如果獲利跟營收同速成長，明年本益比大約多少」，偏貴或昂貴、但粗估值
   已經回到平均以下的，標成「成長消化得掉」。這是粗估，前端要寫明。
   虧損（沒有本益比）的不評價；歷史不滿三年的也不評價。
   反過來，**便宜的前提是業績沒問題**（他的原話是「業績沒問題、本益比 10 倍，物美價廉」）。
   本益比落在便宜或相對便宜、但近三個月營收平均是負成長的，標成 trap：那個低本益比多半是
   去年的獲利撐出來的，營收在退，下一季 EPS 一掉，本益比就不低了。
   金融股不做這個粗估：金控的月營收跟著投資損益大起大落，不是本業在成長，他看金融股
   本來也是用股淨比。營收年增超過一倍的也不做——那是景氣循環股的谷底反彈，不是趨勢。

4. **存股：不會倒、殖利率夠、股淨比不貴**
   - 金融股用**股淨比**看位階（他說那是比較保守的尺），門檻的算法同上。
   - 5% 殖利率價 = 現金股利 × 20。股價在它下面，殖利率就有 5%。
   - 官股銀行標出來：他往下攤平的前提永遠是「不會倒」。

5. **價差：KD 20／80，只用在不會歸零的東西上**
   日 K < 20 分批買、K 在 20～40 暫停加碼、K > 80 分批賣；日 K 已經低、週 K 也 < 20 的，
   是「續跌還可以再加碼」。名單只有原型 ETF（近 20 個交易日進過成交值前 300 名，不含債券、
   槓桿、反向）與金融股 —— 對一檔會下市的小型股用這條規則，就是往下攤平攤到歸零；
   槓桿與反向 ETF 長期會被磨耗，同樣不符合「不會歸零」的前提。

## 不做的

- 除息後貼息的撿便宜（沒有除權息日程的資料）。
- 他的資金分層（自有資金存股、借來的錢做價差）：那是使用者自己的事，紀律頁的門派管那個。
"""

from __future__ import annotations

import statistics
import sys
from collections import defaultdict
from datetime import date, datetime

import twse
import valuation

OUT_PATH = twse.DATA_DIR / "value.json"
MARKETS = ("twse", "tpex")

# ---- 大盤 ----
LOOKBACK = 60            # 高點、區間都看最近 60 個交易日（一季）
NEAR_HIGH = -3.0         # 離高點不到 3%：高檔，不追
DIP_DAY = -2.0           # 單日跌 2%：下跌，買一點
CRASH_DAY = -4.0         # 單日跌 4%：大跌，多買、不選股
TRANCHE_STEP = 5.0       # 離 60 日高點每多跌 5% 動用一份資金
TRANCHES = 5             # 資金分五份，最後一份不動 → 最多動用四份
TSMC = "2330"
TSMC_DD = -10.0          # 台積電離 60 日高點跌 10%
TSMC_DAY = -3.0          # 或單日跌 3%
BOX_RANGE = 12.0         # 60 日高低差在 12% 以內算盤整（他舉的例子是 4.3 萬～4.7 萬，約 9%）

# ---- 題材 ----
VOL_UP = 20.0            # 子族群營收年增中位數 ≥ 20%：量增
VOL_ACCEL = 5.0          # 比上個月的中位數多 5 個百分點：加速
HIGH_SHARE = 0.5         # 過半公司營收創一年新高
PRICE_UP = 5.0           # 報價近三個月中位數 ≥ 5%：價漲

# ---- 估值 ----
BAND_YEARS = 5
MIN_YEARS = 3            # 至少三年的區間才評價
MIN_SAMPLES = 6          # 一年至少六個月底有本益比，那一年才算數
PE_MAX = 150             # 本益比超過這個，是獲利接近零時的雜訊，不當成區間的一部分
GROWTH_MIN = 10.0        # 近三月營收年增 ≥ 10% 才拿來粗估明年本益比
GROWTH_MAX = 100.0       # 超過一倍的不拿來粗估：那是景氣循環的谷底反彈（記憶體年增六七倍），
                         # 用它把本益比除下去會得到「明年 2.5 倍」這種數字

# ---- 存股 ----
FIN_INDUSTRY = "金融保險"
YIELD_PRICE = 20         # 5% 殖利率價 = 現金股利 × 20
STATE_BANKS = {"2801", "2834", "2880", "2886", "2892", "5880"}  # 彰銀、臺企銀、華南金、兆豐金、第一金、合庫金

# ---- KD ----
KD_N = 9
KD_LOW, KD_PAUSE, KD_HIGH = 20, 40, 80
ETF_RANK_DAYS = 20


def median(values):
    vals = [v for v in values if v is not None]
    return round(statistics.median(vals), 2) if vals else None


def pct(a, b):
    return round((a / b - 1) * 100, 2) if a is not None and b else None


# --------------------------------------------------------------------------- #
# 讀資料
# --------------------------------------------------------------------------- #
def load_bars():
    """close/ 兩個市場併起來：由舊到新的日期、{代號: {日期: (開, 高, 低, 收)}}。"""
    bars = defaultdict(dict)
    dates = set()
    for market in MARKETS:
        for d in twse.existing_close_dates(market):
            payload = twse.read_json(twse.close_path(d, market)) or {}
            c, h, lo = payload.get("c") or {}, payload.get("h") or {}, payload.get("l") or {}
            if c:
                dates.add(d)
            for code, close in c.items():
                if close is None:
                    continue
                bars[code][d] = (h.get(code) or close, lo.get(code) or close, close)
    return sorted(dates), bars


def load_pe_history():
    """{市場: [(月份, 日期, {代號: [本益比, 殖利率, 股淨比]})…]}，由舊到新。"""
    out = {}
    for market in MARKETS:
        rows = []
        folder = valuation.PE_DIR / market
        for path in sorted(folder.glob("*.json")) if folder.exists() else []:
            payload = twse.read_json(path)
            rows.append((path.stem, payload["d"], payload["c"]))
        out[market] = rows
    return out


def load_revenue():
    """由舊到新的 [(月份, {代號: [營收, 年增率]})]。"""
    folder = valuation.REV_DIR
    return [(p.stem, twse.read_json(p)) for p in sorted(folder.glob("*.json"))] if folder.exists() else []


def load_names():
    """代號 -> 名稱。個股用 industry.json；ETF 只出現在排行檔裡，從最近的 daily/ 補。"""
    names = dict((twse.read_json(twse.DATA_DIR / "industry.json") or {}).get("names") or {})
    ranked = defaultdict(int)
    days = twse.existing_dates("all")[-ETF_RANK_DAYS:]
    for d in days:
        for s in (twse.read_json(twse.daily_path(d, "all")) or {}).get("stocks") or []:
            names.setdefault(s["code"], s["name"])
            ranked[s["code"]] += 1
    return names, ranked


# --------------------------------------------------------------------------- #
# 1. 大盤
# --------------------------------------------------------------------------- #
def series_stats(closes: list) -> dict:
    """一條收盤序列（由舊到新）的：最新、單日漲跌、60 日高低、回檔、區間寬度。"""
    win = closes[-LOOKBACK:]
    last = win[-1]
    hi, lo = max(win), min(win)
    return {
        "c": last,
        "chg": pct(last, closes[-2]) if len(closes) > 1 else None,
        "hi": hi,
        "lo": lo,
        "dd": pct(last, hi),
        "range": pct(hi, lo),
        "n": len(win),
    }


def market_view(taiex: dict, bars: dict, dates: list) -> dict:
    days = sorted(taiex)
    tx = series_stats([taiex[d] for d in days])
    tx["d"] = days[-1]
    ts_days = [d for d in dates if d in bars.get(TSMC, {})]
    ts = series_stats([bars[TSMC][d][2] for d in ts_days]) if ts_days else None

    # 動用幾份：離高點每多跌 TRANCHE_STEP% 一份，最多 TRANCHES - 1 份
    used = min(TRANCHES - 1, int(-(tx["dd"] or 0) // TRANCHE_STEP))

    if tx["chg"] is not None and tx["chg"] <= CRASH_DAY:
        stance = "crash"      # 大跌：多買，不選股，買市值型 ETF
    elif (tx["chg"] is not None and tx["chg"] <= DIP_DAY) or used > 0:
        stance = "dip"        # 下跌：買一點
    elif tx["dd"] is not None and tx["dd"] > NEAR_HIGH:
        stance = "high"       # 高檔：等下跌，別追
    else:
        stance = "wait"       # 不在高檔也還沒跌到第一份

    tsmc_signal = bool(ts and ((ts["dd"] is not None and ts["dd"] <= TSMC_DD)
                               or (ts["chg"] is not None and ts["chg"] <= TSMC_DAY)))
    box = tx["n"] >= LOOKBACK and tx["range"] is not None and tx["range"] <= BOX_RANGE

    return {
        "taiex": tx,
        "tsmc": ts,
        "stance": stance,
        "tranches": {"used": used, "total": TRANCHES, "step": TRANCHE_STEP,
                     "levels": [round(tx["hi"] * (1 - TRANCHE_STEP * k / 100)) for k in range(1, TRANCHES)]},
        "tsmcSignal": tsmc_signal,
        "box": box,
        "rules": {"nearHigh": NEAR_HIGH, "dipDay": DIP_DAY, "crashDay": CRASH_DAY,
                  "tsmcDd": TSMC_DD, "tsmcDay": TSMC_DAY, "boxRange": BOX_RANGE, "lookback": LOOKBACK},
    }


# --------------------------------------------------------------------------- #
# 3. 本益比／股淨比區間
# --------------------------------------------------------------------------- #
def band(samples: list):
    """[(月份, 值)] 由舊到新 -> {lo, avg, hi, years}；年數不夠回 None。

    「一年」是從最新月份往回切的 12 個月窗，不是日曆年：九月看的時候，日曆年的今年
    只有九個點，前一年卻有十二個，兩者不該等權平均。
    """
    vals = [v for _, v in samples]
    years = []
    for k in range(BAND_YEARS):
        end = len(vals) - 12 * k
        # 序列不夠長時 end 會變成負數，而 vals[0:-6] 在 Python 裡是「去掉最後六個」——
        # 那會憑空多出一年，而且跟前一年重疊。短歷史的股票就這樣被評了價
        if end <= 0:
            break
        chunk = [v for v in vals[max(0, end - 12):end] if v is not None]
        if len(chunk) >= MIN_SAMPLES:
            years.append((min(chunk), statistics.mean(chunk), max(chunk)))
    if len(years) < MIN_YEARS:
        return None
    return {
        "lo": round(statistics.mean(y[0] for y in years), 2),
        "avg": round(statistics.mean(y[1] for y in years), 2),
        "hi": round(statistics.mean(y[2] for y in years), 2),
        "years": len(years),
    }


def level(value, b):
    if value is None or not b:
        return None
    if value <= b["lo"]:
        return "cheap"
    if value <= b["avg"]:
        return "below"
    if value < b["hi"]:
        return "above"
    return "pricey"


# --------------------------------------------------------------------------- #
# 5. KD
# --------------------------------------------------------------------------- #
def kd(bars_seq: list):
    """[(高, 低, 收)] 由舊到新 -> (K, D)；不滿 KD_N 根回 (None, None)。起始值 50，台股慣例。"""
    if len(bars_seq) < KD_N:
        return None, None
    k = d = 50.0
    for i in range(KD_N - 1, len(bars_seq)):
        win = bars_seq[i - KD_N + 1:i + 1]
        hi, lo = max(b[0] for b in win), min(b[1] for b in win)
        rsv = 50.0 if hi == lo else (bars_seq[i][2] - lo) / (hi - lo) * 100
        k = k * 2 / 3 + rsv / 3
        d = d * 2 / 3 + k / 3
    return round(k, 1), round(d, 1)


def weekly(days: list, series: dict) -> list:
    """日線併成週線（ISO 週）：[(週高, 週低, 週收)]。"""
    weeks = {}
    for d in days:
        if d not in series:
            continue
        y, w, _ = date.fromisoformat(d).isocalendar()
        h, lo, c = series[d]
        if (y, w) in weeks:
            ph, pl, _ = weeks[(y, w)]
            weeks[(y, w)] = (max(ph, h), min(pl, lo), c)
        else:
            weeks[(y, w)] = (h, lo, c)
    return [weeks[k] for k in sorted(weeks)]


def kd_signal(k, wk):
    if k is None:
        return None
    if k < KD_LOW:
        return "addmore" if wk is not None and wk < KD_LOW else "buy"
    if k > KD_HIGH:
        return "sell"
    if k < KD_PAUSE:
        return "pause"
    return None


# --------------------------------------------------------------------------- #
def main() -> int:
    dates, bars = load_bars()
    taiex_doc = twse.read_json(twse.DATA_DIR / "taiex.json") or {}
    taiex = dict(zip(taiex_doc.get("d") or [], taiex_doc.get("c") or []))
    if not dates or not taiex:
        print("! close/ 或 taiex.json 是空的")
        return 1
    last = dates[-1]
    pe_hist = load_pe_history()
    revenue = load_revenue()
    names, ranked = load_names()
    industry = (twse.read_json(twse.DATA_DIR / "industry.json") or {}).get("map") or {}
    themes = twse.read_json(twse.DATA_DIR / "themes.json") or {"groups": []}
    quotes = (twse.read_json(twse.DATA_DIR / "quotes" / "index.json") or {}).get("items") or []

    if not any(pe_hist.values()):
        print("! value/pe/ 是空的，先跑 python scripts/fetch_value.py --pe-months 61 --rev-months 14")
        return 1

    # ---- 每一檔的本益比、股淨比序列 ----
    pe_series, pb_series, now = defaultdict(list), defaultdict(list), {}
    pe_asof = None
    for market, rows in pe_hist.items():
        for month, day, table in rows:
            for code, (pe, yld, pb, *_) in table.items():   # 第四欄是收盤價，回測才用
                pe_series[code].append((month, pe if pe and 0 < pe <= PE_MAX else None))
                pb_series[code].append((month, pb if pb and pb > 0 else None))
        if rows:
            m, d, table = rows[-1]
            pe_asof = max(pe_asof or d, d)
            for code, vals in table.items():
                now[code] = vals

    # ---- 月營收 ----
    rev_months = [m for m, _ in revenue]
    rev_latest = rev_months[-1] if rev_months else None

    def rev_stats(code):
        seq = [(m, t.get(code)) for m, t in revenue]
        seq = [(m, v) for m, v in seq if v]
        if not seq or seq[-1][0] != rev_latest:
            return None
        yoys = [v[1] for _, v in seq]
        last3 = [y for y in yoys[-3:] if y is not None]
        prev12 = [v[0] for _, v in seq[-12:-1]]
        return {
            "yoy": yoys[-1],
            "yoyPrev": yoys[-2] if len(yoys) > 1 else None,
            "yoy3": round(statistics.mean(last3), 1) if len(last3) == 3 else None,
            "high": bool(len(prev12) >= 11 and seq[-1][1][0] >= max(prev12)),
        }

    # ---- 題材 ----
    sub_of = defaultdict(list)            # 代號 -> [[族群, 子族群]…]
    for g in themes["groups"]:
        for s in g["subs"]:
            for code in s["codes"]:
                sub_of[code].append([g["name"], s["name"]])
    quote_by_sub = defaultdict(list)
    for q in quotes:
        m3 = (q.get("chg") or {}).get("m3")
        for g, s in q.get("themes") or []:
            if m3 is not None:
                quote_by_sub[(g, s)].append({"name": q.get("name"), "table": q.get("table"), "m3": m3})

    # ---- 個股表：題材成分股 ∪ 金融股 ----
    universe = set(sub_of) | {c for c, ind in industry.items() if ind == FIN_INDUSTRY}
    stocks = {}
    for code in sorted(universe):
        pe, yld, pb = (now.get(code) or (None, None, None))[:3]
        series = bars.get(code) or {}
        price = series.get(last, (None, None, None))[2]
        pe_band = band(pe_series.get(code, []))
        pb_band = band(pb_series.get(code, []))
        rev = rev_stats(code)
        pe_lv = level(pe if pe and pe <= PE_MAX else None, pe_band)
        fwd = None
        if (pe and pe <= PE_MAX and rev and rev["yoy3"] is not None and GROWTH_MIN <= rev["yoy3"] <= GROWTH_MAX
                and industry.get(code) != FIN_INDUSTRY):
            fwd = round(pe / (1 + rev["yoy3"] / 100), 1)
        div = round(yld * price / 100, 2) if yld and price else None
        stocks[code] = {
            "n": names.get(code),
            "ind": industry.get(code),
            "subs": sub_of.get(code, []),
            "price": price,
            "pe": pe, "peBand": pe_band, "peLv": pe_lv,
            "fwd": fwd,
            "digest": bool(pe_lv in ("above", "pricey") and fwd and pe_band and fwd <= pe_band["avg"]),
            "trap": bool(pe_lv in ("cheap", "below") and rev and rev["yoy3"] is not None and rev["yoy3"] < 0),
            "yld": yld, "div": div,
            "yldPrice": round(div * YIELD_PRICE, 2) if div else None,
            "pb": pb, "pbBand": pb_band, "pbLv": level(pb, pb_band),
            "rev": rev,
            "state": code in STATE_BANKS,
        }

    theme_rows = []
    for g in themes["groups"]:
        for s in g["subs"]:
            members = [stocks[c] for c in s["codes"] if c in stocks]
            revs = [m["rev"] for m in members if m["rev"]]
            q = quote_by_sub.get((g["name"], s["name"]), [])
            row = {
                "g": g["name"], "s": s["name"], "codes": s["codes"],
                "revN": len(revs),
                "yoy": median(r["yoy"] for r in revs),
                "yoyPrev": median(r["yoyPrev"] for r in revs),
                "high": sum(1 for r in revs if r["high"]),
                "quotes": len(q),
                "qm3": median(x["m3"] for x in q),
                "lv": {k: sum(1 for m in members if m["peLv"] == k) for k in ("cheap", "below", "above", "pricey")},
                "digest": sum(1 for m in members if m["digest"]),
            }
            tags = []
            if row["yoy"] is not None and row["yoy"] >= VOL_UP:
                tags.append("vol")
            if row["yoy"] is not None and row["yoyPrev"] is not None and row["yoy"] - row["yoyPrev"] >= VOL_ACCEL:
                tags.append("accel")
            if row["revN"] and row["high"] / row["revN"] >= HIGH_SHARE:
                tags.append("high")
            if row["qm3"] is not None and row["qm3"] >= PRICE_UP:
                tags.append("price")
            row["tags"] = tags
            theme_rows.append(row)
    # 量價齊揚的排最前，再來照營收年增中位數
    score = lambda r: (("vol" in r["tags"]) + ("price" in r["tags"]) + ("high" in r["tags"]) + ("accel" in r["tags"]))
    theme_rows.sort(key=lambda r: (score(r), r["yoy"] if r["yoy"] is not None else -999), reverse=True)

    # ---- KD ----
    # 訊號只給「不會歸零」的名單：原型 ETF（債券 B、槓桿 L、反向 R 都不算）與金融股。
    # 其他個股也算 K、D 值，搜尋時看得到，但不給買賣訊號——那條規則的前提它們不符合。
    kd_codes = {c for c in ranked if c.startswith("00") and c[-1] not in "BLR"}
    kd_codes |= {c for c, ind in industry.items() if ind == FIN_INDUSTRY}

    def kd_of(code):
        series = bars.get(code) or {}
        days = [d for d in dates if d in series]
        if not days or days[-1] != last:
            return None
        k, dd = kd([series[d] for d in days])
        wk, _ = kd(weekly(days, series))
        if k is None:
            return None
        return {"k": k, "d": dd, "wk": wk,
                "sig": kd_signal(k, wk) if code in kd_codes else None,
                "price": series[last][2]}

    for code, row in stocks.items():
        row["kd"] = kd_of(code)

    # 名單上、但不在個股表裡的 ETF：只有名稱、價格與 KD，給價差頁與搜尋用
    etfs = {}
    for code in sorted(kd_codes - set(stocks)):
        got = kd_of(code)
        if got:
            etfs[code] = {"n": names.get(code), **got}

    kd_rows = []
    for code in sorted(kd_codes):
        got = (stocks.get(code) or {}).get("kd") if code in stocks else etfs.get(code)
        if got and got["sig"]:
            kd_rows.append({"c": code, "n": names.get(code), "etf": code.startswith("00"),
                            "price": got["price"], "k": got["k"], "d": got["d"], "wk": got["wk"],
                            "sig": got["sig"]})
    kd_rows.sort(key=lambda r: r["k"])

    mv = market_view(taiex, bars, dates)
    twse.write_json(OUT_PATH, {
        "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "asof": last,
        "peAsof": pe_asof,
        "revMonth": rev_latest,
        "peSince": min((rows[0][0] for rows in pe_hist.values() if rows), default=None),
        "market": mv,
        "themes": theme_rows,
        "stocks": stocks,
        "etfs": etfs,
        "kd": kd_rows,
        "rules": {
            "volUp": VOL_UP, "volAccel": VOL_ACCEL, "highShare": HIGH_SHARE, "priceUp": PRICE_UP,
            "bandYears": BAND_YEARS, "minYears": MIN_YEARS, "growthMin": GROWTH_MIN,
            "growthMax": GROWTH_MAX,
            "peMax": PE_MAX,
            "kdLow": KD_LOW, "kdPause": KD_PAUSE, "kdHigh": KD_HIGH, "yieldPrice": YIELD_PRICE,
        },
    })

    lv = defaultdict(int)
    for s in stocks.values():
        lv[s["peLv"]] += 1
    tx = mv["taiex"]
    print(f"收盤到 {last}、本益比到 {pe_asof}、營收到 {rev_latest} -> {OUT_PATH.relative_to(twse.ROOT)}")
    print(f"  大盤 {tx['c']}（{tx['chg']}%，離 60 日高點 {tx['dd']}%）→ {mv['stance']}，"
          f"動用 {mv['tranches']['used']}/{TRANCHES} 份；台積電訊號 {mv['tsmcSignal']}；盤整 {mv['box']}")
    print(f"  個股 {len(stocks)} 檔：" + "、".join(f"{k} {v}" for k, v in lv.items()))
    print(f"  量價齊揚的子族群：" + "、".join(r["s"] for r in theme_rows if {"vol", "price"} <= set(r["tags"])))
    print(f"  KD 訊號 {len(kd_rows)} 檔")
    return 0


if __name__ == "__main__":
    sys.exit(main())
