"""由 docs/data/daily/*.json 重建索引與歷史序列（純衍生檔，隨時可重算）。

產出：
    docs/data/index.json        全部交易日清單 + 每日大盤成交值
    docs/data/history/2026.json 該年度「個股 -> 每日 (名次, 成交值)」轉置表

用法：
    python scripts/build_history.py
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import datetime

import twse


def update_streaks(payload, day_index, date_iso, streaks) -> bool:
    """替當日前 200 名補上 streak／since 欄位，回傳檔案內容是否有變動。"""
    changed = False
    for stock in payload["stocks"]:
        if stock["rank"] <= twse.STREAK_RANK:
            prev = streaks.get(stock["code"])
            if prev and prev[2] == day_index - 1:      # 前一個交易日也在榜上
                count, since = prev[0] + 1, prev[1]
            else:
                count, since = 1, date_iso
            streaks[stock["code"]] = (count, since, day_index)
            fresh = {"streak": count, "since": since}
        else:
            fresh = {}

        if stock.get("streak") != fresh.get("streak") or stock.get("since") != fresh.get("since"):
            changed = True
            stock.pop("streak", None)
            stock.pop("since", None)
            stock.update(fresh)
    return changed


def main() -> int:
    dates = twse.existing_dates()
    if not dates:
        print("docs/data/daily/ 沒有任何資料，請先執行 fetch_daily.py 或 backfill.py")
        return 1

    market_values = []          # 以下三個陣列都與 dates 平行，單位：億元
    top200_values = []          # 當日前 200 名成交值合計（集中度的分子）
    top10_values = []
    by_year = defaultdict(lambda: {"dates": [], "stocks": {}})
    streaks = {}                # code -> (連續天數, 起算日, 最後一次進榜的日期序號)
    rewritten = 0

    for day_index, date_iso in enumerate(dates):
        payload = json.loads(twse.daily_path(date_iso).read_text(encoding="utf-8"))
        market_values.append(round(payload.get("marketValue", 0) / 1e8, 2))

        # 前 N 名成交值合計。除以大盤成交值就是「資金集中度」，
        # 用來看錢是集中在少數幾檔還是擴散開來。
        stocks = payload["stocks"]
        top200_values.append(round(sum(s["value"] for s in stocks if s["rank"] <= twse.STREAK_RANK) / 1e8, 2))
        top10_values.append(round(sum(s["value"] for s in stocks if s["rank"] <= 10) / 1e8, 2))

        # 連續進前 200 名的天數。整份資料每次都從頭重算，不必保存中間狀態；
        # 只有內容真的改變的檔案才會重寫，避免每天產生無謂的 git 差異。
        if update_streaks(payload, day_index, date_iso, streaks):
            twse.write_daily(payload)
            rewritten += 1

        year = date_iso[:4]
        bucket = by_year[year]
        bucket["dates"].append(date_iso)
        day_index = len(bucket["dates"]) - 1

        for stock in payload["stocks"]:
            entry = bucket["stocks"].get(stock["code"])
            if entry is None:
                entry = {"name": stock["name"], "p": []}
                bucket["stocks"][stock["code"]] = entry
            entry["name"] = stock["name"]  # 沿用最新名稱（公司可能改名）
            entry["p"].append([day_index, stock["rank"], round(stock["value"] / 1e8, 2)])

    twse.HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    for year, bucket in sorted(by_year.items()):
        path = twse.HISTORY_DIR / f"{year}.json"
        twse.write_json(path, {"year": int(year), **bucket})
        size_kb = path.stat().st_size / 1024
        print(f"  {year}.json：{len(bucket['dates'])} 個交易日、"
              f"{len(bucket['stocks'])} 檔曾進榜（{size_kb:,.0f} KB）")

    # 移除已無對應資料的年度檔
    valid = {f"{year}.json" for year in by_year}
    for stale in twse.HISTORY_DIR.glob("*.json"):
        if stale.name not in valid:
            stale.unlink()
            print(f"  移除過期檔案 {stale.name}")

    twse.write_json(
        twse.INDEX_PATH,
        {
            "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
            "latest": dates[-1],
            "years": sorted(by_year, reverse=True),
            "dates": dates,
            "marketValues": market_values,
            "top200Values": top200_values,
            "top10Values": top10_values,
        },
    )
    print(f"index.json：{len(dates)} 個交易日（{dates[0]} ~ {dates[-1]}）")
    if rewritten:
        print(f"連續進榜天數：更新了 {rewritten} 個每日檔")
    return 0


if __name__ == "__main__":
    sys.exit(main())
