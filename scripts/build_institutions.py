"""由每日檔算出「法人」「買超」「連買」三個分頁要吃的衍生檔。

    docs/data/insti/index.json          有哪幾個交易日、各自幾檔、全市場的估算合計
    docs/data/insti/streak/{日期}.json  截至那一天，外資連續買（賣）超 3 天以上的名單
    docs/data/insti/chg/{日期}.json     那一天每一檔的漲跌（%），「逆勢買超」要的第二個軸
    docs/data/insti/sum/{日期}.json     截至那一天，三邊法人近 5／20 日的累計買賣超
    docs/data/insti/base/{日期}.json    每一檔「平常」被買賣多少（力道標的分母）

前端需要目錄檔的理由：法人資料是後來才開始累積的，它涵蓋的交易日比 data/index.json
那份短。少了目錄，畫面就只能拿主索引的日期去猜，猜錯就是一則 404 載入失敗 ——
「那一天還沒有法人資料」與「檔案掛了」必須分得出來。

連續天數算在這裡而不是前端的理由：一天的檔案 43 KB，「連買 N 天」要回頭看 N 天，
最長的那幾段還會連到資料起點 —— 讓瀏覽器自己抓回來算是幾百 KB 的代價。
判斷「連續」的三條規則見 institutions.py 的模組說明。

漲跌算在這裡的理由不同：它要的是**前一個交易日**的收盤價，而 daily/ 只存當天的。
前一天的價在 docs/data/close/ 裡、本機就有，讓前端為了一欄漲跌再抓兩份全市場
行情（約 120 KB）不划算。

跨日累計與連續榜是兩件事，所以兩份檔案並存：累計不管中間翻不翻向（問「總共買了
多少」），連續一翻就斷（問「有沒有一路買」），挑出來的是不同的股票。

五份都是純衍生資料，每次都由 daily/ 從頭重算。

用法：
    python scripts/build_institutions.py
"""

from __future__ import annotations

import sys
from datetime import datetime

import institutions as insti
import twse


def trading_context(dates: list):
    """(全部交易日, {交易日: 前一個交易日})。算不出來就印原因並回 (None, None)。

    交易日的名單取自 close/twse/ —— 上市與上櫃的交易日相同，而全市場行情比法人
    資料早幾個月開始累積，所以它涵蓋得比 dates 寬。連續榜的相鄰性與漲跌的
    「對比前一個交易日」都靠它，缺了它兩份都只會安靜地算出偏短的天數與空白的漲跌。
    """
    trading = twse.existing_close_dates()
    outside = [d for d in dates if d not in set(trading)]
    if not trading or outside:
        print("算不出交易日的相鄰性：" + (
            "docs/data/close/twse/ 沒有任何檔案" if not trading
            else f"這 {len(outside)} 天（{', '.join(outside[:5])}）在 close/twse/ 裡找不到"))
        print("請先執行 python scripts/backfill.py --days 14")
        return None, None
    before = {d: (trading[i - 1] if i else None) for i, d in enumerate(trading)}
    return trading, before


def drop_orphans(folder, dates: set, label: str) -> None:
    """daily/ 已經沒有的日期，衍生檔也要跟著刪。

    少了這一步，手動刪掉某一天的每日檔（或格式重來）之後，畫面上會看到一份沒有
    對應每日檔的衍生資料 —— 它不會報錯，只會安靜地比 daily/ 多出幾天。
    """
    for path in sorted(folder.glob("*.json")):
        if path.stem not in dates:
            path.unlink()
            print(f"  已刪除 {path.relative_to(twse.ROOT)}（daily/ 已經沒有這一天，{label}）")


def close_reader():
    """(日期, 市場) -> {代號: 收盤價}，讀過的留著。

    三份衍生檔都要回頭讀 close/ 底下的全市場行情，而且讀的是同一批日子：連續榜要
    起算日前一天的價、漲跌要前一個交易日的、累計要窗口第一天前一天的。各自開一份
    快取的話，同一個檔會被解析三次（22 天 × 2 市場 × 3 份 = 132 次 JSON 解析）。
    """
    cache = {}

    def read(date_iso: str, market: str) -> dict:
        key = (market, date_iso)
        if key not in cache:
            cache[key] = insti.close_file(date_iso, market)
        return cache[key]

    return read


