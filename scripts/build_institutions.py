"""由每日檔算出「法人」與「連買」兩個分頁要吃的衍生檔。

    docs/data/insti/index.json          有哪幾個交易日、各自幾檔、全市場的估算合計
    docs/data/insti/streak/{日期}.json  截至那一天，外資連續買（賣）超 3 天以上的名單

前端需要目錄檔的理由：法人資料是後來才開始累積的，它涵蓋的交易日比 data/index.json
那份短。少了目錄，畫面就只能拿主索引的日期去猜，猜錯就是一則 404 載入失敗 ——
「那一天還沒有法人資料」與「檔案掛了」必須分得出來。

連續天數算在這裡而不是前端的理由：一天的檔案 43 KB，「連買 N 天」要回頭看 N 天，
最長的那幾段還會連到資料起點 —— 讓瀏覽器自己抓回來算是幾百 KB 的代價。
判斷「連續」的三條規則見 institutions.py 的模組說明。

兩份都是純衍生資料，每次都由 daily/ 從頭重算。

用法：
    python scripts/build_institutions.py
"""

from __future__ import annotations

import sys
from datetime import datetime

import institutions as insti
import twse


def build_runs(dates: list, tables: dict) -> int:
    """一天寫一個外資連續買賣超的檔案。回傳寫了幾天，出錯回 -1。

    交易日的名單取自 close/twse/ —— 上市與上櫃的交易日相同，而全市場行情比法人
    資料早幾個月開始累積，所以它涵蓋得比 dates 寬，接得起相鄰性的判斷。
    """
    trading = twse.existing_close_dates()
    outside = [d for d in dates if d not in set(trading)]
    if not trading or outside:
        # 相鄰性判斷不出來的話，每一段都會從當天重新起算 —— 檔案會寫出來，
        # 只是每一檔都「連 1 天」，一檔也進不了榜。那是安靜的錯，所以停在這裡。
        print("算不出交易日的相鄰性：" + (
            "docs/data/close/twse/ 沒有任何檔案" if not trading
            else f"這 {len(outside)} 天（{', '.join(outside[:5])}）在 close/twse/ 裡找不到"))
        print("請先執行 python scripts/backfill.py --days 14")
        return -1

    adjacent = insti.adjacent_flags(dates, trading)
    # 缺口：中間少了一個真正的交易日（兩個市場只有一邊有資料的日子整天不寫檔）。
    # 連續天數不跨過缺口，所以缺口後面那幾天的天數會偏短，要講出來。
    gaps = [dates[i] for i in range(1, len(dates)) if not adjacent[i]]

    before = {d: (trading[i - 1] if i else None) for i, d in enumerate(trading)}
    closes = {}

    def base_close(market: str, since: str, code: str):
        """起算日前一個交易日的收盤價。那天的檔案不在就回 None，期間漲跌留空。"""
        day = before.get(since)
        if not day:
            return None
        key = (market, day)
        if key not in closes:
            path = twse.close_path(day, market)
            closes[key] = (insti.read_json(path).get("c") or {}) if path.exists() else {}
        return closes[key].get(code)

    sequence = [(d, adjacent[i], tables[d]) for i, d in enumerate(dates)]
    latest = None
    for date_iso, runs in insti.foreign_runs(sequence):
        kept = {c: r for c, r in runs.items() if abs(r.days) >= insti.RUN_MIN_DAYS}
        returns = {c: insti.run_return(r, base_close(r.market, r.since, c))
                   for c, r in kept.items()}
        payload = insti.build_run_payload(date_iso, runs, dates[0], returns)
        insti.write_json(insti.run_path(date_iso), payload)
        latest = payload

    # daily/ 少了某一天（手動刪檔、或格式重來）時，衍生檔要跟著走，不然畫面上
    # 會看到一份沒有對應每日檔的連續榜。
    for path in sorted(insti.INSTI_RUN_DIR.glob("*.json")):
        if path.stem not in set(dates):
            path.unlink()
            print(f"  已刪除 {path.relative_to(twse.ROOT)}（daily/ 已經沒有這一天）")

    print(f"外資連續買賣超：{len(dates)} 天，每天留 {insti.RUN_MIN_DAYS} 天以上的")
    if gaps:
        print(f"  ! daily/ 中間缺了交易日，這 {len(gaps)} 天接不到前一天，"
              f"天數從自己重新起算：{', '.join(gaps[:5])}")

    field = {name: i for i, name in enumerate(insti.RUN_FIELDS)}
    rows = [row for stocks in latest["stocks"].values() for row in stocks.values()]
    rows.sort(key=lambda r: (abs(r[field["days"]]), abs(r[field["oku"]])), reverse=True)
    print(f"  最新那一天 {latest['date']}：連買 {latest['buy']} 檔、連賣 {latest['sell']} 檔")
    for row in rows[:3]:
        days = row[field["days"]]
        print(f"    {row[field['name']]} 連{'買' if days > 0 else '賣'}超 {abs(days)}"
              f"{'+' if row[field['trunc']] else ''} 天（{row[field['since']]} 起），"
              f"累計 {row[field['oku']]:+,.1f} 億"
              + (f"，期間 {row[field['ret']]:+.1f}%" if row[field["ret"]] is not None else ""))
    return len(dates)


def main() -> int:
    dates = insti.existing_dates()
    if not dates:
        print("docs/data/insti/daily/ 沒有任何檔案，請先執行 fetch_institutions.py")
        return 1

    days = []
    stale = []
    tables = {}
    for date_iso in dates:
        payload = insti.read_json(insti.daily_path(date_iso))
        if payload.get("v") != insti.SNAPSHOT_VERSION:
            stale.append(date_iso)
            continue
        tables[date_iso] = insti.foreign_table(payload)
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
        # 連買分頁自己的一行自我描述。舊的資料集（還沒有 streak/ 那個目錄）少了這個
        # 欄位，畫面因此分得出「這份資料還沒建連續榜」與「檔案掛了」。
        "streak": {"v": insti.RUN_VERSION, "min": insti.RUN_MIN_DAYS,
                   "leg": insti.RUN_LEG, "fields": list(insti.RUN_FIELDS)},
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

    print()
    wrote = build_runs(dates, tables)
    if wrote < 0:
        return 1
    folder = insti.INSTI_RUN_DIR.relative_to(twse.ROOT).as_posix()
    print(f"已寫入 {folder}/ 底下 {wrote} 個檔案")
    return 0


if __name__ == "__main__":
    sys.exit(main())
