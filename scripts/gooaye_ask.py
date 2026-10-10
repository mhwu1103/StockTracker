"""查 MK 大腦（本機）：某一檔他什麼時候講過、立場怎麼變；最近在盯什麼；某個主題他怎麼做。

資料是 gooaye_brain.py 抽出來的 data/gooaye/brain/（只在本機，repo 不收）。

    python scripts/gooaye_ask.py stock 2330            代號或名稱都可以，多個關鍵字用空白分開＝都要符合
    python scripts/gooaye_ask.py stock 光通 --since 2025
    python scripts/gooaye_ask.py watching --last 8      最近 8 集他說接下來要盯的事
    python scripts/gooaye_ask.py topic 停損              原則裡提到關鍵字的（新的在前）
    python scripts/gooaye_ask.py topic 融資 --since 2024 --limit 30
    python scripts/gooaye_ask.py ep 650                  某一集的整理

逐字稿層的「有提到但沒抽成看法」也會數：stock 會另外列出逐字稿裡提到這個關鍵字的集數。
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "gooaye")
BRAIN = os.path.join(ROOT, "brain")
EPS = os.path.join(BRAIN, "episodes")
TRANS = os.path.join(ROOT, "transcripts")


def episodes():
    out = []
    for p in sorted(glob.glob(os.path.join(EPS, "EP*.json"))):
        with open(p, encoding="utf-8") as f:
            out.append(json.load(f))
    if not out:
        sys.exit(f"找不到 {EPS}：MK 大腦只在跑過 gooaye_brain.py 的那份 checkout 裡（data/gooaye/ 不進 git）")
    return out


def hit(text: str, words) -> bool:
    t = text.lower()
    return all(w.lower() in t for w in words)


def cmd_stock(a):
    eps = [e for e in episodes() if e["date"][:4] >= a.since]
    rows = []
    for e in eps:
        for v in e.get("views", []):
            if hit(v["target"], a.words):
                rows.append((e["episode"], e["date"], v["stance"], v["target"], v["reason"]))
    print(f"## 看法時間軸：{' '.join(a.words)}（{len(rows)} 筆）\n")
    for ep, d, stance, target, reason in rows[-a.limit:]:
        print(f"- EP{ep} {d} **{stance}**｜{target}｜{reason}")
    seen = {r[0] for r in rows}
    # 逐字稿裡有提到、但沒有被抽成看法的集數
    extra = []
    for e in eps:
        if e["episode"] in seen:
            continue
        p = os.path.join(TRANS, f"EP{e['episode']:04d}.md")
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                txt = f.read()
            n = min(txt.lower().count(w.lower()) for w in a.words)
            if n:
                extra.append((e["episode"], e["date"], n, e["title"]))
    if extra:
        extra.sort(key=lambda r: -r[2])
        print(f"\n## 逐字稿有提到、沒抽成看法的集數（{len(extra)} 集，提到次數多的在前）\n")
        for ep, d, n, title in extra[:a.limit]:
            print(f"- EP{ep} {d}　{n} 次　{title}")


def cmd_watching(a):
    eps = episodes()[-a.last:]
    for e in reversed(eps):
        print(f"### EP{e['episode']} {e['date']} {e['title']}")
        for w in e.get("watching", []):
            print(f"- {w}")
        print()


def cmd_topic(a):
    rows = []
    for e in episodes():
        if e["date"][:4] < a.since:
            continue
        for m in e.get("methods", []):
            if hit(m["rule"] + m["theme"], a.words):
                rows.append((e["episode"], e["date"], m["theme"], m["rule"]))
        for s in e.get("sources", []):
            if hit(s["name"] + s["how_used"], a.words):
                rows.append((e["episode"], e["date"], f"來源：{s['name']}", s["how_used"]))
    rows.sort(key=lambda r: -r[0])
    print(f"## {' '.join(a.words)}：{len(rows)} 筆，列最新 {min(a.limit, len(rows))}\n")
    for ep, d, theme, text in rows[:a.limit]:
        print(f"- EP{ep} {d}［{theme}］{text}")


def cmd_ep(a):
    p = os.path.join(EPS, f"EP{a.n:04d}.json")
    if not os.path.exists(p):
        sys.exit(f"沒有 EP{a.n}")
    with open(p, encoding="utf-8") as f:
        e = json.load(f)
    print(f"# EP{e['episode']} {e['date']} {e['title']}\n\n{e['summary']}\n")
    for key, label in (("views", "看法"), ("methods", "原則"), ("watching", "要盯的"), ("sources", "來源")):
        print(f"## {label}")
        for x in e.get(key, []):
            if key == "views":
                print(f"- **{x['stance']}**｜{x['target']}｜{x['reason']}")
            elif key == "methods":
                print(f"- ［{x['theme']}］{x['rule']}")
            elif key == "sources":
                print(f"- {x['name']}（{x['type']}）：{x['how_used']}")
            else:
                print(f"- {x}")
        print()


def main():
    ap = argparse.ArgumentParser(description="查 MK 大腦")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("stock")
    s.add_argument("words", nargs="+")
    s.add_argument("--since", default="2020")
    s.add_argument("--limit", type=int, default=40)
    s.set_defaults(fn=cmd_stock)
    w = sub.add_parser("watching")
    w.add_argument("--last", type=int, default=5)
    w.set_defaults(fn=cmd_watching)
    t = sub.add_parser("topic")
    t.add_argument("words", nargs="+")
    t.add_argument("--since", default="2020")
    t.add_argument("--limit", type=int, default=25)
    t.set_defaults(fn=cmd_topic)
    e = sub.add_parser("ep")
    e.add_argument("n", type=int)
    e.set_defaults(fn=cmd_ep)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
