"""把當日的新進榜／連續進榜清單與籌碼異動推播到 Telegram。

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
    python scripts/notify_telegram.py --scope tpex --dry-run    # 只推上櫃排行
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import defaultdict

import requests

import institutions as insti
import twse

# 要推播哪幾種連續天數，順序即為訊息中的排列順序
STREAK_GROUPS = [1, 2, 3, 5]
MAX_PER_GROUP = 20          # 每組最多列幾檔，超出的數量會明講，不靜默截斷
API_URL = "https://api.telegram.org/bot{token}/sendMessage"


def escape(text: str) -> str:
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_message(payload: dict, site_url: str = "", scope_name: str = "",
                  total_label: str = "大盤", insti_rows=None) -> str:
    by_streak = defaultdict(list)
    for stock in payload["stocks"]:
        if stock.get("streak") in STREAK_GROUPS:
            by_streak[stock["streak"]].append(stock)

    lines = [
        f"<b>📊 台股成交值排行{scope_name} · {payload['date']}</b>",
        f"{total_label}成交值 {payload['marketValue'] / 1e8:,.0f} 億",
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

    lines += insti_lines(insti_rows)

    if site_url:
        lines += ["", f'<a href="{escape(site_url)}">看完整排行</a>']
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# 籌碼異動（土洋同買／對作）
# --------------------------------------------------------------------------- #
# 網站上那兩組榜的推播版。門檻與網站「法人」頁的預設值一致 —— 兩邊看到的名單
# 不一樣的話，使用者會以為其中一邊壞了。
#
# 每一組只佔**一行**（名稱與代號用頓號串起來），不是一檔一行：現有的訊息已經有
# 四組進榜清單，再加四組一檔一行會逼近 Telegram 的 4,096 字元上限，而超過的部分
# 是被截掉、不是被拒絕 —— 那種壞法在收到訊息之前看不出來。
INSTI_MIN_OKU = 0.5         # 兩邊各自都要達到的金額（億）
INSTI_MAX = 8               # 每一組最多列幾檔

# 標籤 -> 訊息裡的標題。
INSTI_GROUPS = [
    ("both", "🤝 土洋同買"),
    ("bothSell", "🤝 土洋同賣"),
    ("foBuy", "⚔️ 對作·外資買投信賣"),
    ("foSell", "⚔️ 對作·外資賣投信買"),
]


def insti_tag_of(fo: float, tr: float, min_oku: float):
    """與 app.js 的 instiTagOf() 同一個規則：兩邊各自都要達到門檻。"""
    if fo >= min_oku and tr >= min_oku:
        return "both"
    if fo <= -min_oku and tr <= -min_oku:
        return "bothSell"
    if fo >= min_oku and tr <= -min_oku:
        return "foBuy"
    if fo <= -min_oku and tr >= min_oku:
        return "foSell"
    return None


def insti_groups(date_iso: str, scope: str = "all", min_oku: float = INSTI_MIN_OKU):
    """當日的法人檔 -> {標籤: [(排序鍵, 代號, 簡稱, 外資億, 投信億)]}。

    那一天還沒有法人資料就回 None —— 法人資料涵蓋的交易日比排行短，
    而「還沒抓到」與「今天沒有任何異動」必須分得出來。
    """
    path = insti.daily_path(date_iso)
    if not path.exists():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    markets = insti.MARKETS if scope == "all" else (scope,)
    groups = {key: [] for key, _ in INSTI_GROUPS}
    for market in markets:
        for code, row in ((payload.get("stocks") or {}).get(market) or {}).items():
            name = row[insti.F_NAME]
            close = row[insti.F_CLOSE]
            fo = insti.oku(row[insti.F_FO], close)
            tr = insti.oku(row[insti.F_TR], close)
            tag = insti_tag_of(fo, tr, min_oku)
            if not tag:
                continue
            # 同買同賣看合計，對作看較小的那一邊 —— 對作的合計接近零（兩邊互相
            # 抵消），拿它排序等於隨機
            key = abs(fo + tr) if tag in ("both", "bothSell") else min(abs(fo), abs(tr))
            groups[tag].append((key, code, name, fo, tr))
    for rows in groups.values():
        rows.sort(reverse=True)
    return groups


def insti_lines(groups, min_oku: float = INSTI_MIN_OKU, only: set = None) -> list:
    """籌碼那一段的訊息行。only 給了就只留那幾檔（自選股推播用）。"""
    if groups is None:
        return []
    lines = ["", f"<b>🧭 籌碼異動 · 外資與投信各自 {min_oku} 億以上</b>"]
    empty = True
    for key, title in INSTI_GROUPS:
        rows = groups[key]
        if only is not None:
            rows = [r for r in rows if r[1] in only]
        if not rows:
            continue
        empty = False
        names = "、".join(f"{escape(name)} {code}" for _, code, name, _, _ in rows[:INSTI_MAX])
        more = f" …另 {len(rows) - INSTI_MAX} 檔" if len(rows) > INSTI_MAX else ""
        lines.append(f"{title}（{len(rows)}）：{names}{more}")
    if empty:
        return []
    # 金額是估算的這件事每次都要講，不然這幾個數字看起來像官方數字
    lines.append("<i>金額為估算（買賣超股數 × 收盤價），非官方數字。</i>")
    return lines

def parse_watchlist(raw: str) -> list:
    return [c.strip() for c in str(raw or "").replace("\n", ",").split(",") if c.strip()]


def build_watch_message(payload: dict, prev: dict, codes: list, site_url: str = "",
                        scope_name: str = "", total_label: str = "大盤",
                        insti_rows=None) -> str:
    """只講自選股：今天在不在榜上、名次多少、是不是剛進榜或剛掉出榜。"""
    today = {s["code"]: s for s in payload["stocks"] if s["rank"] <= twse.STREAK_RANK}
    before = {s["code"]: s for s in (prev or {}).get("stocks", []) if s["rank"] <= twse.STREAK_RANK}

    lines = [
        f"<b>⭐ 自選股{scope_name} · {payload['date']}</b>",
        f"{total_label}成交值 {payload['marketValue'] / 1e8:,.0f} 億",
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

    # 自選股那一封只講自選的籌碼異動。進不進榜與有沒有法人異動是兩件事，
    # 所以這一段不受上面的「在榜上／掉出榜」影響，自選股全部都看。
    lines += insti_lines(insti_rows, only=set(codes))

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
    parser.add_argument("--scope", choices=twse.SCOPES, default="all",
                        help="要推播哪個範圍的排行（預設 all 全部）")
    args = parser.parse_args()

    dates = twse.existing_dates(args.scope)
    if not dates:
        print(f"{twse.SCOPE_NAMES[args.scope]}沒有任何資料，請先執行 fetch_daily.py 與 build_history.py")
        return 1

    date_iso = args.date or dates[-1]
    today = twse.taipei_today().isoformat()
    if not args.force and not args.date and date_iso != today:
        print(f"最新資料是 {date_iso}，不是今天（{today}），可能是非交易日，不發送。")
        return 0

    payload = json.loads(twse.daily_path(date_iso, args.scope).read_text(encoding="utf-8"))
    site_url = os.environ.get("SITE_URL", "")
    codes = parse_watchlist(args.watchlist or os.environ.get("WATCHLIST", ""))
    # 「全部」是預設範圍，標題就不必特別寫出來
    scope_name = "" if args.scope == "all" else f"（{twse.SCOPE_NAMES[args.scope]}）"
    total_label = "大盤" if args.scope == "all" else twse.SCOPE_NAMES[args.scope]

    insti_rows = insti_groups(date_iso, args.scope)
    if insti_rows is None:
        print(f"{date_iso} 還沒有法人資料，這一封不含籌碼異動那一段。")

    if codes:
        i = dates.index(date_iso)
        prev = (
            json.loads(twse.daily_path(dates[i - 1], args.scope).read_text(encoding="utf-8"))
            if i > 0 else None
        )
        on_board = {s["code"] for s in payload["stocks"] if s["rank"] <= twse.STREAK_RANK}
        was_on = {s["code"] for s in (prev or {}).get("stocks", []) if s["rank"] <= twse.STREAK_RANK}
        # 自選股完全沒動靜就別發，每天一封「今天沒事」只會讓人關掉通知
        if not any(c in on_board or c in was_on for c in codes):
            print(f"自選股（{len(codes)} 檔）在 {date_iso} 都沒有進出榜，不發送。")
            return 0
        message = build_watch_message(payload, prev, codes, site_url, scope_name,
                                      total_label, insti_rows)
    else:
        message = build_message(payload, site_url, scope_name, total_label, insti_rows)

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