def build_runs(dates: list, tables: dict, trading: list, before: dict, close_at) -> int:
    """一天寫一個外資連續買賣超的檔案。回傳寫了幾天。"""
    adjacent = insti.adjacent_flags(dates, trading)
    # 缺口：中間少了一個真正的交易日（兩個市場只有一邊有資料的日子整天不寫檔）。
    # 連續天數不跨過缺口，所以缺口後面那幾天的天數會偏短，要講出來。
    gaps = [dates[i] for i in range(1, len(dates)) if not adjacent[i]]

    def base_close(market: str, since: str, code: str):
        """起算日前一個交易日的收盤價。那天的檔案不在就回 None，期間漲跌留空。"""
        day = before.get(since)
        return close_at(day, market).get(code) if day else None

    sequence = [(d, adjacent[i], tables[d]) for i, d in enumerate(dates)]
    latest = None
    for date_iso, runs in insti.foreign_runs(sequence):
        kept = {c: r for c, r in runs.items() if abs(r.days) >= insti.RUN_MIN_DAYS}
        returns = {c: insti.run_return(r, base_close(r.market, r.since, c))
                   for c, r in kept.items()}
        payload = insti.build_run_payload(date_iso, runs, dates[0], returns)
        insti.write_json(insti.run_path(date_iso), payload)
        latest = payload

    drop_orphans(insti.INSTI_RUN_DIR, set(dates), "連續榜")

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


def build_chg(dates: list, closes: dict, before: dict, close_at) -> int:
    """一天寫一個「每一檔今天漲跌幾 %」的檔案。回傳寫了幾天。

    closes 是 {日期: {市場: {代號: 收盤價}}}，取自每日檔本身；基準價則讀
    close/ 底下前一個交易日的全市場行情 —— 前一天有沒有進法人的每日檔不重要，
    今天的漲跌問的是價格，不是法人有沒有動作。
    """
    def prev_closes(prev_iso: str) -> dict:
        return {m: close_at(prev_iso, m) for m in insti.MARKETS}

    blank = []
    latest = None
    for date_iso in dates:
        prev_iso = before.get(date_iso)
        payload = insti.build_chg_payload(
            date_iso, prev_iso, closes[date_iso],
            prev_closes(prev_iso) if prev_iso else {})
        if not payload["n"]:
            blank.append(date_iso)
        insti.write_json(insti.chg_path(date_iso), payload)
        latest = payload

    drop_orphans(insti.INSTI_CHG_DIR, set(dates), "漲跌")

    print(f"當日漲跌：{len(dates)} 天")
    if blank:
        # 整天都算不出漲跌，代表前一個交易日的 close/ 檔不在。畫面上那一欄會整排
        # 留白，而留白看起來就像「今天全部收平盤」—— 這是安靜的錯，要講出來。
        print(f"  ! 這 {len(blank)} 天一檔也算不出漲跌（前一個交易日的 close/ 檔不在）："
              f"{', '.join(blank[:5])}")
        print("    請先執行 python scripts/backfill.py --days 14")
    if latest:
        up = sum(1 for v in latest["chg"].values() if v > 0)
        down = sum(1 for v in latest["chg"].values() if v < 0)
        print(f"  最新那一天 {latest['date']}：{latest['n']} 檔算得出漲跌"
              f"（對比 {latest['prev']}），{up} 檔收紅、{down} 檔收黑"
              + (f"，{latest['miss']} 檔前一日沒有收盤價" if latest["miss"] else ""))
    return len(dates)


