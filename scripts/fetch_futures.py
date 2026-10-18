"""抓台指期（大台 TX、小台 MTX）三大法人的未平倉淨口數 → docs/data/futures.json。

    python scripts/fetch_futures.py                  # 每日排程：期交所近 40 天
    python scripts/fetch_futures.py --finmind 2018-06-01   # 第一次回補

- **每日**：期交所「三大法人－依商品分類」的 CSV 下載
  （https://www.taifex.com.tw/cht/3/futContractsDateDown，POST queryStartDate／queryEndDate／commodityId），
  一次查一段期間；**只能查近三年**，再早會回「DateTime error」
- **回補**：期交所查不到的那一段用 FinMind 的公開 API（TaiwanFuturesInstitutionalInvestors，2018-06 起、
  免金鑰）。2026-09-01 的外資大台淨未平倉兩邊都是 −78,706 口，逐筆核對過
- 存的是**未平倉淨口數**（多方未平倉 − 空方未平倉），三個身份各一條：外資（含陸資）、投信、自營商。
  小台一口是大台的四分之一，要合起來看就是大台 ＋ 小台 ÷ 4（「約當大台」）

格式：{"d": [日期…], "tx": {"fo": […], "tr": […], "de": […]}, "mtx": {同上}}，與 d 平行；
某天某商品缺資料就是 null。
"""

from __future__ import annotations

import argparse
import csv
import io
import time
from datetime import timedelta

import requests

import twse

OUT = twse.DATA_DIR / "futures.json"
TAIFEX_URL = "https://www.taifex.com.tw/cht/3/futContractsDateDown"
FINMIND_URL = "https://api.finmindtrade.com/api/v4/data"
PRODUCTS = {"tx": ("TXF", "TX"), "mtx": ("MXF", "MTX")}        # 期交所代號、FinMind 代號
WHO = {"外資及陸資": "fo", "外資": "fo", "投信": "tr", "自營商": "de"}


def load() -> dict:
    """{商品: {日期: {身份: 淨口數}}}"""
    got = {k: {} for k in PRODUCTS}
    old = twse.read_json(OUT) if OUT.exists() else None
    if old:
        for k in PRODUCTS:
            sec = old.get(k) or {}
            for i, d in enumerate(old["d"]):
                row = {w: sec[w][i] for w in ("fo", "tr", "de") if sec.get(w) and sec[w][i] is not None}
                if row:
                    got[k][d] = row
    return got


def save(got: dict) -> bool:
    days = sorted({d for k in got for d in got[k]})
    out = {"d": days}
    for k in PRODUCTS:
        out[k] = {w: [got[k].get(d, {}).get(w) for d in days] for w in ("fo", "tr", "de")}
    return twse.write_if_changed(OUT, out)


def taifex(code: str, start, end) -> dict:
    """{日期: {身份: 淨口數}}；欄位用名稱找，對不上就整份不要。"""
    r = requests.post(TAIFEX_URL, data={"queryStartDate": f"{start:%Y/%m/%d}", "queryEndDate": f"{end:%Y/%m/%d}",
                                        "commodityId": code}, timeout=30)
    r.raise_for_status()
    text = r.content.decode("big5-hkscs", errors="replace")
    if "DateTime error" in text or "<html" in text.lower()[:500]:
        raise RuntimeError(f"期交所 {code} {start}～{end} 查不到（只能查近三年）")
    rows = list(csv.reader(io.StringIO(text)))
    head = [h.strip() for h in rows[0]]
    try:
        i_d, i_who, i_net = head.index("日期"), head.index("身份別"), head.index("多空未平倉口數淨額")
    except ValueError:
        raise RuntimeError(f"期交所 CSV 欄位變了：{head}")
    out = {}
    for r_ in rows[1:]:
        if len(r_) <= i_net or r_[i_who].strip() not in WHO:
            continue
        d = r_[i_d].strip().replace("/", "-")
        out.setdefault(d, {})[WHO[r_[i_who].strip()]] = int(twse.clean_number(r_[i_net]))
    return out


def finmind(code: str, since: str, until: str) -> dict:
    r = requests.get(FINMIND_URL, params={"dataset": "TaiwanFuturesInstitutionalInvestors", "data_id": code,
                                          "start_date": since, "end_date": until}, timeout=60)
    r.raise_for_status()
    j = r.json()
    if j.get("status") != 200:
        raise RuntimeError(f"FinMind {code}：{j.get('msg')}")
    out = {}
    for x in j["data"]:
        w = WHO.get(x["institutional_investors"])
        if w:
            out.setdefault(x["date"], {})[w] = (x["long_open_interest_balance_volume"]
                                                - x["short_open_interest_balance_volume"])
    return out


def main():
    ap = argparse.ArgumentParser(description="抓台指期三大法人未平倉")
    ap.add_argument("--finmind", metavar="YYYY-MM-DD", help="從這一天起用 FinMind 回補")
    ap.add_argument("--days", type=int, default=40, help="期交所往回抓幾天（預設 40）")
    ap.add_argument("--sleep", type=float, default=3.0)
    args = ap.parse_args()
    today = twse.taipei_today()
    got = load()
    for k, (tf, fm) in PRODUCTS.items():
        if args.finmind:
            new = finmind(fm, args.finmind, today.isoformat())
        else:
            # 結束日比期交所最新一天還晚也會被當成「DateTime error」（例如收盤前、或連假），往前退幾天再試
            for back in range(0, 6):
                try:
                    new = taifex(tf, today - timedelta(days=args.days), today - timedelta(days=back))
                    break
                except RuntimeError:
                    if back == 5:
                        raise
                    time.sleep(args.sleep)
        for d, row in new.items():
            got[k][d] = row
        print(f"  {k}：{len(new)} 天（{min(new) if new else '—'} ～ {max(new) if new else '—'}）")
        time.sleep(args.sleep)
    changed = save(got)
    print(f"台指期法人未平倉：共 {len({d for k in got for d in got[k]})} 天{'' if changed else '，無變化'}")


if __name__ == "__main__":
    main()
