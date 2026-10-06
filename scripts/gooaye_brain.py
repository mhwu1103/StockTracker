"""MK 大腦：從逐字稿整理出他看什麼資料、怎麼操作 -> data/gooaye/brain/。

兩步：

1. extract —— 一集一集丟給 Claude（本機的 `claude -p`，不需要另外的 API key），
   照固定的 JSON Schema 抽出四樣東西：
     - sources  他提到、在用的資訊來源（媒體、研究報告、數據指標、財報法說、人物、
                社群、書、Podcast、工具網站……），以及他怎麼用它
     - methods  他講的操作方式與原則（部位、停損、選股、進出場、心態……）
     - views    對個股、產業、總經的看法與立場
     - watching 他說接下來要盯的事（某個財報、某個數據、某個事件）
   每集的結果存成 episodes/EP0001.json；已經有的就跳過，所以中斷了可以接著跑。

2. build —— 把每集的結果彙整成：
     sources.json   來源 -> 類別、出現集數、各年次數、他怎麼用（附集數）
     methods.json   主題 -> 每一條原則（附集數）
     views.json     標的 -> 立場時間軸
     BRAIN.md       給人看的總整理

逐字稿只看 EP1–693：EP694 以後是沒校對過的語音辨識，錯字多到連節目名都錯。
data/gooaye/ 整個在 .gitignore 裡（逐字稿是節目內容，repo 是公開的）。

用法：
    python scripts/gooaye_brain.py extract --eps 1-693 --workers 4
    python scripts/gooaye_brain.py extract --eps 100,300,500 --model haiku   # 先試幾集
    python scripts/gooaye_brain.py build
"""

from __future__ import annotations

import argparse
import collections
import json
import re
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TRANSCRIPTS = ROOT / "data" / "gooaye" / "transcripts"
BRAIN = ROOT / "data" / "gooaye" / "brain"
EPISODES = BRAIN / "episodes"

SOURCE_TYPES = ["媒體新聞", "研究報告", "數據指標", "財報法說", "公司官方", "人物觀點",
                "社群論壇", "書籍", "Podcast影片", "工具網站", "籌碼資料", "其他"]
METHOD_THEMES = ["資訊蒐集", "產業研究", "選股", "估值", "進出場時機", "部位管理", "停損停利",
                 "風險控管", "總經判斷", "籌碼與情緒", "心態紀律", "長期投資", "其他"]
STANCES = ["看多", "看空", "中立", "觀察", "買進", "加碼", "減碼", "賣出", "持有", "避開"]

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary", "sources", "methods", "views", "watching"],
    "properties": {
        "summary": {"type": "string", "description": "本集重點，三句以內"},
        "sources": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["name", "type", "how_used"],
            "properties": {
                "name": {"type": "string", "description": "來源的正式名稱，例如 Bloomberg、SemiAnalysis、CPI、台積電法說會、Howard Marks、PTT、13F"},
                "type": {"type": "string", "enum": SOURCE_TYPES},
                "how_used": {"type": "string", "description": "他從這個來源看什麼、怎麼解讀，一句話"},
            }}},
        "methods": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["theme", "rule"],
            "properties": {
                "theme": {"type": "string", "enum": METHOD_THEMES},
                "rule": {"type": "string", "description": "他的做法或原則，用可以照做的一句話寫出來"},
            }}},
        "views": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["target", "stance", "reason"],
            "properties": {
                "target": {"type": "string", "description": "標的：公司用常見名稱（台股加代號，如 台積電 2330；美股加代號，如 NVIDIA NVDA），或產業、總經主題"},
                "stance": {"type": "string", "enum": STANCES},
                "reason": {"type": "string", "description": "理由，一句話"},
            }}},
        "watching": {"type": "array", "items": {"type": "string"},
                     "description": "他說接下來要盯、要等的事，例如某家財報、某個數據公布、某個事件"},
    },
}

SYSTEM = f"""你在整理台灣財經 Podcast《MK》（主持人 MK）的逐字稿，目的是還原他「看什麼資料、怎麼操作」。

逐字稿是語音辨識加人工修正，仍有同音錯字；請依上下文還原正確名稱（例如「古埃」是 MK、公司名與代號用正確寫法）。

只記他本人的資訊來源、做法與看法：
- 業配、贊助、遊戲、電影、音樂、生活閒聊不算資訊來源，除非他拿來談投資
- 聽眾提問裡的說法不算他的；他的回答才算
- methods 要寫成可以照做的原則，不要寫空泛的「要做功課」
- 沒有就給空陣列，不要湊
類別只能用：sources.type={SOURCE_TYPES}；methods.theme={METHOD_THEMES}；views.stance={STANCES}。
全部用繁體中文。"""


