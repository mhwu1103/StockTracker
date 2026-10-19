"""抓台指期與台指選擇權的籌碼 → docs/data/futures.json（期貨頁、策略頁用）。

    python scripts/fetch_futures.py                       # 每日排程：期交所近 30 天
    python scripts/fetch_futures.py --history 2018-06-01  # 第一次回補（期交所，一個月一個月抓）
    python scripts/fetch_futures.py --finmind 2018-06-01  # 三大法人早於三年的那段（FinMind）

全部是期交所的 CSV 下載（POST，queryStartDate／queryEndDate，一次最多約一個月，Big5）：

| 區段 | 期交所 | 存什麼 |
|---|---|---|
| tx、mtx | futContractsDateDown（commodityId=TXF／MXF） | 三大法人未平倉淨口數 fo／tr／de。**只能查近三年**，更早的用 FinMind 回補 |
| mkt | futDataDown（commodity_id=TX／MTX） | 大台近月收盤 txc、結算 txs；大台、小台全部月份的未平倉合計 txoi、mtxoi（一般時段） |
| lt | largeTraderFutDown | 臺股期貨（期交所已把 TX＋MTX÷4＋TMF÷20 併成一個商品）所有月份合計：前五大／前十大交易人的買方、賣方部位 b5 s5 b10 s10，其中屬於特定法人的 pb5 ps5 pb10 ps10，全市場未沖銷 oi |
| fop | callsAndPutsDateDown（TXO） | 外資的台指選擇權：買權未平倉淨口數 cq 與淨金額 cv（億）、賣權 pq、pv。**只能查近三年**，更早的用 FinMind（TaiwanOptionInstitutionalInvestors） |
| opt | pcRatioDown、optDataDown（TXO） | 賣權／買權的成交量比 pcv 與未平倉比 pco（%）；最近一個月份契約（不含週選）未平倉最大的買權履約價 cw、賣權履約價 pw 與它們的口數 cwo、pwo |

格式：{"d": [日期…], "<區段>": {"<欄位>": [與 d 平行，缺的是 null]}}。

- 三大法人的 FinMind 回補（TaiwanFuturesInstitutionalInvestors，免金鑰）跟期交所重疊的 25 天逐筆一致
- 「近月」是到期月份最早、而且是月契約（六位數，不含週選 W／F 與價差）的那一個
- 選擇權的「關卡」只看最近的**月**契約：週選的未平倉小、天天換，拿來當支撐壓力會一直跳
"""

from __future__ import annotations

import argparse
import csv
import io
import re
import time
from collections import defaultdict
from datetime import date, timedelta

import requests

import twse

OUT = twse.DATA_DIR / "futures.json"
BASE = "https://www.taifex.com.tw/cht/3/"
FINMIND_URL = "https://api.finmindtrade.com/api/v4/data"
FIELDS = {
    "tx": ["fo", "tr", "de"], "mtx": ["fo", "tr", "de"],
    "mkt": ["txc", "txs", "txoi", "mtxoi"],
    "lt": ["b5", "s5", "b10", "s10", "pb5", "ps5", "pb10", "ps10", "oi"],
    "opt": ["pcv", "pco", "cw", "pw", "cwo", "pwo"],
    "fop": ["cq", "cv", "pq", "pv"],
}
WHO = {"外資及陸資": "fo", "外資": "fo", "投信": "tr", "自營商": "de"}
MONTHLY = re.compile(r"^\d{6}$")


# --------------------------------------------------------------------------- #
def load() -> dict:
    """{區段: {日期: {欄位: 值}}}"""
    got = {k: defaultdict(dict) for k in FIELDS}
    old = twse.read_json(OUT) if OUT.exists() else None
    if old:
        for k, fields in FIELDS.items():
            sec = old.get(k) or {}
            for i, d in enumerate(old["d"]):
                for w in fields:
                    v = (sec.get(w) or [None] * len(old["d"]))[i]
                    if v is not None:
                        got[k][d][w] = v
    return got


