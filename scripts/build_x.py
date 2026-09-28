"""把 X 帳號的貼文整理成前端要的索引。

    python scripts/build_x.py                  # 每個帳號都重建
    python scripts/build_x.py --user elonmusk  # 只重建一個

讀 docs/data/x/<帳號>/tweets/*.json，每個帳號寫出：

    docs/data/x/<帳號>/index.json      近期貼文流、標的排行、整體統計
    docs/data/x/<帳號>/tickers.json    每個標的一列：提及次數、熱度、與台股族群的對照
    docs/data/x/<帳號>/ticker/<T>.json 該標的的每一則貼文（摘要）

外加一份 docs/data/x/accounts.json：前端的帳號切換從這裡讀，加帳號時
前端不必改。

## 標的是 cashtag 或關鍵字主題

Serenity 用 $cashtag，那就是標的。Elon 幾乎不用，所以他的帳號另外配了關鍵字
主題（xposts.ELON_TOPICS）：Optimus、xAI、SpaceX… 各自是一個「標的」，自己
帶著要接的台股族群。兩種共用同一套索引，差別只在 `k`：主題是 "topic"，
前端就不在它前面畫 `$`。

## 為什麼 ticker 檔只放摘要

Serenity 提最多的 SIVE 有 691 則，整包存全文是 400 KB —— 而一個標的平均被 2 則
貼文提到，同一則會複製進好幾個標的檔，全站加起來會膨脹到 10 MB 左右。
所以 ticker 檔每則只放 240 字的摘要（`xposts.SUMMARY_CHARS`），要看全文
時前端去載那一則所屬的月檔（Elon 是日檔），而且點開一則之後同一檔的
其他則就都在手上了。

## 與台股的對照從哪來

`docs/data/us_link.json` 是這個專案本來就在維護的美股 × 台股族群對照。
Serenity 提過的標的裡有 78 檔在那份表上，那幾檔可以直接標出中文名與對應族群 ——
這是把他的觀點接回台股脈絡的唯一連結點，也是這一頁存在的理由。

剩下那些不在表上、但他反覆在講的（SIVE、NBIS、AXTI、IREN 這些），前端另外
標成「未追蹤」：那正是他這個帳號的價值所在 —— 對照表是照台股供應鏈整理的，
本來就不會有這些還沒進到台股視野的標的。
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import twse
import xposts
from xposts import Account

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


def check_topics(link: dict) -> None:
    """主題寫的族群名要在 us_link.json 裡找得到。

    族群名是用字串對的，us_link 那邊改一個間隔號，這裡的主題就默默變成
    「未追蹤」—— 畫面上看起來只是少了一個 chip。所以對不上時大聲講。
    """
    known = {g for meta in link.values() for g in meta["g"]}
    for acct in xposts.ACCOUNTS.values():
        for topic in acct.topics:
            for g in topic.groups:
                if known and g not in known:
                    print(f"! @{acct.user} 的主題「{topic.name}」寫的族群「{g}」"
                          "在 us_link.json 裡找不到，名稱是不是改了？")


def meta_of(acct: Account, key: str, link: dict) -> dict:
    """一個標的的 {n, g, s, k}：主題用自己帶的，代號去查 us_link。"""
    for topic in acct.topics:
        if topic.key != key:
            continue
        if topic.groups:
            return {"n": topic.name, "g": list(topic.groups), "s": None, "k": "topic"}
        # 直接寫代號的主題（Tesla → TSLA）：名字用主題的，族群跟著 us_link 走
        meta = dict(link.get(key) or {})
        meta["n"] = topic.name
        return meta
    return link.get(key) or {}


def load_all(acct: Account) -> list:
    """所有存檔裡的貼文，時間由舊到新。"""
    rows = []
    if not acct.tweet_dir.exists():
        return rows
    for path in sorted(acct.tweet_dir.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            print(f"! {path.name} 讀不動，跳過")
            continue
        rows.extend(payload.get("items") or [])
    rows.sort(key=lambda r: int(r.get("id") or 0))
    return rows


def brief(acct: Account, row: dict) -> dict:
    """一則貼文在索引裡的樣子：摘要、時間、互動、指到哪個存檔。"""
    text, cut = xposts.summarize(row.get("text") or "")
    out = {
        "id": row.get("id"),
        "ts": row.get("ts"),
        "m": acct.bucket_of(row),          # 要全文時去載這個存檔
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
    if row.get("repost_of"):
        out["rt"] = row["repost_of"]
    # 存檔灌進來的 quote 是布林（那份存檔只記「是不是引用」），自己抓的才有內容
    quote = row.get("quote")
    if isinstance(quote, dict):
        out["q"] = {"u": quote.get("u"), "id": quote.get("id"),
                    "s": xposts.summarize(quote.get("text") or "", 160)[0]}
    return out


def build(acct: Account, link: dict) -> dict | None:
    """重建一個帳號的索引。回傳給 accounts.json 的那一列；沒有資料回 None。"""
    print(f"== @{acct.user}")
    rows = load_all(acct)
    if not rows:
        print(f"! {acct.tweet_dir.relative_to(twse.ROOT)} 是空的，先跑 python scripts/fetch_x.py")
        return None

    now = datetime.now(timezone.utc)
    hot_since = (now - timedelta(days=HOT_DAYS)).isoformat(timespec="seconds").replace("+00:00", "Z")

    by_ticker = defaultdict(list)
    for row in rows:
        for t in row.get("tickers") or []:
            by_ticker[t].append(row)

    # ---- 每個標的一個檔 ----
    acct.ticker_dir.mkdir(parents=True, exist_ok=True)
    stale = {p.stem for p in acct.ticker_dir.glob("*.json")} - set(by_ticker)
    for name in stale:
        # 代號寫錯過、或那一則貼文被改掉之後就不該再留著這個檔
        acct.ticker_path(name).unlink()
    if stale:
        print(f"清掉 {len(stale)} 個已經沒有貼文的標的檔")

    written = 0
    stats = []
    for ticker, items in by_ticker.items():
        items = sorted(items, key=lambda r: int(r["id"]), reverse=True)
        meta = meta_of(acct, ticker, link)
        hot = sum(1 for r in items if (r.get("ts") or "") >= hot_since)
        # 同 fetch_x.py 的存檔：這裡不放 updated。這是幾百個檔案，
        # 一個每次都變的時間戳會讓每一輪排程都產生幾百個檔的 git 差異，
        # 而 write_if_changed 的用意正好是避免那件事。
        payload = {
            "t": ticker,
            "n": meta.get("n"),
            "g": meta.get("g"),
            "count": len(items),
            "items": [brief(acct, r) for r in items],
        }
        if twse.write_if_changed(acct.ticker_path(ticker), payload):
            written += 1
        stat = {
            "t": ticker,
            "n": meta.get("n"),
            "g": meta.get("g"),
            "s": meta.get("s"),
            "c": len(items),
            "hot": hot,
            "first": items[-1].get("ts"),
            "last": items[0].get("ts"),
        }
        if meta.get("k"):
            stat["k"] = meta["k"]
        stats.append(stat)

    stats.sort(key=lambda s: (-s["hot"], -s["c"], s["t"]))
    updated = datetime.now(twse.TAIPEI).isoformat(timespec="seconds")
    twse.write_json(acct.tickers_path, {
        "user": acct.user,
        "name": acct.name,
        "updated": updated,
        "hotDays": HOT_DAYS,
        "items": stats,
    })

    # ---- 首頁 ----
    recent = [brief(acct, r) for r in rows[-RECENT_N:][::-1]]
    tracked = [s for s in stats if s["g"]]
    untracked = [s for s in stats if not s["g"]]
    state = acct.load_state()
    span = [rows[0].get("ts"), rows[-1].get("ts")]

    twse.write_json(acct.index_path, {
        "user": acct.user,
        "name": acct.name,
        "updated": updated,
        "checked": state.get("checked"),
        "total": len(rows),
        "span": span,
        "months": sorted({acct.bucket_of(r) for r in rows}),
        "hotDays": HOT_DAYS,
        # 前端要畫「他最近在講什麼」與「哪些還沒進台股視野」兩塊，
        # 各自取前幾名就夠，完整的一份在 tickers.json
        "hot": [s for s in stats if s["hot"]][:40],
        "tracked": tracked[:40],
        "untracked": untracked[:40],
        "recent": recent,
    })

    kb = sum(p.stat().st_size for p in acct.data_dir.rglob("*.json")) / 1024
    print(f"{len(rows)} 則貼文、{len(by_ticker)} 個標的"
          f"（{len(tracked)} 個接得到台股族群、{len(untracked)} 個還沒）")
    print(f"寫了 {written} 個標的檔 -> {acct.data_dir.relative_to(twse.ROOT)}（共 {kb / 1024:.1f} MB）")
    print(f"最近 {HOT_DAYS} 天他講最多的："
          + "、".join(f"{s['t']}({s['hot']})" for s in stats[:8] if s["hot"]))
    return {
        "user": acct.user,
        "name": acct.name,
        "title": acct.title,
        "blurb": acct.blurb,
        "total": len(rows),
        "span": span,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="重建觀點頁的索引")
    ap.add_argument("--user", choices=sorted(xposts.ACCOUNTS), help="只重建這一個帳號")
    args = ap.parse_args()

    link = load_link()
    check_topics(link)

    # 前端的帳號切換照這一份的順序畫。只重建一個帳號的時候，其他帳號那一列
    # 沿用上一份 —— 不然單跑 --user 會把別人從清單上擦掉。
    previous = {}
    if xposts.ACCOUNTS_PATH.exists():
        try:
            previous = {a["user"]: a for a in
                        json.loads(xposts.ACCOUNTS_PATH.read_text(encoding="utf-8")).get("items") or []}
        except ValueError:
            pass

    items, missing = [], 0
    for acct in xposts.ACCOUNTS.values():
        if args.user and acct.user != args.user:
            if acct.user in previous:
                items.append(previous[acct.user])
            continue
        row = build(acct, link)
        print()
        if row:
            items.append(row)
        else:
            missing += 1

    # 同 index.json：updated 讓前端知道這份是什麼時候算的。這一份每一輪都會變，
    # 所以 x.yml 判斷「有沒有實質變動」時不看它。
    twse.write_json(xposts.ACCOUNTS_PATH, {
        "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "items": items,
    })
    return 1 if missing and not items else 0


if __name__ == "__main__":
    raise SystemExit(main())
