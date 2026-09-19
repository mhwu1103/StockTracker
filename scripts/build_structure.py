"""由 docs/data/close/{twse,tpex}/*.json 算出電子類股的價格結構。

這一份與排行完全脫鉤：不看成交值前 200 名，八個官方電子子產業底下的每一檔都算，
包含從來沒進過榜的那些。演算法在 structure.py，這裡只負責讀檔、逐日餵、寫檔。

產出（純衍生檔，隨時可重算）：
    docs/data/structure/index.json          有哪幾個交易日、涵蓋幾檔、參數與產業分佈
    docs/data/structure/codes.json          代號 -> [簡稱, 市場, 產業]，只存一次
    docs/data/structure/YYYY-MM-DD.json     當日每一檔的結構狀態

每日檔刻意只放數字，股名與產業一律去 codes.json 查——那些字串每天存一次，
一年就是好幾 MB 的重複內容。

用法：
    python scripts/build_structure.py
"""

from __future__ import annotations

import sys
from collections import Counter
from datetime import datetime

import structure
import twse

STRUCTURE_DIR = twse.DATA_DIR / "structure"
INDEX_PATH = STRUCTURE_DIR / "index.json"
CODES_PATH = STRUCTURE_DIR / "codes.json"

MARKETS = ("twse", "tpex")


def day_path(date_iso: str):
    return STRUCTURE_DIR / f"{date_iso}.json"


def load_prices(date_iso: str, market: str):
    """讀當日全市場四價，回傳 code -> [開, 高, 低, 收]；沒有這個檔就回 None。

    與 build_history.py 的同名函式做同一件事，格式也一樣——那邊算均線與 K 線、
    這邊算結構，兩支各自跑、互不依賴，所以各留一份讀檔的程式碼。
    """
    path = twse.close_path(date_iso, market)
    if not path.exists():
        return None
    raw = twse.read_json(path)
    opens, highs, lows = (raw.get(k) or {} for k in ("o", "h", "l"))
    return {code: [opens.get(code), highs.get(code), lows.get(code), close]
            for code, close in raw["c"].items()}


def pct(close, prev):
    """漲跌幅（%）。沒有昨收（第一天、剛上市）就回 None，不要填 0 假裝平盤。"""
    if prev in (None, 0):
        return None
    return round((close / prev - 1) * 100, 2)


def main() -> int:
    industries, names = structure.load_industry()
    wanted = structure.electronic_codes(industries)
    if not wanted:
        print("industry.json 裡找不到任何電子股，請先執行 fetch_industry.py")
        return 1

    dates = sorted(set(twse.existing_close_dates("twse"))
                   | set(twse.existing_close_dates("tpex")))
    if not dates:
        print("docs/data/close/ 沒有任何四價資料，請先執行 fetch_daily.py 或 backfill.py")
        return 1

    trackers = {m: structure.StructureTracker() for m in MARKETS}
    prev_close = {}                  # code -> 昨收，算漲跌幅用
    seen = {}                        # code -> [簡稱, 市場, 產業]，最後寫進 codes.json
    written = rewritten = 0
    covered = {}                     # date -> 這一天算得出結構的檔數

    for date_iso in dates:
        rows = {}
        today_close = {}
        for market in MARKETS:
            prices = load_prices(date_iso, market)
            if prices is None:
                # 這個市場今天沒有四價檔：連續性斷在這裡，樞紐要從頭數
                trackers[market].reset()
                continue
            result = trackers[market].feed(prices)
            for code, out in result.items():
                if code not in wanted:
                    continue
                close = prices[code][3]
                today_close[code] = close
                seen[code] = [structure.name_of(code, names), market,
                              structure.industry_of(code, industries)]
                rows[code] = [*out["s"][3], *out["s"][5],
                              twse.trim(close), pct(close, prev_close.get(code))]

        prev_close.update(today_close)
        if not rows:
            continue
        covered[date_iso] = len(rows)
        payload = {"date": date_iso, "n": len(rows),
                   "s": {code: rows[code] for code in sorted(rows)}}
        written += 1
        if twse.write_if_changed(day_path(date_iso), payload):
            rewritten += 1

    # 回補把某一天洗掉時留下的舊檔要清掉，不然前端會讀到對不上的日期
    valid = {f"{d}.json" for d in covered}
    for stale in STRUCTURE_DIR.glob("*.json"):
        if stale.name not in valid and stale.name not in ("index.json", "codes.json"):
            stale.unlink()
            print(f"  移除過期檔案 structure/{stale.name}")

    if not covered:
        print("沒有任何一天算得出結構，請確認 close/ 底下有四價資料")
        return 1

    days = sorted(covered)
    twse.write_if_changed(CODES_PATH, {
        "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "codes": {code: seen[code] for code in sorted(seen)},
    })

    by_industry = Counter(entry[2] for entry in seen.values())
    twse.write_json(INDEX_PATH, {
        "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "latest": days[-1],
        "dates": days,
        # 前端要照這個順序排產業，也要知道樞紐是用哪幾個 k、以什麼價為準
        "ks": list(structure.PIVOT_KS),
        "basis": "close",
        "warmup": 2 * structure.KMAX + 1,
        "industries": [name for name, _ in by_industry.most_common()],
        "counts": dict(by_industry.most_common()),
    })

    print(f"structure/：{len(days)} 個交易日（{days[0]} ~ {days[-1]}）、"
          f"{len(seen)} 檔電子股，本次重寫 {rewritten}／{written} 個每日檔")
    print(f"  最新一天 {days[-1]} 涵蓋 {covered[days[-1]]} 檔")
    thin = [d for d in days[:2 * structure.KMAX]]
    if thin:
        print(f"  ! 最前面 {len(thin)} 個交易日還在暖身（樞紐要 {2 * structure.KMAX + 1} 根才確認），"
              f"結構多半是空的：{thin[0]} ~ {thin[-1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
