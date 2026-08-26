"""把當日的新進榜／連續進榜清單推播到 Telegram。

需要兩個環境變數（請在 GitHub 設成 repository secret，不要寫進程式碼或 commit）：
    TELEGRAM_BOT_TOKEN
    TELEGRAM_CHAT_ID
選用：
    SITE_URL   有設定的話，訊息末端會附上網站連結

用法：
    python scripts/notify_telegram.py             # 只在有當日新資料時發送
    python scripts/notify_telegram.py --dry-run   # 只印出訊息，不發送（不需要金鑰）
    python scripts/notify_telegram.py --force     # 資料不是今天的也照發（測試用）
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import defaultdict

import requests

import twse

# 要推播哪幾種連續天數，順序即為訊息中的排列順序
STREAK_GROUPS = [1, 2, 3, 5]
MAX_PER_GROUP = 20          # 每組最多列幾檔，超出的數量會明講，不靜默截斷
API_URL = "https://api.telegram.org/bot{token}/sendMessage"


def escape(text: str) -> str:
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_message(payload: dict, site_url: str = "") -> str:
    by_streak = defaultdict(list)
    for stock in payload["stocks"]:
        if stock.get("streak") in STREAK_GROUPS:
            by_streak[stock["streak"]].append(stock)

    lines = [
        f"<b>📊 台股成交值排行 · {payload['date']}</b>",
        f"大盤成交值 {payload['marketValue'] / 1e8:,.0f} 億",
    ]

    for days in STREAK_GROUPS:
        group = sorted(by_streak.get(days, []), key=lambda s: s["rank"])
        title = "🆕 今日新進榜" if days == 1 else f"📌 連續 {days} 天"
        lines += ["", f"<b>{title}（{len(group)} 檔）</b>"]
        if not group:
            lines.append("（無）")
            continue
        for stock in group[:MAX_PER_GROUP]:
            lines.append(
                f"#{stock['rank']} {escape(stock['name'])} {stock['code']}"
                f" · {stock['value'] / 1e8:,.1f} 億"
            )
        if len(group) > MAX_PER_GROUP:
            lines.append(f"…另有 {len(group) - MAX_PER_GROUP} 檔未列出")

    if site_url:
        lines += ["", f'<a href="{escape(site_url)}">看完整排行</a>']
    return "\n".join(lines)


def send(token: str, chat_id: str, text: str, retries: int = 3) -> None:
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            resp = requests.post(API_URL.format(token=token), json=payload, timeout=20)
            if resp.ok and resp.json().get("ok"):
                return
            # Telegram 的錯誤描述不含金鑰，可以安全印出
            last_err = f"HTTP {resp.status_code}: {resp.text[:300]}"
        except Exception as err:
            # 網路層的例外訊息會帶上完整網址，而網址裡就有 token，
            # 直接印出等於把金鑰寫進 log，所以一律先抹掉再輸出。
            last_err = f"{type(err).__name__}: {str(err).replace(token, '<TOKEN>')}"
        if attempt < retries:
            print(f"  ! 發送失敗（{last_err}），5 秒後重試 ({attempt}/{retries})")
            time.sleep(5)
    raise RuntimeError(f"Telegram 發送失敗：{last_err}")


def main() -> int:
    parser = argparse.ArgumentParser(description="推播當日新進榜到 Telegram")
    parser.add_argument("--dry-run", action="store_true", help="只印出訊息，不實際發送")
    parser.add_argument("--force", action="store_true", help="資料不是今天的也照發")
    parser.add_argument("--date", help="指定要推播的日期 YYYY-MM-DD（預設為最新一天）")
    args = parser.parse_args()

    dates = twse.existing_dates()
    if not dates:
        print("沒有任何資料，請先執行 fetch_daily.py")
        return 1

    date_iso = args.date or dates[-1]
    today = twse.taipei_today().isoformat()
    if not args.force and not args.date and date_iso != today:
        print(f"最新資料是 {date_iso}，不是今天（{today}），可能是非交易日，不發送。")
        return 0

    payload = json.loads(twse.daily_path(date_iso).read_text(encoding="utf-8"))
    message = build_message(payload, os.environ.get("SITE_URL", ""))

    if args.dry_run:
        print(message)
        print(f"\n(訊息長度 {len(message)} 字元，Telegram 上限 4096)")
        return 0

    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        print("未設定 TELEGRAM_BOT_TOKEN／TELEGRAM_CHAT_ID，略過推播。")
        return 0

    send(token, chat_id, message)
    print(f"已推播 {date_iso} 的新進榜清單（{len(message)} 字元）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
