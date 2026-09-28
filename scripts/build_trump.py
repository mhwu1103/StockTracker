"""把川普的貼文（Truth Social 與 X）整理成前端要的索引。

    python scripts/build_trump.py

讀 docs/data/trump/{truth,tweets}/*.json，寫出：

    docs/data/trump/index.json        近期貼文流、各主題的統計與對應族群
    docs/data/trump/topic/<主題>.json  那個主題的每一則貼文（摘要）

與 build_x.py 同樣是「摘要在索引、全文在月檔」，理由見那一支的 docstring。
摘要帶著 `src`，前端才知道全文要去哪個目錄的月檔拿。

## X 與 Truth Social 同文的只留一則

他在 X 上有字的貼文，多半是 Truth Social 那一則原封不動貼過去。兩邊都留的話，
同一句話在「關稅」底下會算兩次。所以合併時比對「正規化後的前 120 字」、而且發文
時間相差 48 小時內的，只留 Truth Social 那一則（它是原發處），X 的連結掛在
它的 `xurl` 上。

## 主題每一輪重標

月檔裡存的 `topics` 是抓到那一刻用當時的 TOPICS 標的。關鍵字表之後一定會改
（加一條、收緊一條），所以這裡**每一輪都拿全文重標一次**，不讀月檔裡那一份 ——
否則改了表之後，舊貼文會永遠停在舊的標法，而新舊兩批在同一個主題底下混著。
背書文也是在這裡判定的（`trump.is_endorsement`），理由同上。
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import build_x
import serenity
import trump
import twse

RECENT_N = 200
HOT_DAYS = 30
SAME_WINDOW = timedelta(hours=48)


def load_source(src: str) -> list:
    folder = trump.SOURCE_DIRS[src]
    rows = []
    if not folder.exists():
        return rows
    for path in sorted(folder.glob("*.json")):
        try:
            items = json.loads(path.read_text(encoding="utf-8")).get("items") or []
        except ValueError:
            print(f"! {src}/{path.name} 讀不動，跳過")
            continue
        for r in items:
            r["src"] = src
        rows.extend(items)
    return rows


def _key(text: str) -> str:
    """比對同文用：拿掉網址、只留英數、小寫，取前 120 字。"""
    return re.sub(r"[^a-z0-9]", "", trump.URL_RE.sub("", text or "").lower())[:120]


def _when(row: dict) -> datetime:
    return datetime.fromisoformat((row.get("ts") or "1970-01-01T00:00:00Z").replace("Z", "+00:00"))


def merge_sources(truth: list, x: list) -> tuple:
    """(合併後的貼文, X 裡有幾則是 Truth Social 的同文)。"""
    by_key = defaultdict(list)
    for r in truth:
        by_key[_key(r["text"])].append(r)
    kept = list(truth)
    dup = 0
    for r in x:
        twin = next((t for t in by_key.get(_key(r["text"]), [])
                     if abs(_when(t) - _when(r)) <= SAME_WINDOW), None)
        if twin:
            twin["xurl"] = r.get("url")
            dup += 1
        else:
            kept.append(r)
    kept.sort(key=lambda r: (r.get("ts") or "", r["id"]))
    return kept, dup


def brief(row: dict) -> dict:
    text, cut = serenity.summarize(row.get("text") or "")
    out = {
        "id": row.get("id"),
        "src": row["src"],
        "ts": row.get("ts"),
        "m": serenity.month_of(row),
        "s": text,
        "url": row.get("url"),
        "k": row.get("topics") or [],
    }
    if cut:
        out["more"] = True
    if row.get("endorse"):
        out["e"] = True
    # 互動數只有 X 有（trumpstruth.org 不提供）
    for key in ("likes", "replies", "views", "xurl"):
        if row.get(key):
            out[key] = row[key]
    return out


def check_groups() -> None:
    """TOPICS 裡寫的族群名稱要與 us_link.json 一字不差，對不上的印出來。

    對不上不會讓畫面壞掉 —— 那個 chip 照樣畫得出來 —— 只是它不再是美股頁與
    四市題材上的同一族，而這種錯看起來完全正常，所以每一輪都核一次。
    """
    known = {g for meta in build_x.load_link().values() for g in meta["g"]}
    if not known:
        return
    for t in trump.TOPICS:
        for g in t["g"]:
            if g not in known:
                print(f"! 主題「{t['label']}」的族群「{g}」不在 us_link.json 上")


def main() -> int:
    truth = load_source("truth")
    x = load_source("x")
    rows, dup = merge_sources(truth, x)
    if not rows:
        print("! docs/data/trump/ 底下沒有貼文，先跑 python scripts/fetch_trump.py --since 2026-06-01")
        return 1

    check_groups()

    for row in rows:
        row["endorse"] = trump.is_endorsement(row.get("text"))
        row["topics"] = trump.topics_in(row.get("text") or "")

    now = datetime.now(timezone.utc)
    hot_since = (now - timedelta(days=HOT_DAYS)).isoformat(timespec="seconds").replace("+00:00", "Z")

    by_topic = defaultdict(list)
    for row in rows:
        for k in row["topics"]:
            by_topic[k].append(row)

    trump.TOPIC_DIR.mkdir(parents=True, exist_ok=True)
    stale = {p.stem for p in trump.TOPIC_DIR.glob("*.json")} - set(by_topic)
    for name in stale:
        (trump.TOPIC_DIR / f"{name}.json").unlink()

    written = 0
    topics = []
    for t in trump.TOPICS:
        items = sorted(by_topic.get(t["k"], []), key=lambda r: r.get("ts") or "", reverse=True)
        topics.append({
            "k": t["k"],
            "label": t["label"],
            "g": t["g"],
            "c": len(items),
            "hot": sum(1 for r in items if (r.get("ts") or "") >= hot_since),
            "last": items[0].get("ts") if items else None,
        })
        if not items:
            continue
        # 不放 updated，理由同 build_x.py 的 ticker 檔
        payload = {"k": t["k"], "label": t["label"], "g": t["g"],
                   "count": len(items), "items": [brief(r) for r in items]}
        if twse.write_if_changed(trump.topic_path(t["k"]), payload):
            written += 1

    endorse = sum(1 for r in rows if r["endorse"])
    state = trump.load_state()
    twse.write_json(trump.INDEX_PATH, {
        "user": trump.USER,
        "name": trump.USER_NAME,
        "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "checked": state.get("checked"),
        "total": len(rows),
        "bySrc": {"truth": sum(1 for r in rows if r["src"] == "truth"),
                  "x": sum(1 for r in rows if r["src"] == "x")},
        "xDup": dup,
        # 背書文有幾則：前端要說得出「主題統計不含這些」
        "endorse": endorse,
        "span": [rows[0].get("ts"), rows[-1].get("ts")],
        "hotDays": HOT_DAYS,
        "topics": topics,
        "recent": [brief(r) for r in rows[-RECENT_N:][::-1]],
    })

    hit = sum(1 for r in rows if r["topics"])
    print(f"{len(rows)} 則貼文（Truth Social {len(truth)}、X {len(x)}，其中 {dup} 則是同文已合併），"
          f"{endorse} 則是背書，{hit} 則碰到至少一個主題")
    print(f"寫了 {written} 個主題檔 -> {trump.DATA_DIR.relative_to(twse.ROOT)}")
    print("主題：" + ("、".join(f"{t['label']}({t['c']})" for t in topics if t["c"]) or "（還沒有）"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
