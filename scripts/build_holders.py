"""由每週快照算出「大戶」分頁要吃的兩種檔案。

    docs/data/holders/index.json        有哪幾個資料日、最新那一份的涵蓋範圍
    docs/data/holders/stock/{代號}.json 個股的逐週序列（大戶頁點進去看的那張圖）

## 為什麼還要一份個股序列

清單那一頁只需要「最新那一份」與「拿來比的那一份」，兩個檔案就夠了；但點進單一
個股要畫的是完整走勢，那得把每一份快照都翻過一遍 —— 一份 200 KB、幾十份就是幾 MB，
手機上不可能為了一條線抓那麼多。所以這裡先把逐週資料轉置成「一檔一個檔」，
前端只抓它要的那一檔（幾 KB）。

只有進過本站排行（daily/ 的前 300 名）的個股才出檔 —— 那也正是前端唯一走得到
個股頁的那些代號。集保那份 CSV 涵蓋三千多檔，其餘兩千檔出了檔也沒有人點得到。

## 轉置檔每次都要整個重寫

跟 history/ 一樣，這是純衍生資料，每次都由 weekly/ 從頭重算，只有內容真的改變的
檔案才會重寫 —— 集保一週才動一次，所以正常情況下一週只有那一天會有 git 差異。

用法：
    python scripts/build_holders.py
"""

from __future__ import annotations

import sys
from collections import Counter
from datetime import datetime

import holders
import twse


# 「這一份為什麼不是全市場」。理由是從 source 與 truncated 兩個事實組出來的，
# 不是存在快照裡的句子 —— 存句子的話，補到一半那次寫下的檔數補完就過期了。
WHY_TRUNCATED = "網頁典藏館的抓取上限是 1 MB，2.3 MB 的原始檔被從中間切斷，代號較後面的那一段沒抓到"
WHY_STOCK = "逐檔向集保官網的個股查詢頁補抓的，只有當時補的那一批股票"


def why_of(payload: dict) -> str:
    bits = []
    if holders.is_truncated(payload):
        bits.append(WHY_TRUNCATED)
    if payload.get("source") in ("stock", "mixed"):
        bits.append(WHY_STOCK)
    return "；".join(bits)


def tracked_codes() -> set:
    """曾經進過排行（daily/ 前 300 名）的所有代號，取自 history/all/*.json。"""
    codes = set()
    year_dir = twse.HISTORY_DIR / "all"
    for path in sorted(year_dir.glob("*.json")):
        payload = holders.read_json(path)
        codes.update((payload.get("stocks") or {}).keys())
    return codes


def main() -> int:
    dates = holders.snapshot_dates()
    if not dates:
        print("docs/data/holders/weekly/ 沒有任何快照，"
              "請先執行 fetch_holders.py（或 backfill_holders.py 回補一段歷史）")
        return 1

    stale = [d for d in dates
             if holders.read_json(holders.snapshot_path(d)).get("v") != holders.SNAPSHOT_VERSION]
    if stale:
        print(f"這 {len(stale)} 份快照是舊格式（{', '.join(stale[:5])}"
              f"{' 等' if len(stale) > 5 else ''}），欄位與現在的對不起來。")
        print("舊格式混進來只會算出安靜的錯誤答案，所以停在這裡。"
              "請把 docs/data/holders/weekly/ 清掉後重跑 fetch_holders.py 與 backfill_holders.py。")
        return 1

    universe = tracked_codes()
    if not universe:
        print("docs/data/history/ 還沒有東西，請先執行 build_history.py")
        return 1

    # 逐週把每一檔的那一列塞進它自己的序列。快照一份 200 KB、目前幾十份，
    # 全部讀進記憶體再轉置是最省事的做法。
    series = {}
    sources = Counter()
    weeks = []
    for date_iso in dates:
        payload = holders.read_json(holders.snapshot_path(date_iso))
        stocks = payload.get("stocks") or {}
        sources[payload.get("source") or "?"] += 1
        # p 是「這一份不是全市場」，w 是為什麼 —— 畫面上要講得出理由，
        # 不然那一週查不到的股票看起來就像退出了集保
        week = {"d": date_iso, "n": len(stocks), "s": payload.get("source") or "?"}
        if payload.get("partial"):
            week["p"] = 1
            week["w"] = why_of(payload)
        weeks.append(week)
        for code, row in stocks.items():
            if code in universe:
                series.setdefault(code, []).append((date_iso, row))

    wrote = 0
    for code, points in sorted(series.items()):
        payload = {
            "c": code,
            "fields": list(holders.FIELDS),
            "d": [d for d, _ in points],
            "v": [row for _, row in points],
        }
        if holders.write_if_changed(holders.stock_path(code), payload):
            wrote += 1

    # 排行裡有、集保那份卻查不到的代號（下市、合併、改代號）就是沒有序列，
    # 不是漏算。講出檔數才看得出這件事的規模。
    missing = len(universe - set(series))

    index = {
        "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "latest": dates[-1],
        "first": dates[0],
        # 一週一格：資料日、涵蓋檔數，被典藏截斷的那幾份多一個 p:1
        "weeks": weeks,
        "fields": list(holders.FIELDS),
        "series": len(series),
        "sources": dict(sorted(sources.items())),
    }
    holders.write_json(holders.HOLDERS_INDEX_PATH, index)

    span = f"{dates[0]} ~ {dates[-1]}" if len(dates) > 1 else dates[0]
    print(f"讀了 {len(dates)} 份快照（{span}）"
          + (f"，其中 {sources['wayback']} 份來自網頁典藏館" if sources.get("wayback") else ""))
    partials = [w for w in weeks if w.get("p")]
    print(f"最新那一份涵蓋 {weeks[-1]['n']} 檔；排行裡的 {len(universe)} 檔有 {len(series)} 檔出了序列"
          + (f"（{missing} 檔在集保資料裡查不到，多半是下市或合併）" if missing else ""))
    print(f"已寫入 {holders.HOLDERS_INDEX_PATH.relative_to(twse.ROOT)}"
          f"，個股序列本次重寫 {wrote} 個")
    if partials:
        print(f"注意：{len(partials)} 份不是全市場，那幾週查不到的個股是沒補到、不是退出了集保：")
        for week in partials:
            print(f"  {week['d']}（{week['n']} 檔）{week.get('w') or ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
