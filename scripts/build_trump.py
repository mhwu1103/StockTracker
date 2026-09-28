"""把 @realDonaldTrump 的貼文整理成前端要的索引。

    python scripts/build_trump.py

讀 docs/data/trump/tweets/*.json，寫出：

    docs/data/trump/index.json        近期貼文流、各主題的統計與對應族群
    docs/data/trump/topic/<主題>.json  那個主題的每一則貼文（摘要）

與 build_x.py 同樣是「摘要在索引、全文在月檔」，理由見那一支的 docstring。

## 主題每一輪重標

月檔裡存的 `topics` 是抓到那一刻用當時的 TOPICS 標的。關鍵字表之後一定會改
（加一條、收緊一條），所以這裡**每一輪都拿全文重標一次**，不讀月檔裡那一份 ——
否則改了表之後，舊貼文會永遠停在舊的標法，而新舊兩批在同一個主題底下混著。
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import build_x
import serenity
import trump
import twse

RECENT_N = 150
HOT_DAYS = 30


def load_all() -> list:
    rows = []
    if not trump.TWEET_DIR.exists():
        return rows
    for path in sorted(trump.TWEET_DIR.glob("*.json")):
        try:
            rows.extend(json.loads(path.read_text(encoding="utf-8")).get("items") or [])
        except ValueError:
            print(f"! {path.name} 讀不動，跳過")
    rows.sort(key=lambda r: int(r.get("id") or 0))
    return rows


def brief(row: dict) -> dict:
    text, cut = serenity.summarize(row.get("text") or "")
    out = {
        "id": row.get("id"),
        "ts": row.get("ts"),
        "m": serenity.month_of(row),
        "s": text,
        "likes": row.get("likes") or 0,
        "replies": row.get("replies") or 0,
        "k": row.get("topics") or [],
    }
    if cut:
        out["more"] = True
    for key in ("views", "media", "rt", "reply"):
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
    rows = load_all()
    if not rows:
        print("! docs/data/trump/tweets/ 是空的，先跑 python scripts/fetch_trump.py")
        return 1

    check_groups()

    for row in rows:
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
        items = sorted(by_topic.get(t["k"], []), key=lambda r: int(r["id"]), reverse=True)
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

    video = sum(1 for r in rows if not r.get("text") and r.get("media"))
    state = trump.load_state()
    twse.write_json(trump.INDEX_PATH, {
        "user": trump.USER,
        "name": trump.USER_NAME,
        "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "checked": state.get("checked"),
        "total": len(rows),
        # 只有影片、沒有一個字的貼文有幾則。前端要說得出「主題索引只涵蓋有文字的
        # 那一部分」，否則「關稅 3 則」看起來像是他只講過三次。
        "mediaOnly": video,
        "span": [rows[0].get("ts"), rows[-1].get("ts")],
        "hotDays": HOT_DAYS,
        "topics": topics,
        "recent": [brief(r) for r in rows[-RECENT_N:][::-1]],
    })

    hit = sum(1 for r in rows if r["topics"])
    print(f"{len(rows)} 則貼文（{video} 則只有影片／圖片），{hit} 則碰到至少一個主題")
    print(f"寫了 {written} 個主題檔 -> {trump.DATA_DIR.relative_to(twse.ROOT)}")
    print("主題：" + ("、".join(f"{t['label']}({t['c']})" for t in topics if t["c"]) or "（還沒有）"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