def save(got: dict) -> bool:
    days = sorted({d for k in got for d in got[k]})
    out = {"d": days}
    for k, fields in FIELDS.items():
        out[k] = {w: [got[k].get(d, {}).get(w) for d in days] for w in fields}
    return twse.write_if_changed(OUT, out)


def post(page: str, data: dict) -> list:
    """期交所 CSV → [[欄…]…]（第一列是表頭）；查不到（日期超出範圍、還沒出來）丟 RuntimeError。"""
    for k in range(4):                         # 期交所偶爾回 520，退一下再試
        try:
            r = requests.post(BASE + page, data=data, timeout=60, headers={"User-Agent": "Mozilla/5.0"})
            r.raise_for_status()
            break
        except requests.RequestException:
            if k == 3:
                raise
            time.sleep(10 * (k + 1))
    text = r.content.decode("big5-hkscs", errors="replace")
    if "DateTime error" in text or "<html" in text.lower()[:800]:
        raise RuntimeError(f"期交所 {page} 查不到：{data}")
    return [[c.strip() for c in row] for row in csv.reader(io.StringIO(text)) if row]


def col(head: list, name: str) -> int:
    for i, h in enumerate(head):
        if h.startswith(name):
            return i
    raise RuntimeError(f"期交所 CSV 找不到欄位「{name}」：{head}")


def num(s):
    v = twse.clean_number(s)
    return None if v is None else v


def iso(s: str) -> str:
    return s.replace("/", "-")


def span(start: date, end: date) -> dict:
    return {"queryStartDate": f"{start:%Y/%m/%d}", "queryEndDate": f"{end:%Y/%m/%d}"}


# --------------------------------------------------------------------------- #
def inst(code: str, start: date, end: date) -> dict:
    rows = post("futContractsDateDown", {**span(start, end), "commodityId": code})
    h = rows[0]
    i_d, i_who, i_net = col(h, "日期"), col(h, "身份別"), col(h, "多空未平倉口數淨額")
    out = defaultdict(dict)
    for r in rows[1:]:
        if len(r) > i_net and r[i_who] in WHO:
            out[iso(r[i_d])][WHO[r[i_who]]] = int(num(r[i_net]))
    return out


def market(start: date, end: date) -> dict:
    out = defaultdict(dict)
    for code in ("TX", "MTX"):
        rows = post("futDataDown", {**span(start, end), "down_type": "1", "commodity_id": code})
        h = rows[0]
        i_d, i_m, i_c, i_s, i_oi, i_ses = (col(h, "交易日期"), col(h, "到期月份"), col(h, "收盤價"),
                                           col(h, "結算價"), col(h, "未沖銷契約數"), col(h, "交易時段"))
        near, oi = {}, defaultdict(int)
        for r in rows[1:]:
            if len(r) <= i_ses or r[i_ses] != "一般" or not MONTHLY.match(r[i_m]):
                continue
            d = iso(r[i_d])
            v = num(r[i_oi])
            if v:
                oi[d] += int(v)
            if code == "TX" and (d not in near or r[i_m] < near[d][0]):
                near[d] = (r[i_m], num(r[i_c]), num(r[i_s]))
        for d, v in oi.items():
            out[d]["txoi" if code == "TX" else "mtxoi"] = v
        for d, (_, c, s) in near.items():
            if c:
                out[d]["txc"] = c
            if s:
                out[d]["txs"] = s
        time.sleep(1)
    return out


def large(start: date, end: date) -> dict:
    rows = post("largeTraderFutDown", span(start, end))
    h = rows[0]
    i_d, i_p, i_m, i_k = col(h, "日期"), col(h, "商品(契約)"), col(h, "到期月份"), col(h, "交易人類別")
    i_b5, i_s5, i_b10, i_s10, i_oi = (col(h, "前五大交易人買方"), col(h, "前五大交易人賣方"),
                                      col(h, "前十大交易人買方"), col(h, "前十大交易人賣方"), col(h, "全市場未沖銷"))
    out = defaultdict(dict)
    for r in rows[1:]:
        if len(r) <= i_oi or r[i_p] != "TX" or r[i_m] != "999999":
            continue
        pre = "p" if r[i_k] == "1" else ""
        d = iso(r[i_d])
        for key, i in (("b5", i_b5), ("s5", i_s5), ("b10", i_b10), ("s10", i_s10)):
            out[d][pre + key] = int(num(r[i]) or 0)
        out[d]["oi"] = int(num(r[i_oi]) or 0)
    return out


