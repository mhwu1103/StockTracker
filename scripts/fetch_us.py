"""抓美股日線 -> docs/data/us/market.json。

清單來自 `docs/data/us_link.json`（對照表裡出現過的每一檔，含 benchmarks），
另外補兩個大盤（^TWII、^IXIC）——那兩個不是給人看的標的，是算超額相關時的減數。

Yahoo 的 chart API 一次就給得出一整年的日線，不必累積，每次重抓覆寫即可。
所有美股共用同一條日期軸（就是美股的交易日曆），缺的日子存 null：
一百多檔各存一份自己的日期陣列，光日期就要多佔半個 MB。

用法：
    python scripts/fetch_us.py                 # 抓一年
    python scripts/fetch_us.py --range 2y      # 抓兩年
    python scripts/fetch_us.py --sleep 1.0     # 放慢一點（Yahoo 會限流）
    python scripts/fetch_us.py --only NVDA,MU  # 只抓這幾檔（其餘沿用舊檔）

## 連續失敗就放棄

177 檔是這支腳本與其他抓取腳本最大的差別。Yahoo 真的開始限流時，每一檔都會走完
`fetch_text` 的三次重試（3、6、9 秒），177 檔就是**磨五十分鐘**才知道整批都失敗 ——
而它掛在每日排程上，那五十分鐘是實實在在佔著 runner。

所以連續失敗 `--give-up` 檔就停：剩下的沿用舊資料，最壞情況縮到四分鐘以內。
限流是整批性的，連著十幾檔都失敗就不會是「剛好這幾檔有問題」。
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime

import quotes
import twse
import us


def parse_args():
    ap = argparse.ArgumentParser(description="抓美股日線")
    ap.add_argument("--range", default="1y", help="Yahoo 的 range 參數（預設 1y）")
    ap.add_argument("--sleep", type=float, default=0.7, help="每檔之間的間隔秒數")
    ap.add_argument("--only", default="", help="只抓這幾檔，逗號分隔")
    ap.add_argument("--give-up", type=int, default=12,
                    help="連續失敗幾檔就放棄，剩下的沿用舊資料（0 為不放棄）")
    return ap.parse_args()


def main() -> int:
    args = parse_args()
    link = us.load_link()
    names = us.us_tickers(link)
    for sym in (us.TW_INDEX, us.US_INDEX):
        names.setdefault(sym, sym)

    wanted = [s.strip() for s in args.only.split(",") if s.strip()] or sorted(names)
    unknown = [s for s in wanted if s not in names]
    if unknown:
        print(f"! 不在對照表裡的代號：{'、'.join(unknown)}")

    old = {}
    if us.MARKET_PATH.exists():
        payload = json.loads(us.MARKET_PATH.read_text(encoding="utf-8"))
        axis = payload.get("d") or []
        for sym, row in (payload.get("items") or {}).items():
            old[sym] = {d: c for d, c in zip(axis, row.get("c") or []) if c is not None}

    series = dict(old)
    failed = []
    skipped = []
    streak = 0
    for i, sym in enumerate(wanted, 1):
        try:
            rows = quotes.fetch_yahoo(sym, rng=args.range)
            series[sym] = dict(rows)
            streak = 0
            print(f"  [{i}/{len(wanted)}] {sym:<10} {len(rows)} 天"
                  f"（{rows[0][0]} ~ {rows[-1][0]}）")
        except Exception as err:
            failed.append(sym)
            streak += 1
            print(f"  [{i}/{len(wanted)}] {sym:<10} 失敗：{type(err).__name__}: {err}")
            if args.give_up and streak >= args.give_up:
                skipped = wanted[i:]
                print()
                print(f"! 連續 {streak} 檔失敗，不再往下抓（多半是被限流）。"
                      f"剩下的 {len(skipped)} 檔沿用舊資料。")
                break
        if i < len(wanted):
            time.sleep(args.sleep)

    if not series:
        print("沒有抓到任何資料")
        return 1

    # 日期軸取所有標的的聯集：個別標的停牌或上市較晚的日子就留 null
    axis = sorted({d for row in series.values() for d in row})
    items = {}
    for sym in sorted(series):
        row = series[sym]
        items[sym] = {"n": names.get(sym, sym), "c": [row.get(d) for d in axis]}

    payload = {
        "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "range": args.range,
        "d": axis,
        "items": items,
    }
    twse.write_json(us.MARKET_PATH, payload)
    kb = us.MARKET_PATH.stat().st_size / 1024
    print(f"\n{len(items)} 檔 / {len(axis)} 個交易日（{axis[0]} ~ {axis[-1]}）"
          f" -> {us.MARKET_PATH.relative_to(twse.ROOT)}（{kb:.0f} KB）")
    if failed:
        print(f"! 這幾檔沒抓到，沿用舊資料或缺席：{'、'.join(failed)}")
    # 整批都沒抓到就回非零：接在後面的 build_us.py 會拿舊資料重算一份一模一樣的東西，
    # 那不算錯，但排程的紀錄上要看得出「今天其實沒更新到」。
    # 提早放棄時剩下的那些根本沒試過，不能算進成功的那一邊。
    if not [s for s in wanted if s not in failed and s not in skipped]:
        print("! 一檔都沒抓到，market.json 維持原樣")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