def parse_eps(spec: str) -> list[int]:
    eps: set[int] = set()
    for part in spec.split(","):
        a, _, b = part.partition("-")
        eps.update(range(int(a), int(b or a) + 1))
    return sorted(eps)


def read_episode(ep: int) -> tuple[dict, str]:
    text = (TRANSCRIPTS / f"EP{ep:04d}.md").read_text(encoding="utf-8")
    _, front, body = text.split("---", 2)
    meta = {}
    for line in front.strip().splitlines():
        k, _, v = line.partition(":")
        meta[k.strip()] = v.strip().strip('"')
    return meta, body


# 撞到用量上限時，claude -p 每一集都會瞬間失敗、花費 0；連續失敗這麼多次就不再開新的一集，
# 免得把剩下幾百集全部空轉一遍。下次再跑會從沒做完的接著做。
MAX_CONSECUTIVE_FAILS = 5
_halt = threading.Event()
_fails_lock = threading.Lock()
_consecutive_fails = 0


def _record(ok: bool) -> None:
    global _consecutive_fails
    with _fails_lock:
        _consecutive_fails = 0 if ok else _consecutive_fails + 1
        if _consecutive_fails >= MAX_CONSECUTIVE_FAILS:
            _halt.set()


def extract_one(ep: int, model: str, until: datetime | None) -> str:
    out = EPISODES / f"EP{ep:04d}.json"
    if out.exists():
        return f"EP{ep:04d} 已有，跳過"
    if until and datetime.now() >= until:
        return f"EP{ep:04d} 過了截止時間，留給下一批"
    if _halt.is_set():
        return f"EP{ep:04d} 連續失敗已暫停，留給下一批"
    meta, body = read_episode(ep)
    prompt = f"以下是 EP{ep}（{meta.get('episode_date', '')}）〈{meta.get('title', '')}〉的逐字稿：\n\n{body}"
    cmd = ["claude", "-p", "--model", model, "--output-format", "json",
           "--system-prompt", SYSTEM, "--json-schema", json.dumps(SCHEMA, ensure_ascii=False),
           "--tools", "", "--no-session-persistence", "--setting-sources", ""]
    r = subprocess.run(cmd, input=prompt, capture_output=True, text=True, encoding="utf-8", timeout=900)
    try:
        resp = json.loads(r.stdout.splitlines()[0])
    except (IndexError, json.JSONDecodeError):
        _record(False)
        return f"EP{ep:04d} 失敗：{(r.stderr or r.stdout)[:300]}"
    data = resp.get("structured_output")
    if r.returncode != 0 or resp.get("is_error") or data is None:
        _record(False)
        why = resp.get("result") or resp.get("api_error_status") or resp.get("subtype")
        return f"EP{ep:04d} 失敗：{str(why)[:300]}"
    _record(True)
    data = {"episode": ep, "date": meta.get("episode_date"), "title": meta.get("title"), **data}
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return f"EP{ep:04d} 完成（${resp.get('total_cost_usd', 0):.3f}）"


def cmd_extract(args) -> int:
    EPISODES.mkdir(parents=True, exist_ok=True)
    eps = parse_eps(args.eps)
    until = None
    if args.until:
        # 例如 01:22：今天這個時刻已經過了就是明天的
        h, m = map(int, args.until.split(":"))
        until = datetime.now().replace(hour=h, minute=m, second=0, microsecond=0)
        if until <= datetime.now():
            until += timedelta(days=1)
    print(f"{len(eps)} 集，model={args.model}，workers={args.workers}，截止 {until or '無'}", flush=True)
    failed = 0
    with ThreadPoolExecutor(args.workers) as pool:
        futs = [pool.submit(extract_one, ep, args.model, until) for ep in eps]
        for f in as_completed(futs):
            try:
                msg = f.result()
            except Exception as e:  # noqa: BLE001 —— 一集壞掉不要拖垮整批
                msg = f"例外：{e}"
            failed += "失敗" in msg or "例外" in msg
            print(msg, flush=True)
    done = len(list(EPISODES.glob("EP*.json")))
    print(f"失敗 {failed} 集；目前共完成 {done} 集" + ("（連續失敗，已暫停）" if _halt.is_set() else ""))
    return 1 if failed else 0