def options(start: date, end: date) -> dict:
    out = defaultdict(dict)
    rows = post("pcRatioDown", span(start, end))
    h = rows[0]
    i_d, i_v, i_o = col(h, "日期"), col(h, "買賣權成交量比率"), col(h, "買賣權未平倉量比率")
    for r in rows[1:]:
        if len(r) > i_o and re.match(r"\d+/\d+/\d+", r[i_d]):
            out[iso(r[i_d])].update(pcv=num(r[i_v]), pco=num(r[i_o]))
    time.sleep(1)
    rows = post("optDataDown", {**span(start, end), "down_type": "1", "commodity_id": "TXO"})
    h = rows[0]
    i_d, i_m, i_k, i_cp, i_oi, i_ses = (col(h, "交易日期"), col(h, "到期月份"), col(h, "履約價"), col(h, "買賣權"),
                                        col(h, "未沖銷契約數"), col(h, "交易時段"))
    book = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))     # 日期 → 月份 → (買賣, 履約價) → 口數
    for r in rows[1:]:
        if len(r) <= i_ses or r[i_ses] != "一般" or not MONTHLY.match(r[i_m]):
            continue
        v = num(r[i_oi])
        if v:
            book[iso(r[i_d])][r[i_m]][(r[i_cp], float(r[i_k]))] += int(v)
    for d, by_m in book.items():
        m = min(by_m)
        oi = by_m[m]
        for cp, k_strike, k_oi in (("買權", "cw", "cwo"), ("賣權", "pw", "pwo")):
            side = {k: v for (c, k), v in oi.items() if c == cp}
            if side:
                best = max(side, key=side.get)
                out[d][k_strike] = int(best)
                out[d][k_oi] = side[best]
    return out


def opt_inst(start: date, end: date) -> dict:
    """外資的台指選擇權買權、賣權未平倉淨口數與淨金額（千元 → 億）。"""
    rows = post("callsAndPutsDateDown", {**span(start, end), "commodityId": "TXO"})
    h = rows[0]
    i_d, i_cp, i_who = col(h, "日期"), col(h, "買賣權別"), col(h, "身份別")
    i_q, i_v = col(h, "未平倉口數買賣淨額"), col(h, "未平倉契約金額買賣淨額")
    out = defaultdict(dict)
    for r in rows[1:]:
        if len(r) > i_v and WHO.get(r[i_who]) == "fo" and r[i_cp] in ("CALL", "PUT"):
            k = "c" if r[i_cp] == "CALL" else "p"
            out[iso(r[i_d])][k + "q"] = int(num(r[i_q]))
            out[iso(r[i_d])][k + "v"] = round(num(r[i_v]) / 1e5, 2)
    return out


def finmind_opt(since: str, until: str) -> dict:
    r = requests.get(FINMIND_URL, params={"dataset": "TaiwanOptionInstitutionalInvestors", "data_id": "TXO",
                                          "start_date": since, "end_date": until}, timeout=60)
    r.raise_for_status()
    j = r.json()
    if j.get("status") != 200:
        raise RuntimeError(f"FinMind TXO：{j.get('msg')}")
    out = defaultdict(dict)
    for x in j["data"]:
        if WHO.get(x["institutional_investors"]) != "fo":
            continue
        k = "c" if x["call_put"] == "買權" else "p"
        out[x["date"]][k + "q"] = x["long_open_interest_balance_volume"] - x["short_open_interest_balance_volume"]
        out[x["date"]][k + "v"] = round((x["long_open_interest_balance_amount"]
                                         - x["short_open_interest_balance_amount"]) / 1e5, 2)
    return out


