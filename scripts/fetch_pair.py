"""抓同盤市場的日線 -> docs/data/{市場}/market.json。

清單來自 `docs/data/{市場}_link.json`（對照表裡出現過的每一檔，含 benchmarks），
另外補上該國大盤與台股加權 —— 那兩個不是給人看的標的，是族群漲跌要對照的基準。

台股那一邊**不抓**：repo 的 kline/ 已經有全市場的四價，重抓只是把每天最吃
請求數的那一步再放大一倍。理由與代價寫在 pair.py 的 docstring。

Yahoo 的代號寫法直接存在對照表的 `t` 裡（日股是四碼加 .T、韓股是六碼加 .KS
或 .KQ），拿到手可以直接餵給 quotes.fetch_yahoo。

## 連續失敗就放棄

與 fetch_us.py 同一個理由，而且這幾支**共用同一個 Yahoo 端點**、排在同一次
排程裡：美股那 177 檔跑完（實測 148 秒）才輪到日股與韓股。真的被限流的話是整批性的，
連著十幾檔都失敗就不會是「剛好這幾檔有問題」——停下來，剩下的沿用舊資料。

而且**後面的市場最容易中槍**：排在第三順位的韓股是累積請求數最多的時候才開始跑。
所以三支各自有自己的 --give-up 與 market.json，前面那支失敗不會波及後面那支的舊資料。

用法：
    python scripts/fetch_pair.py jp                 # 日股，抓一年
    python scripts/fetch_pair.py kr                 # 韓股
    python scripts/fetch_pair.py kr --range 2y      # 抓兩年
    python scripts/fetch_pair.py kr --sleep 1.0     # 放慢一點（Yahoo 會限流）
    python scripts/fetch_pair.py kr --only 005930.KS  # 只抓這幾檔（其餘沿用舊檔）
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime

import pair
import quotes
import twse


def parse_args():
    ap = argparse.ArgumentParser(description="抓同盤市場（日股／韓股）的日線")
    ap.add_argument("market", choices=sorted(pair.MARKETS), help="要抓哪一個市場")
    ap.add_argument("--range", default="1y", help="Yahoo 的 range 參數（預設 1y）")
    ap.add_argument("--sleep", type=float, default=0.7, help="每檔之間的間隔秒數")
    ap.add_argument("--only", default="", help="只抓這幾檔，逗號分隔")
    ap.add_argument("--give-up", type=int, default=12,
                    help="連續失敗幾檔就放棄，剩下的沿用舊資料（0 為不放棄）")
    return ap.parse_args()


def main() -> int:
    args = parse_args()
    market = pair.market_of(args.market)
    link = pair.load_link(market)
    names = pair.foreign_tickers(market, link)
    # 兩個大盤：該國大盤是外股那一欄的底，加權是台股那一欄的底。
    # 加權在美股那份 market.json 裡也有一份，但跨檔案去讀會讓這一頁的資料
    # 取決於美股那一步有沒有成功 —— 多一個請求換掉那個耦合，划算。
    names.setdefault(market.index, market.index_name)
    names.setdefault(pair.TW_INDEX, "加權指數")

    wanted = [s.strip() for s in args.only.split(",") if s.strip()] or sorted(names)
    unknown = [s for s in wanted if s not in names]
    if unknown:
        print(f"! 不在對照表裡的代號：{'、'.join(unknown)}")

    old = {}
    if market.market_path.exists():
        payload = json.loads(market.market_path.read_text(encoding="utf-8"))
        axis = payload.get("d") or []
        for sym, row in (payload.get("items") or {}).items():
            old[sym] = {d: c for d, c in zip(axis, row.get("c") or []) if c is not None}

    series = dict(old)
    failed, skipped, streak = [], [], 0
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

    # 日期軸取所有標的的聯集：鎧俠 2024-12 才上市，那之前的日子留 null
    axis = sorted({d for row in series.values() for d in row})
    items = {sym: {"n": names.get(sym, sym), "c": [series[sym].get(d) for d in axis]}
             for sym in sorted(series)}

    payload = {
        "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "range": args.range,
        "d": axis,
        "items": items,
    }
    twse.write_json(market.market_path, payload)
    kb = market.market_path.stat().st_size / 1024
    print(f"\n{market.label} {len(items)} 檔 / {len(axis)} 個交易日（{axis[0]} ~ {axis[-1]}）"
          f" -> {market.market_path.relative_to(twse.ROOT)}（{kb:.0f} KB）")
    if failed:
        print(f"! 這幾檔沒抓到，沿用舊資料或缺席：{'、'.join(failed)}")
    # 整批都沒抓到就回非零：build_pair.py 接在後面會拿舊資料重算一份一模一樣的東西，
    # 那不算錯，但排程的紀錄上要看得出「今天其實沒更新到」。
    if not [s for s in wanted if s not in failed and s not in skipped]:
        print(f"! 一檔都沒抓到，{market.key}/market.json 維持原樣")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
