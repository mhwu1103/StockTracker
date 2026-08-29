"""由 docs/data/daily/{twse,tpex}/*.json 重建三種範圍的索引與歷史序列。

範圍（scope）：
    twse  上市      抓取端直接產生
    tpex  上櫃      抓取端直接產生
    all   全部      在這裡由上市＋上櫃合併算出來

合併後的名次一定算得準：某檔若排得進合併後的前 300 名，它在自己市場裡的名次
必然也在前 300 名內，所以只用兩邊各自的前 300 名就足以還原正確的合併排行。

產出（全部是純衍生檔，隨時可重算）：
    docs/data/daily/all/YYYY-MM-DD.json    合併後的排行
    docs/data/index.json                   交易日清單 + 三種範圍的每日成交值
    docs/data/history/{scope}/YYYY.json     該範圍「個股 -> 每日 (名次, 成交值)」轉置表

用法：
    python scripts/build_history.py
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import datetime

import twse

# 合併排行時要保留的欄位；名次與連續進榜天數都會重算，不能沿用來源市場的
RECORD_FIELDS = ("code", "name", "value", "volume", "close", "changePct")


def load_day(date_iso: str, scope: str):
    path = twse.daily_path(date_iso, scope)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def merge_day(date_iso: str, twse_day: dict, tpex_day: dict) -> dict:
    records = []
    for day, market in ((twse_day, "twse"), (tpex_day, "tpex")):
        for stock in day["stocks"]:
            rec = {k: stock[k] for k in RECORD_FIELDS}
            rec["m"] = market          # 前端在「全部」範圍要標出上市／上櫃
            records.append(rec)

    payload = twse.build_payload(date_iso, "MERGED", records)
    # build_payload 只看得到兩邊的前 300 名，全市場的檔數與成交值要用原始數字相加
    payload["marketCount"] = twse_day["marketCount"] + tpex_day["marketCount"]
    payload["marketValue"] = twse_day["marketValue"] + tpex_day["marketValue"]
    return payload


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


def write_if_changed(path, payload) -> bool:
    """內容沒變就不重寫，避免每天產生無謂的 git 差異。"""
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return True


def main() -> int:
    dates = sorted(set(twse.existing_dates("twse")) | set(twse.existing_dates("tpex")))
    if not dates:
        print("docs/data/daily/ 沒有任何資料，請先執行 fetch_daily.py 或 backfill.py")
        return 1

    # 以下每個 dict 的鍵都是 scope
    streaks = {s: {} for s in twse.SCOPES}
    by_year = {s: defaultdict(lambda: {"dates": [], "stocks": {}}) for s in twse.SCOPES}
    series = {s: {"marketValues": [], "top200Values": [], "top10Values": []} for s in twse.SCOPES}
    missing = defaultdict(list)
    rewritten = defaultdict(int)

    for day_index, date_iso in enumerate(dates):
        days = {scope: load_day(date_iso, scope) for scope in ("twse", "tpex")}
        both = days["twse"] and days["tpex"]
        days["all"] = merge_day(date_iso, days["twse"], days["tpex"]) if both else None

        for scope in twse.SCOPES:
            payload = days[scope]
            if payload is None:
                # 這一天缺資料：三條序列都補 null，連續進榜天數也會自然中斷
                missing[scope].append(date_iso)
                for key in series[scope]:
                    series[scope][key].append(None)
                continue

            changed = update_streaks(payload, day_index, date_iso, streaks[scope])
            if scope == "all" or changed:
                if write_if_changed(twse.daily_path(date_iso, scope), payload):
                    rewritten[scope] += 1

            stocks = payload["stocks"]
            series[scope]["marketValues"].append(round(payload["marketValue"] / 1e8, 2))
            series[scope]["top200Values"].append(
                round(sum(s["value"] for s in stocks if s["rank"] <= twse.STREAK_RANK) / 1e8, 2))
            series[scope]["top10Values"].append(
                round(sum(s["value"] for s in stocks if s["rank"] <= 10) / 1e8, 2))

            bucket = by_year[scope][date_iso[:4]]
            bucket["dates"].append(date_iso)
            year_index = len(bucket["dates"]) - 1
            for stock in stocks:
                entry = bucket["stocks"].get(stock["code"])
                if entry is None:
                    entry = {"name": stock["name"], "p": []}
                    bucket["stocks"][stock["code"]] = entry
                entry["name"] = stock["name"]      # 沿用最新名稱（公司可能改名）
                entry["p"].append([year_index, stock["rank"], round(stock["value"] / 1e8, 2)])

    for scope in twse.SCOPES:
        folder = twse.HISTORY_DIR / scope
        folder.mkdir(parents=True, exist_ok=True)
        for year, bucket in sorted(by_year[scope].items()):
            path = twse.history_path(year, scope)
            write_if_changed(path, {"year": int(year), **bucket})
            print(f"  {scope}/{year}.json：{len(bucket['dates'])} 個交易日、"
                  f"{len(bucket['stocks'])} 檔曾進榜（{path.stat().st_size / 1024:,.0f} KB）")

        valid = {f"{year}.json" for year in by_year[scope]}
        for stale in folder.glob("*.json"):
            if stale.name not in valid:
                stale.unlink()
                print(f"  移除過期檔案 {scope}/{stale.name}")

    twse.write_json(
        twse.INDEX_PATH,
        {
            "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
            "latest": dates[-1],
            "years": sorted({d[:4] for d in dates}, reverse=True),
            "dates": dates,
            "scopes": {s: series[s] for s in twse.SCOPES},
        },
    )
    print(f"index.json：{len(dates)} 個交易日（{dates[0]} ~ {dates[-1]}）")

    for scope in twse.SCOPES:
        if rewritten[scope]:
            print(f"{twse.SCOPE_NAMES[scope]}：更新了 {rewritten[scope]} 個每日檔")
        gaps = missing[scope]
        if gaps:
            span = f"{gaps[0]} ~ {gaps[-1]}" if len(gaps) > 1 else gaps[0]
            print(f"! {twse.SCOPE_NAMES[scope]}：{len(gaps)} 個交易日沒有資料（{span}），"
                  f"這些天的連續進榜天數會從中斷處重新起算")
    return 0


if __name__ == "__main__":
    sys.exit(main())
