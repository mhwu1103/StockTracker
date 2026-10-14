"""網站只留最近 N 天的每日原始檔，更早的刪掉。

    python scripts/prune_data.py                 # 預設留 730 個日曆天（約 2 年）
    python scripts/prune_data.py --dry-run       # 只列出會刪什麼

GitHub Pages 發佈的網站上限是 1 GB，每日資料一年約長 130 MB；不修剪的話，網站
每年自己就會長大到碰牆。這裡只刪**原始檔**（排行、四價、法人每日檔），K 線、結構、
法人累計、歷史等衍生檔由各支 build_*.py 依照現存的原始檔重建，過期的會自己清掉，
所以這一支要排在所有 build 之前。融資的序列（margin.json）沿用已經算好的舊值，不會跟著被修掉。

回測要用的長歷史不放在網站上：整包原始檔壓成 zip 放在 GitHub Release，
還原方式見 BACKTEST.md。
"""

from __future__ import annotations

import argparse
from datetime import date, timedelta

import twse

# 以日期命名（YYYY-MM-DD.json）的原始資料夾
RAW_DIRS = [
    twse.DATA_DIR / "daily" / "all",
    twse.DATA_DIR / "daily" / "twse",
    twse.DATA_DIR / "daily" / "tpex",
    twse.DATA_DIR / "close" / "twse",
    twse.DATA_DIR / "close" / "tpex",
    twse.DATA_DIR / "insti" / "daily",
    twse.DATA_DIR / "margin" / "daily",
]


def parse_args():
    ap = argparse.ArgumentParser(description="刪掉網站保留期限以前的每日原始檔")
    ap.add_argument("--keep-days", type=int, default=730, help="保留最近幾個日曆天（預設 730）")
    ap.add_argument("--dry-run", action="store_true", help="只列出會刪的檔案，不刪")
    return ap.parse_args()


def is_dated(stem: str) -> bool:
    try:
        date.fromisoformat(stem)
        return True
    except ValueError:
        return False


def main() -> int:
    args = parse_args()
    # 以資料裡最新的交易日起算，不用今天：排程停擺幾天也不會多刪
    latest = max((p.stem for p in RAW_DIRS[0].glob("*.json") if is_dated(p.stem)), default=None)
    if latest is None:
        print("daily/all/ 沒有任何每日檔，不修剪")
        return 0
    cutoff = (date.fromisoformat(latest) - timedelta(days=args.keep_days)).isoformat()
    print(f"最新 {latest}，保留 {cutoff} 起的 {args.keep_days} 個日曆天")

    total = 0
    for folder in RAW_DIRS:
        old = sorted(p for p in folder.glob("*.json") if is_dated(p.stem) and p.stem < cutoff)
        if not old:
            continue
        total += len(old)
        rel = folder.relative_to(twse.DATA_DIR).as_posix()
        print(f"  {rel}/：{len(old)} 個（{old[0].stem} ~ {old[-1].stem}）")
        if not args.dry_run:
            for p in old:
                p.unlink()
    print(f"{'會刪' if args.dry_run else '已刪'} {total} 個檔案")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
