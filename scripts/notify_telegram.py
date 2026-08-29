"""把當日的新進榜／連續進榜清單推播到 Telegram。

需要兩個環境變數（請在 GitHub 設成 repository secret，不要寫進程式碼或 commit）：
    TELEGRAM_BOT_TOKEN
    TELEGRAM_CHAT_ID
選用：
    SITE_URL   有設定的話，訊息末端會附上網站連結
    WATCHLIST  逗號分隔的代號（例如 2330,2454）。有設定時只推這幾檔的動態，
               不再推全市場的新進榜清單。網站上的自選股存在瀏覽器裡，
               不會自動同步到這裡，要自己把清單設成 secret。

用法：
    python scripts/notify_telegram.py             # 只在有當日新資料時發送
    python scripts/notify_telegram.py --dry-run   # 只印出訊息，不發送（不需要金鑰）
    python scripts/notify_telegram.py --force     # 資料不是今天的也照發（測試用）
    python scripts/notify_telegram.py --watchlist 2330,2454 --dry-run
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


def parse_watchlist(raw: str) -> list:
    return [c.strip() for c in str(raw or "").replace("\n", ",").split(",") if c.strip()]


def build_watch_message(payload: dict, prev: dict, codes: list, site_url: str = "") -> str:
    """只講自選股：今天在不在榜上、名次多少、是不是剛進榜或剛掉出榜。"""
    today = {s["code"]: s for s in payload["stocks"] if s["rank"] <= twse.STREAK_RANK}
    before = {s["code"]: s for s in (prev or {}).get("stocks", []) if s["rank"] <= twse.STREAK_RANK}

    lines = [
        f"<b>⭐ 自選股 · {payload['date']}</b>",
        f"大盤成交值 {payload['marketValue'] / 1e8:,.0f} 億",
        "",
    ]

    on_board = [c for c in codes if c in today]
    dropped = [c for c in codes if c not in today and c in before]

    if on_board:
        lines.append(f"<b>📈 在榜上（{len(on_board)} 檔）</b>")
        for code in sorted(on_board, key=lambda c: today[c]["rank"]):
            stock = today[code]
            tag = " 🆕" if stock.get("streak") == 1 else f" · 連 {stock['streak']} 天"
            lines.append(
                f"#{stock['rank']} {escape(stock['name'])} {code}"
                f" · {stock['value'] / 1e8:,.1f} 億{tag}"
            )
    else:
        lines.append("<b>📈 在榜上</b>\n（無）")

    if dropped:
        lines += ["", f"<b>📉 今日掉出榜（{len(dropped)} 檔）</b>"]
        for code in sorted(dropped, key=lambda c: before[c]["rank"]):
            stock = before[code]
            lines.append(f"#{stock['rank']} {escape(stock['name'])} {code} → 已不在前 {twse.STREAK_RANK}")

    missing = [c for c in codes if c not in today and c not in before]
    if missing:
        lines += ["", f"<i>未在榜上：{escape('、'.join(missing))}</i>"]

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
    parser.add_argument("--watchlist", help="逗號分隔的自選代號，蓋過 WATCHLIST 環境變數")
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
    site_url = os.environ.get("SITE_URL", "")
    codes = parse_watchlist(args.watchlist or os.environ.get("WATCHLIST", ""))

    if codes:
        i = dates.index(date_iso)
        prev = (
            json.loads(twse.daily_path(dates[i - 1]).read_text(encoding="utf-8"))
            if i > 0 else None
        )
        on_board = {s["code"] for s in payload["stocks"] if s["rank"] <= twse.STREAK_RANK}
        was_on = {s["code"] for s in (prev or {}).get("stocks", []) if s["rank"] <= twse.STREAK_RANK}
        # 自選股完全沒動靜就別發，每天一封「今天沒事」只會讓人關掉通知
        if not any(c in on_board or c in was_on for c in codes):
            print(f"自選股（{len(codes)} 檔）在 {date_iso} 都沒有進出榜，不發送。")
            return 0
        message = build_watch_message(payload, prev, codes, site_url)
    else:
        message = build_message(payload, site_url)

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
