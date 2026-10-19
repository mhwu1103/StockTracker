"""把當日的新進榜／連續進榜清單、籌碼異動與資金流向推播到 Telegram。

需要兩個環境變數（請在 GitHub 設成 repository secret，不要寫進程式碼或 commit）：
    TELEGRAM_BOT_TOKEN
    TELEGRAM_CHAT_ID
選用：
    SITE_URL   有設定的話，訊息末端會附上網站連結
    WATCHLIST  逗號分隔的代號（例如 2330,2454）。有設定時，全市場的兩則（排行、籌碼與資金）之後
               再多發兩則只講這幾檔的動態（進出榜 + 跌破／站回 5、10 日線 +
               逐檔的籌碼動靜 + 當天公布的月營收）：分段版與族群版（族群依網站題材分類自動判斷，
               secret 只放代號）。自選股當天沒動靜就只發全市場的兩則。
               **檔數沒有上限** —— 排程本來就對全市場算一次，選幾檔不影響成本。
               網站上的自選股存在瀏覽器裡，不會自動同步到這裡，要自己把清單設成
               secret（刻意不寫進 repo：那會讓「誰在看哪幾檔」永久留在 git 歷史裡）。

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


# --------------------------------------------------------------------------- #
# 排版
# --------------------------------------------------------------------------- #
# 手機上一長串清單很難掃，所以：
#   - 長清單收進可展開的引用區塊（Telegram 的 <blockquote expandable>），收合時只露
#     前幾行，標題與檔數一眼看完，想看全部再點開
#   - 每一段的說明不跟在段落後面，集中到訊息最後一個「說明」區塊
#   - 題材名稱裡的「 · 」換成「／」，不跟欄位分隔符號混在一起
FOLD_MIN = 6                # 超過幾行才收合；短清單直接攤開比點開快
NOTE = "\x00"               # 說明行的記號，finish() 會把它們搬到訊息最後
GAP = "　"                  # 欄位之間用全形空白，比「 · 」安靜


def fold(rows: list) -> list:
    """清單行數多就收進可展開的引用區塊。"""
    if len(rows) <= FOLD_MIN:
        return rows
    return ["<blockquote expandable>" + "\n".join(rows) + "</blockquote>"]


def note(text: str) -> str:
    return NOTE + text


def finish(lines: list) -> str:
    """把散在各段的說明行搬到最後（去重），收成一個可展開的區塊。"""
    body = [l for l in lines if not l.startswith(NOTE)]
    notes = list(dict.fromkeys(l[1:] for l in lines if l.startswith(NOTE)))
    if notes:
        body += ["", "<blockquote expandable><i>ℹ️ 說明\n" + "\n".join(f"• {n}" for n in notes)
                 + "</i></blockquote>"]
    return "\n".join(body)


def tidy(name: str) -> str:
    return escape(name).replace(" · ", "／")


def is_stock(code: str) -> bool:
    """普通股：4 碼數字、不是 0 開頭。跟 sector_flow.common() 同一個判斷。"""
    return len(code) == 4 and code.isdigit() and not code.startswith("0")


def build_message(payload: dict, site_url: str = "", scope_name: str = "",
                  total_label: str = "大盤") -> str:
    """第一則：成交值排行的進榜清單。"""
    by_streak = defaultdict(list)
    for stock in payload["stocks"]:
        # 進榜清單只列個股：ETF（0 開頭）與特別股（5 碼）會把債券 ETF 這類東西擠進新進榜
        if stock.get("streak") in STREAK_GROUPS and is_stock(stock["code"]):
            by_streak[stock["streak"]].append(stock)

    # 第三行是總覽：不用往下滑就知道今天各組有幾檔
    counts = "｜".join(("新進" if d == 1 else f"連{d}") + f" {len(by_streak.get(d, []))}"
                      for d in STREAK_GROUPS)
    lines = [
        f"<b>📊 台股成交值排行{scope_name} · {payload['date']}</b>",
        f"{total_label}成交值 {payload['marketValue'] / 1e8:,.0f} 億",
        counts,
    ]

    for days in STREAK_GROUPS:
        group = sorted(by_streak.get(days, []), key=lambda s: s["rank"])
        title = "🆕 今日新進榜" if days == 1 else f"📌 連續 {days} 天"
        lines += ["", f"<b>{title} · {len(group)} 檔</b>"]
        if not group:
            lines.append("（無）")
            continue
        rows = [f"#{s['rank']} <b>{escape(s['name'])}</b> {s['code']}{GAP}{s['value'] / 1e8:,.1f} 億"
                for s in group[:MAX_PER_GROUP]]
        if len(group) > MAX_PER_GROUP:
            rows.append(f"…另有 {len(group) - MAX_PER_GROUP} 檔未列出")
        lines += fold(rows)

    if site_url:
        lines += ["", f'<a href="{escape(site_url)}">看完整排行</a>']
    return finish(lines)


def build_money_message(date_iso: str, scope_name: str = "", insti_rows=None,
                        flow_lines=None) -> str:
    """第二則：籌碼異動與資金流向。兩段都沒有就回空字串（不發）。

    跟排行拆成兩則：擠在同一則時要滑好幾頁，而且逼近 4,096 字元上限。
    """
    body = insti_lines(insti_rows) + (flow_lines or [])
    if not body:
        return ""
    return finish([f"<b>🧭 籌碼與資金{scope_name} · {date_iso}</b>"] + body)


# --------------------------------------------------------------------------- #
# 籌碼異動（土洋同買／對作）
# --------------------------------------------------------------------------- #
# 網站上那兩組榜的推播版。門檻與網站「法人」頁的預設值一致 —— 兩邊看到的名單
# 不一樣的話，使用者會以為其中一邊壞了。
#
# 這一段跟排行分開發，一檔一行、附外資與投信金額，長的那幾組收合起來。每組仍只列
# 前 INSTI_MAX 檔：Telegram 超過 4,096 字元是被截掉、不是被拒絕 —— 那種壞法在收到
# 訊息之前看不出來。
INSTI_MIN_OKU = 0.5         # 兩邊各自都要達到的金額（億）
INSTI_MAX = 8               # 每一組最多列幾檔
INSTI_NOTE = "法人金額為估算（買賣超股數 × 收盤價，單位億），非官方數字。"

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
    lines = ["", f"<b>籌碼異動</b>（外資與投信各自 {min_oku} 億以上）"]
    empty = True
    for key, title in INSTI_GROUPS:
        rows = groups[key]
        if only is not None:
            rows = [r for r in rows if r[1] in only]
        if not rows:
            continue
        empty = False
        items = [f"<b>{escape(name)}</b> {code}{GAP}外 {fo:+,.1f}／投 {tr:+,.1f}"
                 for _, code, name, fo, tr in rows[:INSTI_MAX]]
        if len(rows) > INSTI_MAX:
            items.append(f"…另 {len(rows) - INSTI_MAX} 檔")
        lines += ["", f"{title} · {len(rows)} 檔"] + fold(items)
    if empty:
        return []
    # 金額是估算的這件事每次都要講，不然這幾個數字看起來像官方數字
    lines.append(note(INSTI_NOTE))
    return lines

# --------------------------------------------------------------------------- #
# 資金流向（依題材大類）
# --------------------------------------------------------------------------- #
# 兩種錢分開講，因為它們回答的是不同的問題：
#   成交值  網站「流向」分頁的口徑：榜上前 200 名依題材大類加總，跟昨天比。排序用
#           佔比變化（pp）而不是金額 —— 大盤整體縮量時金額會全部是負的，看不出錢
#           從哪一族轉到哪一族。附成交值加權漲跌，分得出是買上去還是砍下來。
#   法人    網站「資金 → 動向」的口徑：sector_flow.json 的三大法人近 5 日淨買賣，
#           日均差的正負號就是四象限的縱軸（加速或收斂）。
# 一檔可以屬於好幾個大類（題材本來就重疊），所以各族加總會大於榜上總額；分母一律
# 用榜上總額，每檔只算一次，跟網站一致。
# 兩段都是描述：回測顯示法人加碼的族之後並沒有值得交易的超額報酬（BACKTEST.md 2026-10-15）。
FLOW_TOP = 5                # 流入、流出各列幾族
SECTOR_FLOW_PATH = twse.DATA_DIR / "sector_flow.json"


def theme_members(codes: set) -> dict:
    """{題材大類: {代號}}，只留 codes 裡有的；一檔可以屬於好幾個大類。"""
    themes = (_json_or_none(THEMES_PATH) or {}).get("groups") or []
    out = {}
    for g in themes:
        members = {c for s in g["subs"] for c in s["codes"] if c in codes}
        if members:
            out[g["name"]] = members
    return out


def value_flow_lines(payload: dict, prev: dict) -> list:
    """成交值流向那一段：佔比增加最多、減少最多的大類。"""
    if not prev:
        return []
    top = lambda p: {s["code"]: s for s in p["stocks"] if s["rank"] <= twse.STREAK_RANK}
    today, before = top(payload), top(prev)
    total = sum(s["value"] for s in today.values())
    base_total = sum(s["value"] for s in before.values())
    if not total or not base_total:
        return []
    now_groups, base_groups = theme_members(set(today)), theme_members(set(before))

    rows = []
    for name in now_groups.keys() | base_groups.keys():
        cs, bs = now_groups.get(name, set()), base_groups.get(name, set())
        value = sum(today[c]["value"] for c in cs)
        base = sum(before[c]["value"] for c in bs)
        shift = (value / total - base / base_total) * 100
        priced = [today[c] for c in cs if today[c].get("changePct") is not None]
        weight = sum(s["value"] for s in priced)
        chg = sum(s["value"] * s["changePct"] for s in priced) / weight if weight else None
        rows.append((shift, name, value - base, chg))
    if not rows:
        return []
    rows.sort(reverse=True)

    def line(shift, name, flow, chg):
        price = "" if chg is None else f"{GAP}漲跌 {chg:+.2f}%"
        return f"{tidy(name)} <b>{shift:+.2f}pp</b>{GAP}{flow / 1e8:+,.0f} 億{price}"

    inflow = [r for r in rows if r[0] > 0][:FLOW_TOP]
    outflow = [r for r in reversed(rows) if r[0] < 0][:FLOW_TOP]
    lines = ["", f"<b>💰 成交值流向</b>（前 {twse.STREAK_RANK} 名，比昨天）"]
    lines += ["🔼 比重上升"] + [line(*r) for r in inflow] if inflow else []
    lines += ["🔽 比重下降"] + [line(*r) for r in outflow] if outflow else []
    lines.append(note("pp＝佔榜上成交值的比重變化，已扣掉大盤整體放量或縮量；後面依序是成交值增減與"
                      "成交值加權漲跌。比重上升但成交值減少，代表縮得比大盤少。"))
    return lines


def insti_flow_lines(date_iso: str, who: str = "三大") -> list:
    """法人資金動向那一段：近 5 日淨買、淨賣最多的大類，標加速或收斂。"""
    data = _json_or_none(SECTOR_FLOW_PATH) or {}
    days = data.get("days") or []
    # 不是同一天的就不放 —— 拿前一天的數字配今天的標題會誤導
    if not days or days[-1] != date_iso:
        return []
    rows = []
    for g in (data.get("groups") or {}).get("theme") or []:
        pt = (g["pts"].get(who) or [None])[-1]
        if pt:
            rows.append((pt[0], pt[1], g["name"]))
    if not rows:
        return []
    rows.sort(reverse=True)

    def line(net, diff, name):
        if net > 0:
            mood = "加碼中" if diff > 0 else "買盤收斂"
        else:
            mood = "賣壓收斂" if diff > 0 else "減碼中"
        return f"{tidy(name)} <b>{net:+,.1f} 億</b>{GAP}{mood}"

    buys = [r for r in rows if r[0] > 0][:FLOW_TOP]
    sells = [r for r in reversed(rows) if r[0] < 0][:FLOW_TOP]
    lines = ["", f"<b>🏦 法人動向</b>（{who}法人近 5 日淨買賣）"]
    lines += ["🔼 淨買"] + [line(*r) for r in buys] if buys else []
    lines += ["🔽 淨賣"] + [line(*r) for r in sells] if sells else []
    lines.append(note("加碼／收斂看近 5 日日均比近 20 日日均多或少。只講錢往哪裡跑，不是買賣訊號。"))
    return lines

FUT_PATH = twse.DATA_DIR / "futpage.json"


def futures_lines(date_iso: str) -> list:
    """期貨頁的兩個有回測支持的指標：外資約當大台的部位與近 20 日變化、散戶多空比；落在極端時加警示。"""
    d = _json_or_none(FUT_PATH) or {}
    if d.get("asof") != date_iso:          # 期交所的資料不是今天的就不放
        return []
    n, r = d["net"], d["retail"]
    lines = ["", "<b>📉 台指期</b>",
             f"外資約當大台 <b>{n['now']:+,}</b> 口{GAP}近 20 日 {n['chg20']:+,}（近一年第 {n['fastRank']}%）",
             f"散戶多空比 <b>{r['now']:+.1f}%</b>{GAP}近一年第 {r['rank']}%"]
    if n.get("fast"):
        lines.append(f"⚠️ 外資空單一個月加得特別快（最快的 {d['rules']['fast']}%）：之後 5 天常偏弱，短線別追高")
    o = d.get("fopt") or {}
    if o.get("now") is not None:
        lines.insert(3, f"外資選擇權 <b>{o['now']:+,.1f} 億</b>{GAP}近一年第 {o['rank']}%")
    if o.get("bear"):
        lines.append("⚠️ 外資選擇權偏空到近一年最低 20%：之後 5 天常偏弱")
    if r.get("hot"):
        lines.append(f"⚠️ 散戶偏多到近一年前 {d['rules']['hot']}%：反向指標，之後 5 天常偏弱")
    lines.append(note("台指期三項有回測支持：外資期貨部位看 20 日變化不看水位；外資選擇權多空淨額；散戶多空比是反向指標。都是之後 1～5 天的短線效果。"))
    return lines


# --------------------------------------------------------------------------- #
# 自選股的籌碼監控
# --------------------------------------------------------------------------- #
# 商用 App 把「能監控幾檔」做成付費階梯，是因為他們得為每個使用者在伺服器上跑掃描。
# 這裡沒有伺服器：排程對全市場算一次，使用者選幾檔完全不影響成本 ——
# 所以「不限檔數」在這個架構下不是功能，是預設。
#
# 真正要修的是另一件事：**送不送信的判斷本來只看進出榜**。自選股有籌碼異動、卻剛好
# 沒進前 200 名的話，整封信不會發 —— 而那正是最該通知的情況之一。實測 2026-09-03
# 有土洋標記的 75 檔裡，有 8 檔不在前 200 名。
#
# 四種事件，全部以**外資**為主軸（與「連買」頁同一個口徑）：
#   土洋標記   同買／同賣／對作，門檻與網站一致
#   連買連賣   3 天以上（insti/streak/ 只留 3 天以上的）
#   力道       今天是平常的幾倍，2 倍以上才算事件
#   逆勢       外資買而股價收黑、或外資賣而股價收紅
#
# 每一種都是**描述**不是判斷 —— 全站不提供買賣訊號，通知裡更不能有。
WATCH_FORCE_MIN = 2.0       # 力道幾倍以上才當成一則事件


def _json_or_none(path):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def insti_watch_events(date_iso: str, codes: list, min_oku: float = INSTI_MIN_OKU) -> dict:
    """自選股在這一天的籌碼動靜 -> {代號: (簡稱, 漲跌, 外資金額, [事件, ...])}。

    只回「真的有事件」的那幾檔。那一天還沒有法人資料就回 {}。
    衍生檔缺哪一份就少哪一種事件（例如資料起點附近沒有 base/，就沒有力道）——
    不是錯誤，是那一天還算不出來。
    """
    daily = _json_or_none(insti.daily_path(date_iso))
    if not daily:
        return {}
    wanted = set(codes)
    chg = (_json_or_none(insti.chg_path(date_iso)) or {}).get("chg") or {}
    base = (_json_or_none(insti.base_path(date_iso)) or {}).get("base") or {}
    runs = _json_or_none(insti.run_path(date_iso)) or {}
    cut = daily.get("cut") or insti.MIN_OKU

    # 連買／連賣天數：攤平成 {代號: 天數}
    streak = {}
    for stocks in (runs.get("stocks") or {}).values():
        for code, row in stocks.items():
            streak[code] = row[1]        # RUN_FIELDS 的 days，正買負賣

    out = {}
    for stocks in (daily.get("stocks") or {}).values():
        for code, row in stocks.items():
            if code not in wanted:
                continue
            name = row[insti.F_NAME]
            close = row[insti.F_CLOSE]
            fo = insti.oku(row[insti.F_FO], close)
            tr = insti.oku(row[insti.F_TR], close)
            moved = chg.get(code)
            events = []

            tag = insti_tag_of(fo, tr, min_oku)
            if tag:
                events.append(dict(INSTI_GROUPS)[tag].split(" ", 1)[-1])

            days = streak.get(code)
            if days:
                events.append(f"連{'買' if days > 0 else '賣'} {abs(days)} 天")

            norms = base.get(code)
            if norms:
                force = abs(fo) / max(norms[0], cut)
                if force >= WATCH_FORCE_MIN:
                    events.append(f"力道 {force:.1f} 倍")

            if moved and fo:
                if fo > 0 and moved < 0:
                    events.append("逆勢買超")
                elif fo < 0 and moved > 0:
                    events.append("逆勢賣超")

            if events:
                out[code] = (name, moved, fo, events)
    return out


def watch_insti_lines(events: dict) -> list:
    """自選股籌碼監控那一段的訊息行。沒有任何一檔有事件就整段不出現。"""
    if not events:
        return []
    lines = ["", f"<b>🧭 籌碼動靜 · {len(events)} 檔</b>"]
    # 事件多的排前面，同樣多就比外資金額 —— 一次動到三件事的比只動一件的值得先看
    for code, (name, moved, fo, items) in sorted(
            events.items(), key=lambda kv: (len(kv[1][3]), abs(kv[1][2])), reverse=True):
        pct = "" if moved is None else f"{GAP}{moved:+.2f}%"
        # 兩行：第一行是誰、漲跌、外資金額，第二行才是事件 —— 擠在一行時會在手機上亂折
        lines += [f"<b>{escape(name)}</b> {code}{pct}{GAP}外資 {fo:+,.1f} 億",
                  f"{GAP}└ " + "、".join(escape(e) for e in items)]
    lines.append(note(INSTI_NOTE))
    return lines

# --------------------------------------------------------------------------- #
# 自選股公布月營收
# --------------------------------------------------------------------------- #
# 讀營收頁的 revenue/（build_revenue.py 在推播之前跑）：公布日是本站第一次在
# 公開資訊觀測站彙總表上看到的那一天，所以「今天公布」＝今天的排程第一次看到。
# 會在今天第一次出現的只有最近兩個月（當月與晚報的上個月）。
REV_DIR = twse.DATA_DIR / "revenue"
REV_NOTE = "營收公布日是本站排程第一次看到的那一天；新高是比前 12 個月都高。"


def rev_watch_events(date_iso: str, codes: list) -> list:
    """[(月份, 列)]：自選股裡今天公布營收的。"""
    index = _json_or_none(REV_DIR / "index.json") or {}
    want = set(codes)
    out = []
    for meta in (index.get("months") or [])[:2]:
        block = _json_or_none(REV_DIR / f"{meta['m']}.json") or {}
        for r in block.get("rows") or []:
            if r.get("pub") == date_iso and r["c"] in want:
                out.append((meta["m"], r))
    return out


def watch_rev_lines(events: list) -> list:
    if not events:
        return []
    lines = ["", f"<b>📊 公布月營收 · {len(events)} 檔</b>"]
    for m, r in sorted(events, key=lambda e: e[1].get("yoy", -1e9), reverse=True):
        yoy = r.get("yoy")
        mom = r.get("mom")
        tag = "　🏆 2019 起新高" if r.get("hiAll") else "　🏆 12 個月新高" if r.get("hi") else ""
        lines += [f"<b>{escape(r.get('n') or r['c'])}</b> {r['c']}{GAP}{int(m[5:])} 月 {r['rev']:,.1f} 億{tag}",
                  f"{GAP}└ 年增 {'—' if yoy is None else f'{yoy:+.1f}%'}"
                  f"{GAP}月增 {'—' if mom is None else f'{mom:+.1f}%'}"
                  + (f"{GAP}連 {r['run']} 月年增" if r.get("run", 0) >= 2 else "")]
    lines.append(note(REV_NOTE))
    return lines


# --------------------------------------------------------------------------- #
# 自選股的均線穿越（5／10 日線）
# --------------------------------------------------------------------------- #
# 只在「穿越的那一天」通知：昨天收在線上、今天收在線下就是跌破，反過來是站回。
# 一直待在線下的不會天天提醒 —— 那是狀態不是事件，看網站就好。
#
# 收盤價讀 close/（全市場），所以沒進成交值排行的自選股也算得到。均線區間裡碰到
# 除權息的話，除權息前的收盤要乘上還原因子：不然殖利率 5% 的股票在除息那天
# 一定「跌破」5 日線，那是發股利不是轉弱。
# 區間裡任何一天沒有收盤（停牌、資料缺漏）就不算 —— 寧可漏報也不拿斷掉的序列湊。
MA_WINDOWS = (5, 10)
RULE_PATH = twse.DATA_DIR / "rule.json"
MA_NOTE = "均線為還原除權息後的收盤均價；只在穿越當天通知。"


def load_exright_factors(years: set) -> dict:
    """{代號: {除權息日: 還原因子}}，只讀用得到的那幾年。"""
    out = defaultdict(dict)
    for year in years:
        path = twse.DATA_DIR / "exright" / f"{year}.json"
        for code, events in (_json_or_none(path) or {}).items():
            for day, factor in events:
                out[code][day] = factor
    return out


def ma_cross_events(date_iso: str, codes: list) -> dict:
    """自選股這一天穿越 5／10 日線的事件 -> {代號: (簡稱, 收盤, 漲跌, [事件, ...])}。"""
    need = max(MA_WINDOWS) + 1                     # 還要昨天的均線
    dates = [d for d in sorted(set(twse.existing_close_dates("twse"))
                               & set(twse.existing_close_dates("tpex")))
             if d <= date_iso][-need:]
    if len(dates) < need or dates[-1] != date_iso:
        return {}

    wanted = set(codes)
    closes = []                                    # 由舊到新，每天 {代號: 收}
    for day in dates:
        merged = {}
        for market in ("twse", "tpex"):
            raw = _json_or_none(twse.close_path(day, market)) or {}
            merged.update({c: v for c, v in (raw.get("c") or {}).items() if c in wanted})
        closes.append(merged)

    factors = load_exright_factors({d[:4] for d in dates})
    names = {code: row[0] for code, row in
             ((_json_or_none(RULE_PATH) or {}).get("stocks") or {}).items() if code in wanted}

    out = {}
    for code in codes:
        series = [day.get(code) for day in closes]
        if any(v is None for v in series):
            continue
        # 由新往舊累乘還原因子：除權息日之前的價格都要乘上那一次的因子
        adj, scale = [], 1.0
        for i in range(need - 1, -1, -1):
            adj.append(series[i] * scale)
            factor = factors.get(code, {}).get(dates[i])
            if factor:
                scale *= factor
        adj.reverse()

        close, prev = adj[-1], adj[-2]
        events = []
        for n in MA_WINDOWS:
            ma_now = sum(adj[-n:]) / n
            ma_prev = sum(adj[-n - 1:-1]) / n
            if prev >= ma_prev and close < ma_now:
                events.append(f"跌破 {n} 日線（{ma_now:,.2f}）")
            elif prev < ma_prev and close >= ma_now:
                events.append(f"站回 {n} 日線（{ma_now:,.2f}）")
        if events:
            moved = (close / prev - 1) * 100
            out[code] = (names.get(code) or code, series[-1], moved, events)
    return out


def watch_ma_lines(events: dict) -> list:
    """均線穿越那一段的訊息行，跌破排前面。沒有任何一檔穿越就整段不出現。"""
    if not events:
        return []
    lines = ["", f"<b>〰️ 均線穿越 · {len(events)} 檔</b>"]
    for code, (name, close, moved, items) in sorted(
            events.items(), key=lambda kv: (not any("跌破" in e for e in kv[1][3]), kv[1][2])):
        icon = "🔻" if any("跌破" in e for e in items) else "🔺"
        lines += [f"{icon} <b>{escape(name)}</b> {code}{GAP}{close:,.2f}（{moved:+.2f}%）",
                  f"{GAP}└ " + "、".join(escape(e) for e in items)]
    lines.append(note(MA_NOTE))
    return lines


def parse_watchlist(raw: str) -> list:
    """自選代號，去重並保留順序。"""
    return list(dict.fromkeys(
        c.strip() for c in str(raw or "").replace("\n", ",").split(",") if c.strip()))


# --------------------------------------------------------------------------- #
# 族群版：自選股自動分組
# --------------------------------------------------------------------------- #
# 族群取自 themes.json 的題材細項。一檔常常掛好幾個細項（台積電掛了 8 個），
# 這裡要挑一個「它本業是什麼」的：
#   1. 跨族群的熱門題材（下面這份）只在沒有本業細項時才用 —— 鴻海是 ODM，
#      不是 Google TPU；台積電是晶圓代工，不是 CoPoS
#   2. 剩下的挑這檔排得最前面的細項（名單是依代表性排的），同名次挑名單較長的
# 都不在題材名單裡的，退回官方產業別。
OVERLAY_SUBS = {"Google TPU", "BBU 備援電池", "矽光子", "CoWoS", "CoPoS", "FOPLP 面板級封裝",
                "儲能系統", "固態電池", "低軌衛星", "國防軍工", "人形機器人"}
THEMES_PATH = twse.DATA_DIR / "themes.json"
INDUSTRY_PATH = twse.DATA_DIR / "industry.json"


def auto_groups(codes: list) -> list:
    """自選代號 -> [(族群大類, [代號, ...])]，依 themes.json 的大類順序，產業別退路排最後。

    挑的是細項，分組用細項所屬的大類 —— 細項太細，37 檔會分成二十幾組、大半只有一檔。
    """
    themes = (_json_or_none(THEMES_PATH) or {}).get("groups") or []
    subs = [(g["name"], s) for g in themes for s in g["subs"]]
    industry = (_json_or_none(INDUSTRY_PATH) or {}).get("map") or {}
    order = {g["name"]: i for i, g in enumerate(themes)}
    picked = defaultdict(list)
    for code in codes:
        cand = [(g, s) for g, s in subs if code in s["codes"]]
        base = [(g, s) for g, s in cand if s["name"] not in OVERLAY_SUBS] or cand
        if base:
            group, _ = min(base, key=lambda gs: (gs[1]["codes"].index(code), -len(gs[1]["codes"])))
            picked[group].append(code)
        else:
            picked[industry.get(code) or "未分類"].append(code)
    return sorted(picked.items(), key=lambda kv: order.get(kv[0], len(order)))


def build_group_message(payload: dict, prev: dict, groups: list, site_url: str = "",
                        scope_name: str = "", insti_events=None, ma_events=None) -> str:
    """族群版：照 auto_groups() 分的組排，一檔一行，進出榜、均線穿越、籌碼事件都寫在同一行。

    組標題的平均漲跌是組內各檔的簡單平均，不加權。漲跌取自 rule.json（全市場），
    它與這一封不是同一天的話整欄留空，不拿別天的數字充數。
    """
    date_iso = payload["date"]
    today = {s["code"]: s for s in payload["stocks"] if s["rank"] <= twse.STREAK_RANK}
    before = {s["code"] for s in (prev or {}).get("stocks", []) if s["rank"] <= twse.STREAK_RANK}
    rule = _json_or_none(RULE_PATH) or {}
    stocks = (rule.get("stocks") or {}) if rule.get("date") == date_iso else {}
    names = {c: row[0] for c, row in (rule.get("stocks") or {}).items()}
    insti_events = insti_events or {}
    ma_events = ma_events or {}

    lines = [f"<b>🗂 自選股依族群{scope_name} · {date_iso}</b>"]
    for group, codes in groups:
        moves = [stocks[c][2] for c in codes if c in stocks and stocks[c][2] is not None]
        avg = f"{GAP}平均 {sum(moves) / len(moves):+.2f}%" if moves else ""
        lines += ["", f"<b>【{tidy(group)}】</b>{avg}"]
        for code in codes:
            row = stocks.get(code)
            parts = [f"<b>{escape(names.get(code) or code)}</b> {code}"]
            if row and row[2] is not None:
                parts.append(f"{row[2]:+.2f}%")
            if code in today:
                parts.append(f"#{today[code]['rank']}" + (" 🆕" if today[code].get("streak") == 1 else ""))
            elif code in before:
                parts.append("掉出榜")
            tags = [("🔻" if "跌破" in e else "🔺") + e.split("（")[0]
                    for e in ma_events.get(code, (None, None, None, []))[3]]
            tags += insti_events.get(code, (None, None, None, []))[3]
            lines.append(GAP.join(parts))
            if tags:
                lines.append(f"{GAP}└ " + "、".join(escape(t) for t in tags))

    lines += [note("#n 為成交值排名。"), note(MA_NOTE), note(INSTI_NOTE)]
    if site_url:
        lines += ["", f'<a href="{escape(site_url)}">看完整排行</a>']
    return finish(lines)


def build_watch_message(payload: dict, prev: dict, codes: list, site_url: str = "",
                        scope_name: str = "", total_label: str = "大盤",
                        insti_events=None, ma_events=None, rev_events=None) -> str:
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
        lines.append(f"<b>📈 在榜上 · {len(on_board)} 檔</b>")
        rows = []
        for code in sorted(on_board, key=lambda c: today[c]["rank"]):
            stock = today[code]
            tag = " 🆕" if stock.get("streak") == 1 else f"{GAP}連 {stock['streak']} 天"
            rows.append(
                f"#{stock['rank']} <b>{escape(stock['name'])}</b> {code}"
                f"{GAP}{stock['value'] / 1e8:,.1f} 億{tag}"
            )
        lines += fold(rows)
    else:
        lines.append("<b>📈 在榜上</b>\n（無）")

    if dropped:
        lines += ["", f"<b>📉 今日掉出榜 · {len(dropped)} 檔</b>"]
        for code in sorted(dropped, key=lambda c: before[c]["rank"]):
            stock = before[code]
            lines.append(f"#{stock['rank']} <b>{escape(stock['name'])}</b> {code} → 已不在前 {twse.STREAK_RANK}")

    missing = [c for c in codes if c not in today and c not in before]
    if missing:
        lines += ["", f"<i>未在榜上：{escape('、'.join(missing))}</i>"]

    # 自選股那一封講的是**逐檔**的籌碼動靜，不是全市場的分組名單。進不進榜與有沒有
    # 籌碼異動是兩件事，所以這一段不受上面的「在榜上／掉出榜」影響，自選股全部都看。
    lines += watch_ma_lines(ma_events or {})
    lines += watch_insti_lines(insti_events or {})
    lines += watch_rev_lines(rev_events or [])

    if site_url:
        lines += ["", f'<a href="{escape(site_url)}">看完整排行</a>']
    return finish(lines)


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

    i = dates.index(date_iso)
    prev = (
        json.loads(twse.daily_path(dates[i - 1], args.scope).read_text(encoding="utf-8"))
        if i > 0 else None
    )
    # 法人那一段是全市場算的，只推上市或上櫃時不放，免得標題說上櫃、數字卻含上市
    flow = value_flow_lines(payload, prev)
    if args.scope == "all":
        flow += insti_flow_lines(date_iso)
        flow += futures_lines(date_iso)

    # 全市場每天發兩則（排行、籌碼與資金）；有自選股時再接在後面多發自選股的兩則。
    messages = [build_message(payload, site_url, scope_name, total_label)]
    money = build_money_message(date_iso, scope_name, insti_rows, flow)
    if money:
        messages.append(money)

    if codes:
        on_board = {s["code"] for s in payload["stocks"] if s["rank"] <= twse.STREAK_RANK}
        was_on = {s["code"] for s in (prev or {}).get("stocks", []) if s["rank"] <= twse.STREAK_RANK}
        events = insti_watch_events(date_iso, codes)
        crosses = ma_cross_events(date_iso, codes)
        revs = rev_watch_events(date_iso, codes)
        # 自選股完全沒動靜就別發，每天一封「今天沒事」只會讓人關掉通知。
        # 但「沒動靜」要把籌碼與均線穿越算進去 —— 只看進出榜的話，自選股有土洋對作
        # 或跌破 5 日線、卻剛好沒進前 200 名時整封信都不會發，而那正是最該通知的情況。
        ranked = any(c in on_board or c in was_on for c in codes)
        if not ranked and not events and not crosses and not revs:
            print(f"自選股（{len(codes)} 檔）在 {date_iso} 沒有進出榜、籌碼動靜、均線穿越或營收公布，只發全市場的。")
        else:
            if not ranked:
                print(f"自選股沒有進出榜，但有 {len(events)} 檔籌碼動靜、{len(crosses)} 檔均線穿越、"
                      f"{len(revs)} 檔公布營收，照發。")
            # 兩則：先發原本的分段版，再發族群版。兩種都在試用，用一陣子再決定留哪一種。
            messages += [
                build_watch_message(payload, prev, codes, site_url, scope_name,
                                    total_label, events, crosses, revs),
                build_group_message(payload, prev, auto_groups(codes), site_url, scope_name,
                                    events, crosses),
            ]

    if args.dry_run:
        # Windows 主控台預設 cp950，印不出訊息裡的 emoji
        sys.stdout.reconfigure(encoding="utf-8")
        for k, message in enumerate(messages, 1):
            if len(messages) > 1:
                print(f"===== 第 {k} 則 =====")
            print(message)
            print(f"\n(訊息長度 {len(message)} 字元，Telegram 上限 4096)\n")
        return 0

    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        print("未設定 TELEGRAM_BOT_TOKEN／TELEGRAM_CHAT_ID，略過推播。")
        return 0

    for message in messages:
        send(token, chat_id, message)
    print(f"已推播 {date_iso} 的 {len(messages)} 則訊息（{'、'.join(str(len(m)) for m in messages)} 字元）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
