"""抓當日的上游報價與原物料行情。

TrendForce 的五個免費價格頁 -> docs/data/quotes/daily/YYYY-MM-DD.json（當日快照）
Yahoo Finance 的金屬／能源／指數 -> docs/data/quotes/market.json（完整序列，覆寫）

同一天重跑不會把先前抓到的東西弄丟：快照是「合併」進去的。某個品類今天掛掉、
明天好了，缺的那一天就是缺的那一天，不會連帶把好的那幾類也弄成空的。

用法：
    python scripts/fetch_quotes.py
    python scripts/fetch_quotes.py --skip-market      只抓 TrendForce
    python scripts/fetch_quotes.py --skip-trendforce  只抓 Yahoo
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime

import quotes
import twse


def fetch_trendforce(date_iso: str) -> int:
    """抓五個品類寫成當日快照，回傳成功的品類數。"""
    tables = {}
    failed = []
    for cat_spec in quotes.TF_CATS:
        cat = cat_spec["cat"]
        try:
            got = quotes.fetch_tf_cat(cat_spec)
        except RuntimeError as err:
            print(f"  ! {quotes.CAT_NAMES[cat]}：抓取失敗 —— {err}")
            failed.append(cat)
            continue
        if not got:
            print(f"  ! {quotes.CAT_NAMES[cat]}：頁面抓到了但一張表都沒解出來（版面可能改了）")
            failed.append(cat)
            continue
        rows = sum(len(t["rows"]) for t in got.values())
        print(f"  {quotes.CAT_NAMES[cat]}：{len(got)} 張表、{rows} 個品項")
        tables.update(got)
        time.sleep(1.5)     # 免費頁，別打太急

    if not tables:
        return 0

    payload = quotes.build_snapshot(tables, source="live")
    path = quotes.snapshot_path(date_iso)

    # 一份快照 110 個品項、十幾 KB，但一天只有現貨那幾張表會動。
    # 內容跟上一份一字不差就不要再存一份 —— 假日與沒更新的日子全是重複的檔案。
    if not path.exists() and same_as_previous(payload, date_iso):
        print("  內容與上一份快照完全相同（可能今天沒有任何表更新），不另存一份")
        return len(quotes.TF_CATS) - len(failed)

    # 同一天重跑就合併：這次沒抓到的品類沿用先前那一份，不要把它洗掉
    if path.exists():
        old = quotes.read_json(path)
        merged_tables = dict(old.get("tables") or {})
        merged_items = dict(old.get("items") or {})
        merged_tables.update(payload["tables"])
        merged_items.update(payload["items"])
        payload["tables"] = dict(sorted(merged_tables.items()))
        payload["items"] = dict(sorted(merged_items.items()))

    quotes.write_json(path, payload)
    print(f"  已寫入 {path.relative_to(twse.ROOT)}"
          f"（{len(payload['tables'])} 張表、{len(payload['items'])} 個品項）")
    return len(quotes.TF_CATS) - len(failed)


def same_as_previous(payload: dict, date_iso: str) -> bool:
    """這份快照跟最近一份已存的快照是不是一模一樣（報價日與每個數字都相同）。"""
    earlier = [d for d in quotes.snapshot_dates() if d < date_iso]
    if not earlier:
        return False
    old = quotes.read_json(quotes.snapshot_path(earlier[-1]))
    asofs = {k: (v or {}).get("asof") for k, v in (old.get("tables") or {}).items()}
    mine = {k: (v or {}).get("asof") for k, v in payload["tables"].items()}
    return asofs == mine and (old.get("items") or {}) == payload["items"]


def fetch_market() -> int:
    """抓 Yahoo 的金屬／能源／指數，整份覆寫 market.json。"""
    out = {"updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"), "items": {}}
    ok = 0
    for item in quotes.YAHOO_ITEMS:
        try:
            points = quotes.fetch_yahoo(item["sym"])
        except Exception as err:
            print(f"  ! {item['name']}（{item['sym']}）：抓取失敗 —— {err}")
            continue
        if not points:
            print(f"  ! {item['name']}（{item['sym']}）：沒有任何收盤價")
            continue
        out["items"][item["id"]] = {
            "sym": item["sym"],
            "d": [p[0] for p in points],
            "v": [p[1] for p in points],
        }
        ok += 1
        print(f"  {item['name']}：{len(points)} 個交易日（{points[0][0]} ~ {points[-1][0]}），"
              f"最新 {points[-1][1]:,.4g}")
        time.sleep(0.6)

    if not ok:
        return 0

    # 整份覆寫的前提是「這次抓到的比上次多」；抓到一半就覆寫會讓已有的序列不見
    if quotes.MARKET_PATH.exists():
        old = quotes.read_json(quotes.MARKET_PATH)
        for key, series in (old.get("items") or {}).items():
            if key not in out["items"]:
                out["items"][key] = series
                print(f"  · {key} 這次沒抓到，沿用先前那一份（{len(series['d'])} 天）")

    quotes.write_json(quotes.MARKET_PATH, out)
    print(f"  已寫入 {quotes.MARKET_PATH.relative_to(twse.ROOT)}（{len(out['items'])} 條序列）")
    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description="抓上游報價與原物料行情")
    parser.add_argument("--skip-trendforce", action="store_true", help="不抓 TrendForce")
    parser.add_argument("--skip-market", action="store_true", help="不抓 Yahoo")
    args = parser.parse_args()

    date_iso = twse.taipei_today().isoformat()
    tf_ok = market_ok = -1

    if not args.skip_trendforce:
        print(f"TrendForce（{date_iso} 快照）")
        tf_ok = fetch_trendforce(date_iso)
    if not args.skip_market:
        print("Yahoo Finance（原物料與指數）")
        market_ok = fetch_market()

    if tf_ok == 0 and market_ok in (0, -1):
        print("\n兩邊都沒抓到東西，不往下走。")
        return 1
    print("\n接著執行：python scripts/build_quotes.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