def build_sum(dates: list, legs: dict, trading: list, before: dict, close_at) -> int:
    """一天寫一個跨日累計的檔案（三邊 × 5／20 日）。回傳寫了幾天。

    legs 是 {日期: leg_table 的結果}。窗口不跨過 daily/ 中間的缺口 —— 跨過去的話，
    缺的那幾天會被當成「沒發生」，而它們其實是不知道。
    """
    adjacent = insti.adjacent_flags(dates, trading)
    span = insti.window_span(adjacent)

    latest = None
    short = {w: 0 for w in insti.SUM_WINDOWS}
    for at, date_iso in enumerate(dates):
        wins = {}
        meta = {}
        for window in insti.SUM_WINDOWS:
            days = min(window, span[at])
            if days < window:
                short[window] += 1
            base_day = before.get(dates[at - days + 1])
            totals, ident = insti.accumulate(dates, legs, at, days)
            keep = insti.sum_keep(totals, ident)
            prices = insti.avg_prices(dates, legs, at, days,
                                      {c: totals[c] for c in keep})
            rows = {}
            for code in keep:
                acc = totals[code]
                market, name = ident[code]
                # 當日收盤價取 close/ 的全市場行情：這一檔今天可能沒進法人的每日檔
                # （三邊都只有零頭），但它照樣有價
                close = close_at(date_iso, market).get(code)
                base = close_at(base_day, market).get(code) if base_day else None
                ret = round((close / base - 1) * 100, 2) if close and base else None
                rows[code] = [round(acc[0], 2), round(acc[1], 2), round(acc[2], 2),
                              int(acc[3]), int(acc[4]), int(acc[5]), ret,
                              *prices.get(code, [None] * 4)]
                if code not in meta:
                    meta[code] = [name, market, close]
            wins[window] = (days, rows)

        payload = insti.build_sum_payload(date_iso, wins, meta)
        insti.write_json(insti.sum_path(date_iso), payload)
        latest = payload

    drop_orphans(insti.INSTI_SUM_DIR, set(dates), "跨日累計")

    wins_text = "／".join(f"{w} 日" for w in insti.SUM_WINDOWS)
    print(f"跨日累計（{wins_text}）：{len(dates)} 天，"
          f"每個市場每一邊各留前 {insti.SUM_KEEP} 名（不到 {insti.SUM_FLOOR} 億的不留）")
    for window in insti.SUM_WINDOWS:
        if short[window]:
            # 湊不滿的累計看起來跟「那段時間法人沒什麼動作」一模一樣，要講出來
            print(f"  ! {window} 日窗口有 {short[window]} 天湊不滿"
                  f"（資料起點附近，或 daily/ 中間缺了交易日），"
                  f"實際天數記在那一天的 w.{window}.days")
    if latest:
        field = {name: i for i, name in enumerate(insti.SUM_FIELDS)}
        print(f"  最新那一天 {latest['date']}："
              + "、".join(f"{w} 日 {n} 檔" for w, n in latest["n"].items()))
        last = str(insti.SUM_WINDOWS[-1])
        block = latest["w"][last]
        rows = sorted(block["rows"].items(),
                      key=lambda kv: kv[1][field["fo"]], reverse=True)
        for code, row in rows[:3]:
            name = latest["meta"][code][0]
            ret = row[field["ret"]]
            print(f"    {name} 近 {last} 日外資累計 {row[field['fo']]:+,.1f} 億"
                  f"（實算 {block['days']} 天）"
                  + (f"，期間 {ret:+.1f}%" if ret is not None else ""))
    return len(dates)