def finmind(code: str, since: str, until: str) -> dict:
    r = requests.get(FINMIND_URL, params={"dataset": "TaiwanFuturesInstitutionalInvestors", "data_id": code,
                                          "start_date": since, "end_date": until}, timeout=60)
    r.raise_for_status()
    j = r.json()
    if j.get("status") != 200:
        raise RuntimeError(f"FinMind {code}：{j.get('msg')}")
    out = defaultdict(dict)
    for x in j["data"]:
        w = WHO.get(x["institutional_investors"])
        if w:
            out[x["date"]][w] = x["long_open_interest_balance_volume"] - x["short_open_interest_balance_volume"]
    return out


# --------------------------------------------------------------------------- #
def tolerant(fn, start: date, end: date, sleep: float):
    """結束日比期交所最新一天還晚也會被當成 DateTime error（收盤前、連假），往前退幾天再試。"""
    for back in range(6):
        try:
            return fn(start, end - timedelta(days=back))
        except RuntimeError:
            if back == 5:
                raise
            time.sleep(sleep)


def merge(got, sec, new, label):
    for d, row in new.items():
        got[sec][d].update({k: v for k, v in row.items() if v is not None})
    print(f"  {label}：{len(new)} 天{'（' + min(new) + ' ～ ' + max(new) + '）' if new else ''}", flush=True)


def months(since: date, until: date):
    a = date(since.year, since.month, 1)
    while a <= until:
        b = (date(a.year + (a.month == 12), a.month % 12 + 1, 1) - timedelta(days=1))
        yield max(a, since), min(b, until)
        a = b + timedelta(days=1)


def main():
    ap = argparse.ArgumentParser(description="抓台指期與選擇權籌碼")
    ap.add_argument("--history", metavar="YYYY-MM-DD", help="從這一天起，一個月一個月回補期交所的資料")
    ap.add_argument("--finmind", metavar="YYYY-MM-DD", help="從這一天起用 FinMind 回補三大法人")
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--sleep", type=float, default=3.0)
    args = ap.parse_args()
    today = twse.taipei_today()
    got = load()
    jobs = [("mkt", market, "期貨行情"), ("lt", large, "大額交易人"), ("opt", options, "選擇權")]

    if args.finmind:
        for sec, code in (("tx", "TX"), ("mtx", "MTX")):
            merge(got, sec, finmind(code, args.finmind, today.isoformat()), f"FinMind 三大法人 {code}")
            time.sleep(args.sleep)
        merge(got, "fop", finmind_opt(args.finmind, today.isoformat()), "FinMind 外資選擇權")
    elif args.history:
        for a, b in months(date.fromisoformat(args.history), today):
            for sec, fn, label in jobs:
                try:
                    merge(got, sec, fn(a, b), f"{a:%Y-%m} {label}")
                except RuntimeError as err:
                    print(f"  ! {a:%Y-%m} {label}：{err}", flush=True)
                time.sleep(args.sleep)
            save(got)
    else:
        start = today - timedelta(days=args.days)
        for sec, code in (("tx", "TXF"), ("mtx", "MXF")):
            merge(got, sec, tolerant(lambda a, b: inst(code, a, b), start, today, args.sleep), f"三大法人 {code}")
            time.sleep(args.sleep)
        try:
            merge(got, "fop", tolerant(opt_inst, start, today, args.sleep), "外資選擇權")
        except RuntimeError as err:
            print(f"  ! 外資選擇權：{err}")
        time.sleep(args.sleep)
        for sec, fn, label in jobs:
            try:
                merge(got, sec, tolerant(fn, start, today, args.sleep), label)
            except RuntimeError as err:
                print(f"  ! {label}：{err}")
            time.sleep(args.sleep)
    changed = save(got)
    print(f"台指期籌碼：共 {len({d for k in got for d in got[k]})} 天{'' if changed else '，無變化'}")


if __name__ == "__main__":
    main()
