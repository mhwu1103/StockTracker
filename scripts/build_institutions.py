"""由每日檔算出「法人」分頁要吃的目錄檔。

    docs/data/insti/index.json    有哪幾個交易日、各自幾檔、全市場的估算合計

前端需要這一份的理由：法人資料是後來才開始累積的，它涵蓋的交易日比 data/index.json
那份短。少了目錄，畫面就只能拿主索引的日期去猜，猜錯就是一則 404 載入失敗 ——
「那一天還沒有法人資料」與「檔案掛了」必須分得出來。

純衍生資料，每次都由 daily/ 從頭重算。

用法：
    python scripts/build_institutions.py
"""

from __future__ import annotations

import sys
from datetime import datetime

import institutions as insti
import twse


def main() -> int:
    dates = insti.existing_dates()
    if not dates:
        print("docs/data/insti/daily/ 沒有任何檔案，請先執行 fetch_institutions.py")
        return 1

    days = []
    stale = []
    for date_iso in dates:
        payload = insti.read_json(insti.daily_path(date_iso))
        if payload.get("v") != insti.SNAPSHOT_VERSION:
            stale.append(date_iso)
            continue
        # 官方合計優先；那天真的抓不到就退回估算值，並標上 e:1 讓畫面講得出來
        official = payload.get("total")
        entry = {"d": date_iso, "n": payload.get("n") or 0}
        for market in insti.MARKETS:
            entry[market] = (official or payload["est"])[market]
        if not official:
            entry["e"] = 1
        days.append(entry)

    # 舊格式混進來只會算出安靜的錯誤答案，那比整個掛掉還糟，所以停在這裡。
    if stale:
        print(f"這 {len(stale)} 天是舊格式（{', '.join(stale[:5])}{' 等' if len(stale) > 5 else ''}），"
              "欄位與現在的對不起來。")
        print("請把 docs/data/insti/daily/ 清掉後重跑 "
              "python scripts/fetch_institutions.py --days 30")
        return 1

    index = {
        "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "latest": days[-1]["d"],
        "first": days[0]["d"],
        "v": insti.SNAPSHOT_VERSION,
        "fields": list(insti.FIELDS),
        "cut": insti.MIN_OKU,
        # 一天一格：交易日、留下幾檔，以及兩個市場各自三邊的買賣超合計（億元，官方金額）
        "days": days,
    }
    insti.write_json(insti.INSTI_INDEX_PATH, index)

    span = f"{days[0]['d']} ~ {days[-1]['d']}" if len(days) > 1 else days[0]["d"]
    last = days[-1]
    estimated = sum(1 for d in days if d.get("e"))
    print(f"讀了 {len(days)} 天（{span}）"
          + (f"，其中 {estimated} 天沒有官方合計、用估算值代替" if estimated else ""))
    print(f"最新那一天 {last['d']}：{last['n']} 檔")
    for market in insti.MARKETS:
        row = last[market]
        print(f"  {twse.SCOPE_NAMES[market]} 外資 {row['fo']:+,.1f} 億、"
              f"投信 {row['tr']:+,.1f} 億、自營商 {row['de']:+,.1f} 億")
    print(f"已寫入 {insti.INSTI_INDEX_PATH.relative_to(twse.ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