def build_base(dates: list, legs: dict) -> int:
    """一天寫一個「每一檔平常被買賣多少」的檔案（力道標的分母）。回傳寫了幾天。

    前面湊不滿 BASE_MIN_DAYS 天的那幾天整天不寫 —— 用三、四天算出來的中位數不是
    「平常」，是「剛好那幾天」，而它看起來與真的中位數一模一樣。
    """
    thin = []
    wrote = 0
    latest = None
    for at, date_iso in enumerate(dates):
        norms = insti.daily_norms(dates, legs, at)
        if not norms:
            thin.append(date_iso)
            continue
        used = min(insti.BASE_WINDOW, at)
        payload = insti.build_base_payload(date_iso, norms, used)
        insti.write_json(insti.base_path(date_iso), payload)
        latest = payload
        wrote += 1

    drop_orphans(insti.INSTI_BASE_DIR, {d for d in dates}, "平常的量")
    # 寫不出來的那幾天也要清掉舊檔，不然改了 BASE_MIN_DAYS 之後會留下孤兒
    drop_orphans(insti.INSTI_BASE_DIR, set(dates) - set(thin), "天數不足")

    print(f"平常的量（前 {insti.BASE_WINDOW} 個交易日的日金額中位數）：寫了 {wrote} 天")
    if thin:
        print(f"  ! 這 {len(thin)} 天前面不滿 {insti.BASE_MIN_DAYS} 天，整天不寫："
              f"{', '.join(thin[:5])}{' 等' if len(thin) > 5 else ''}")
    if latest:
        zero = sum(1 for v in latest["base"].values() if not v[0])
        print(f"  最新那一天 {latest['date']}：{latest['n']} 檔（用了前 {latest['used']} 個交易日），"
              f"其中 {zero} 檔的外資中位數是 0（平常大多沒進每日檔）")
    return wrote


def main() -> int:
    dates = insti.existing_dates()
    if not dates:
        print("docs/data/insti/daily/ 沒有任何檔案，請先執行 fetch_institutions.py")
        return 1

    days = []
    stale = []
    tables = {}
    closes = {}
    legs = {}
    for date_iso in dates:
        payload = insti.read_json(insti.daily_path(date_iso))
        if payload.get("v") != insti.SNAPSHOT_VERSION:
            stale.append(date_iso)
            continue
        tables[date_iso] = insti.foreign_table(payload)
        closes[date_iso] = insti.payload_closes(payload)
        legs[date_iso] = insti.leg_table(payload)
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
        # 買超分頁自己的一行自我描述，用途與上面那個 streak 相同：舊的資料集還沒有
        # chg/ 這個目錄，少了這一行，畫面就分不出「還沒算漲跌」與「檔案掛了」。
        "chg": {"v": insti.CHG_VERSION},
        # 跨日累計的自我描述。窗口長度寫在這裡，前端的 pill 才不必自己寫死一份。
        "sum": {"v": insti.SUM_VERSION, "wins": list(insti.SUM_WINDOWS),
                "keep": insti.SUM_KEEP, "floor": insti.SUM_FLOOR,
                "fields": list(insti.SUM_FIELDS)},
        # 力道標的自我描述。前面湊不滿的那幾天沒有檔案，所以畫面除了看這一行，
        # 還要能接受個別日期的 404。
        "base": {"v": insti.BASE_VERSION, "win": insti.BASE_WINDOW,
                 "min": insti.BASE_MIN_DAYS, "fields": list(insti.BASE_FIELDS)},
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
    trading, before = trading_context(dates)
    if trading is None:
        return 1

    close_at = close_reader()

    wrote = build_runs(dates, tables, trading, before, close_at)
    folder = insti.INSTI_RUN_DIR.relative_to(twse.ROOT).as_posix()
    print(f"已寫入 {folder}/ 底下 {wrote} 個檔案")

    print()
    wrote = build_chg(dates, closes, before, close_at)
    folder = insti.INSTI_CHG_DIR.relative_to(twse.ROOT).as_posix()
    print(f"已寫入 {folder}/ 底下 {wrote} 個檔案")

    print()
    wrote = build_sum(dates, legs, trading, before, close_at)
    folder = insti.INSTI_SUM_DIR.relative_to(twse.ROOT).as_posix()
    print(f"已寫入 {folder}/ 底下 {wrote} 個檔案")

    print()
    wrote = build_base(dates, legs)
    folder = insti.INSTI_BASE_DIR.relative_to(twse.ROOT).as_posix()
    print(f"已寫入 {folder}/ 底下 {wrote} 個檔案")
    return 0


if __name__ == "__main__":
    sys.exit(main())
