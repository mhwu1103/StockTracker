"""抓當週的集保戶股權分散表。

    https://opendata.tdcc.com.tw/getOD.ashx?id=1-5
        -> docs/data/holders/weekly/YYYY-MM-DD.json（檔名是資料日）

集保一週只結算一次（每週五），但這一支每天跑也沒關係：資料日還沒換的話，
解出來的內容與已存的那一份一字不差，就不會再寫一次，也不會產生 git 差異。

用法：
    python scripts/fetch_holders.py
    python scripts/fetch_holders.py --dry-run     只解析、不寫檔
"""

from __future__ import annotations

import argparse
import sys

import holders
import twse


def main() -> int:
    parser = argparse.ArgumentParser(description="抓集保戶股權分散表")
    parser.add_argument("--dry-run", action="store_true", help="只解析並印出結果，不寫檔")
    args = parser.parse_args()

    print("集保戶股權分散表（TDCC）")
    try:
        text = holders.fetch_csv()
    except Exception as err:
        print(f"  ! 抓取失敗 —— {err}")
        return 1

    try:
        date_iso, stocks, partial = holders.parse_csv(text)
    except RuntimeError as err:
        print(f"  ! 解析失敗 —— {err}")
        return 1

    print(f"  資料日 {date_iso}：{len(stocks)} 檔"
          + ("（檔案在中途被切斷，只解到一部分）" if partial else ""))
    sample = stocks.get("2330")
    if sample:
        # 累積梯的索引就是級距編號減一：cum15 是千張、cum12 是 400 張以上，
        # 散戶（100 張以下）＝ cum1 減 cum10
        print(f"  例：2330 千張大戶 {sample[14]}%（{sample[20]:,} 戶）、"
              f"400 張以上 {sample[11]}%（{sample[17]:,} 戶）、"
              f"散戶 {round(sample[0] - sample[9], 2)}%、股東 {sample[21]:,} 人")

    if args.dry_run:
        print("  --dry-run：不寫檔")
        return 0

    wrote, why = holders.save_snapshot(date_iso, stocks, source="live",
                                   partial=partial, truncated=partial)
    path = holders.snapshot_path(date_iso).relative_to(twse.ROOT)
    print(f"  {'已寫入 ' + str(path) if wrote else '未寫入（' + why + '）'}")

    print("\n接著執行：python scripts/build_holders.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