def norm(name: str) -> str:
    """同一個來源的不同寫法併在一起：大小寫、空白、全半形括號後的補充說明。"""
    name = re.sub(r"[（(].*?[)）]", "", name).strip()
    return re.sub(r"\s+", " ", name).casefold()


def cmd_build(args) -> int:
    files = sorted(EPISODES.glob("EP*.json"))
    if not files:
        print("還沒有抽取結果，先跑 extract", file=sys.stderr)
        return 1
    eps = [json.loads(f.read_text(encoding="utf-8")) for f in files]

    sources: dict[str, dict] = {}
    methods: dict[str, list] = collections.defaultdict(list)
    views: dict[str, list] = collections.defaultdict(list)
    for e in eps:
        tag = {"ep": e["episode"], "date": e.get("date")}
        year = (e.get("date") or "????")[:4]
        for s in e["sources"]:
            k = norm(s["name"])
            d = sources.setdefault(k, {"name": s["name"], "types": collections.Counter(),
                                       "episodes": [], "by_year": collections.Counter(), "uses": []})
            d["types"][s["type"]] += 1
            if e["episode"] not in d["episodes"]:
                d["episodes"].append(e["episode"])
                d["by_year"][year] += 1
            d["uses"].append({**tag, "how": s["how_used"]})
        for m in e["methods"]:
            methods[m["theme"]].append({**tag, "rule": m["rule"]})
        for v in e["views"]:
            views[v["target"]].append({**tag, "stance": v["stance"], "reason": v["reason"]})

    src_list = sorted(
        ({"name": d["name"], "type": d["types"].most_common(1)[0][0], "n_episodes": len(d["episodes"]),
          "first": min(d["episodes"]), "last": max(d["episodes"]), "by_year": dict(sorted(d["by_year"].items())),
          "episodes": d["episodes"], "uses": d["uses"]} for d in sources.values()),
        key=lambda x: -x["n_episodes"])
    write = lambda name, obj: (BRAIN / name).write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    write("sources.json", src_list)
    write("methods.json", {t: methods[t] for t in METHOD_THEMES if methods[t]})
    write("views.json", dict(sorted(views.items(), key=lambda kv: -len(kv[1]))))

    lines = [f"# MK 大腦（{len(eps)} 集，EP{eps[0]['episode']}–EP{eps[-1]['episode']}）", ""]
    lines += ["## 資訊來源（依類別，出現集數多的在前）", ""]
    for t in SOURCE_TYPES:
        rows = [s for s in src_list if s["type"] == t]
        if not rows:
            continue
        lines.append(f"### {t}（{len(rows)} 個）")
        for s in rows[: args.top]:
            lines.append(f"- **{s['name']}** — {s['n_episodes']} 集（EP{s['first']}–EP{s['last']}）："
                         f"{s['uses'][-1]['how']}")
        lines.append("")
    lines += ["## 操作方式（依主題，最新的在前）", ""]
    for t in METHOD_THEMES:
        if not methods[t]:
            continue
        lines.append(f"### {t}（{len(methods[t])} 條）")
        for m in sorted(methods[t], key=lambda m: -m["ep"])[: args.top]:
            lines.append(f"- {m['rule']}（EP{m['ep']}）")
        lines.append("")
    lines += ["## 最常談的標的", ""]
    for target, vs in list(sorted(views.items(), key=lambda kv: -len(kv[1])))[: args.top]:
        last = vs[-1]
        lines.append(f"- **{target}** — {len(vs)} 次；最近 EP{last['ep']}：{last['stance']}，{last['reason']}")
    (BRAIN / "BRAIN.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"{len(eps)} 集 -> 來源 {len(src_list)} 個、原則 {sum(map(len, methods.values()))} 條、標的 {len(views)} 個")
    print(f"位置：{BRAIN}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="MK 大腦")
    sub = ap.add_subparsers(dest="cmd", required=True)
    ex = sub.add_parser("extract", help="逐集抽取")
    ex.add_argument("--eps", default="1-693", help="集數，例如 1-693 或 100,300,500")
    ex.add_argument("--model", default="sonnet")
    ex.add_argument("--workers", type=int, default=4)
    ex.add_argument("--until", help="HH:MM 之後不再開新的一集（跑到一半的會跑完），例如要關機前")
    bd = sub.add_parser("build", help="彙整")
    bd.add_argument("--top", type=int, default=40, help="BRAIN.md 每一類列幾條")
    args = ap.parse_args()
    return {"extract": cmd_extract, "build": cmd_build}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
