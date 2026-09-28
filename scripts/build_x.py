"""把 @aleabitoreddit 的貼文整理成前端要的索引。

    python scripts/build_x.py

讀 docs/data/x/tweets/*.json，寫出：

    docs/data/x/index.json      近期貼文流、標的排行、整體統計
    docs/data/x/tickers.json    每個標的一列：提及次數、熱度、與台股族群的對照
    docs/data/x/ticker/<T>.json 該標的的每一則貼文（摘要）

## 為什麼 ticker 檔只放摘要

他提最多的 SIVE 有 691 則，整包存全文是 400 KB —— 而一個標的平均被 2 則
貼文提到，同一則會複製進好幾個標的檔，全站加起來會膨脹到 10 MB 左右。
所以 ticker 檔每則只放 240 字的摘要（`serenity.SUMMARY_CHARS`），要看全文
時前端去載那一則所屬的月檔，一個月檔 300～700 KB，而且點開一則之後同月的
其他則就都在手上了。

## 與台股的對照從哪來

`docs/data/us_link.json` 是這個專案本來就在維護的美股 × 台股族群對照。
他提過的標的裡有 78 檔在那份表上，那幾檔可以直接標出中文名與對應族群 ——
這是把他的觀點接回台股脈絡的唯一連結點，也是這一頁存在的理由。

剩下那些不在表上、但他反覆在講的（SIVE、NBIS、AXTI、IREN 這些），前端另外
標成「未追蹤」：那正是他這個帳號的價值所在 —— 對照表是照台股供應鏈整理的，
本來就不會有這些還沒進到台股視野的標的。
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import serenity
import twse

# 首頁的近期貼文流放幾則。夠看完「這幾天他在講什麼」，又不會讓 index.json
# 變成要載半天的東西。
RECENT_N = 120

# 熱度的觀察窗：最近這麼多天內的提及次數。他的注意力轉得很快，
# 總提及次數會被幾個月前的舊題材蓋住。
HOT_DAYS = 30


def load_link() -> dict:
    """美股代號 -> {n: 中文名, g: [族群…], s: 連動強度}。

    **族群是一個列表**：一檔美股可以同時屬於好幾族（NVDA 在對照表裡同時是
    「AI 伺服器」與「網通 · 交換器」），而那正是要顯示的東西 —— 他講 NVDA
    的時候，台股這邊要看的本來就不只一族。第一版這裡是 dict 直接覆寫，
    NVDA 就只剩下最後那一族，而畫面上看起來完全正常。

    連動強度取最大的那一個：同一檔在不同族裡的強度可能不同，而使用者問的是
    「這一檔值不值得看」，不是「在第幾族裡值不值得看」。
    """
    path = twse.DATA_DIR / "us_link.json"
    if not path.exists():
        print("! 找不到 us_link.json，這一輪不做台股族群對照")
        return {}
    link = json.loads(path.read_text(encoding="utf-8"))
    out = {}
    for group in link.get("groups") or []:
        for u in group.get("us") or []:
            slot = out.setdefault(u["t"], {"n": u.get("n"), "g": [], "s": None})
            if group.get("name") and group["name"] not in slot["g"]:
                slot["g"].append(group["name"])
            if u.get("s") is not None:
                slot["s"] = max(slot["s"] or 0, u["s"])
    for b in link.get("benchmarks") or []:
        out.setdefault(b["t"], {"n": b.get("n"), "g": [], "s": None})
    return out


def load_all() -> list:
    """所有月檔裡的貼文，時間由舊到新。"""
    rows = []
    if not serenity.TWEET_DIR.exists():
        return rows
    for path in sorted(serenity.TWEET_DIR.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            print(f"! {path.name} 讀不動，跳過")
            continue
        rows.extend(payload.get("items") or [])
    rows.sort(key=lambda r: int(r.get("id") or 0))
    return rows


def brief(row: dict) -> dict:
    """一則貼文在索引裡的樣子：摘要、時間、互動、指到哪個月檔。"""
    text, cut = serenity.summarize(row.get("text") or "")
    out = {
        "id": row.get("id"),
        "ts": row.get("ts"),
        "m": serenity.month_of(row),      # 要全文時去載這個月檔
        "s": text,
        "likes": row.get("likes") or 0,
        "replies": row.get("replies") or 0,
        "t": row.get("tickers") or [],
    }
    if cut:
        out["more"] = True                # 還有下文，前端才畫得出「展開」
    if row.get("locked"):
        out["locked"] = True
    if row.get("reply"):
        out["reply"] = True
    if row.get("views"):
        out["views"] = row["views"]
    return out


def main() -> int:
    rows = load_all()
    if not rows:
        print("! docs/data/x/tweets/ 是空的，先跑 python scripts/fetch_x.py --seed")
        return 1

    link = load_link()
    now = datetime.now(timezone.utc)
    hot_since = (now - timedelta(days=HOT_DAYS)).isoformat(timespec="seconds").replace("+00:00", "Z")

    by_ticker = defaultdict(list)
    for row in rows:
        for t in row.get("tickers") or []:
            by_ticker[t].append(row)

    # ---- 每個標的一個檔 ----
    serenity.TICKER_DIR.mkdir(parents=True, exist_ok=True)
    stale = {p.stem for p in serenity.TICKER_DIR.glob("*.json")} - set(by_ticker)
    for name in stale:
        # 代號寫錯過、或那一則貼文被改掉之後就不該再留著這個檔
        (serenity.TICKER_DIR / f"{name}.json").unlink()
    if stale:
        print(f"清掉 {len(stale)} 個已經沒有貼文的標的檔")

    written = 0
    stats = []
    for ticker, items in by_ticker.items():
        items = sorted(items, key=lambda r: int(r["id"]), reverse=True)
        meta = link.get(ticker) or {}
        hot = sum(1 for r in items if (r.get("ts") or "") >= hot_since)
        # 同 fetch_x.py 的月檔：這裡不放 updated。這是 700 個檔案，
        # 一個每次都變的時間戳會讓每一輪排程都產生 700 個檔的 git 差異，
        # 而 write_if_changed 的用意正好是避免那件事。
        payload = {
            "t": ticker,
            "n": meta.get("n"),
            "g": meta.get("g"),
            "count": len(items),
            "items": [brief(r) for r in items],
        }
        if twse.write_if_changed(serenity.ticker_path(ticker), payload):
            written += 1
        stats.append({
            "t": ticker,
            "n": meta.get("n"),
            "g": meta.get("g"),
            "s": meta.get("s"),
            "c": len(items),
            "hot": hot,
            "first": items[-1].get("ts"),
            "last": items[0].get("ts"),
        })

    stats.sort(key=lambda s: (-s["hot"], -s["c"], s["t"]))
    twse.write_json(serenity.TICKERS_PATH, {
        "user": serenity.USER,
        "name": serenity.USER_NAME,
        "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "hotDays": HOT_DAYS,
        "items": stats,
    })

    # ---- 首頁 ----
    recent = [brief(r) for r in rows[-RECENT_N:][::-1]]
    tracked = [s for s in stats if s["g"]]
    untracked = [s for s in stats if not s["g"]]
    state = serenity.load_state()

    twse.write_json(serenity.INDEX_PATH, {
        "user": serenity.USER,
        "name": serenity.USER_NAME,
        "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "checked": state.get("checked"),
        "total": len(rows),
        "span": [rows[0].get("ts"), rows[-1].get("ts")],
        "months": sorted({serenity.month_of(r) for r in rows}),
        "hotDays": HOT_DAYS,
        # 前端要畫「他最近在講什麼」與「哪些還沒進台股視野」兩塊，
        # 各自取前幾名就夠，完整的一份在 tickers.json
        "hot": [s for s in stats if s["hot"]][:40],
        "tracked": tracked[:40],
        "untracked": untracked[:40],
        "recent": recent,
    })

    kb = sum(p.stat().st_size for p in serenity.DATA_DIR.rglob("*.json")) / 1024
    print(f"{len(rows)} 則貼文、{len(by_ticker)} 個標的"
          f"（{len(tracked)} 檔在台股對照表上、{len(untracked)} 檔還沒）")
    print(f"寫了 {written} 個標的檔 -> {serenity.DATA_DIR.relative_to(twse.ROOT)}（共 {kb / 1024:.1f} MB）")
    print(f"最近 {HOT_DAYS} 天他講最多的："
          + "、".join(f"${s['t']}({s['hot']})" for s in stats[:8] if s["hot"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
