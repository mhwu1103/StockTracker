"""抓 MK（Gooaye）全部集數的逐字稿 -> data/gooaye/transcripts/EP0001.md …。

逐字稿不是自己轉的：社群已經有人整理成一份冷備份 ——
GitHub 上 huijoson/gooaye-agent 的 transcripts/ 目錄，一集一個 Markdown，
開頭是 YAML frontmatter（episode、title、episode_date、duration、youtube_url、source），
大部分來自 whatmkreallysaid.com，少數是自動語音轉錄。目錄裡的 README.md 是全集索引表。

冷備份的新集數常常先放語音辨識稿（source: official_audio_asr），原站的人工校對版
晚幾天才上、冷備份也不一定回頭換。所以抓完會查原站的 episodes.json，冷備份還是語音稿、
原站已經有的集數，就改用原站的校對版（frontmatter 照冷備份的格式寫）。

整個 repo 打包成一個 tarball 抓下來，只解出 transcripts/ 底下的檔案，比一集一集打
raw.githubusercontent.com 七百次快，也不會撞到速率限制。

逐字稿是節目的內容，這個 repo 是公開的，所以 data/gooaye/ 放在 .gitignore 裡、
只留在本機，不 commit、也不進 docs/（網站）。

用法：
    python scripts/fetch_gooaye.py            # 只寫新的或內容有變的集數
    python scripts/fetch_gooaye.py --force    # 全部重寫
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import tarfile
import urllib.parse
import urllib.request
from pathlib import Path

REPO = "huijoson/gooaye-agent"
BRANCH = "main"
TARBALL_URL = f"https://codeload.github.com/{REPO}/tar.gz/refs/heads/{BRANCH}"
SITE = "https://whatmkreallysaid.com"
OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "gooaye" / "transcripts"


def parse_args():
    ap = argparse.ArgumentParser(description="抓 MK 逐字稿")
    ap.add_argument("--force", action="store_true", help="內容沒變也重寫")
    return ap.parse_args()


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 StockTracker"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        return resp.read()


def _front(text: str) -> dict:
    _, front, _ = text.split("---", 2)
    meta = {}
    for line in front.strip().splitlines():
        k, _, v = line.partition(":")
        meta[k.strip()] = v.strip().strip('"')
    return meta


def replace_asr_with_reviewed() -> int:
    """冷備份還是語音辨識稿、原站已有校對版的集數，換成原站的版本。回傳換了幾集。"""
    asr = {}
    for p in OUT_DIR.glob("EP*.md"):
        meta = _front(p.read_text(encoding="utf-8"))
        if meta.get("source") == "official_audio_asr":
            asr[int(meta["episode"])] = (p, meta)
    if not asr:
        return 0
    try:
        listing = json.loads(_get(f"{SITE}/episodes.json"))
    except Exception as e:  # 原站掛了就先用語音稿
        print(f"  原站 episodes.json 抓不到（{e}），語音辨識稿先留著", file=sys.stderr)
        return 0
    swapped = 0
    for e in listing:
        hit = asr.get(e.get("number"))
        if not hit:
            continue
        path, meta = hit
        fname = e["filename"]
        body = _get(f"{SITE}/episodes/{urllib.parse.quote(fname)}").decode("utf-8")
        # 原站檔案第一行是「# EP694 標題」，後面才是內文
        first, _, rest = body.partition("\n")
        if not first.startswith("# EP"):
            rest = body
        ep, title = e["number"], e["title"].replace('"', "'")
        date = e.get("date") or meta.get("episode_date", "")
        yt = meta.get("youtube_url", "")
        text = "\n".join([
            "---",
            f"episode: {ep}",
            f'title: "{title}"',
            f'youtube_title: "{meta.get("youtube_title", "")}"',
            f'youtube_id: "{meta.get("youtube_id", "")}"',
            f'youtube_url: "{yt}"',
            f'episode_date: "{date}"',
            f'duration: "{meta.get("duration", "")}"',
            'source: "whatmkreallysaid.com"',
            "---",
            "",
            f"# EP{ep}｜{title}",
            "",
            f"- **YouTube 原始標題：** {meta.get('youtube_title', '')}",
            f"- **節目日期：** {date}",
            f"- **片長：** {meta.get('duration', '')}",
            f"- **影片：** [YouTube]({yt})",
            f"- **來源存檔：** [whatmkreallysaid.com]({SITE}/episode.html?file={urllib.parse.quote(fname)})",
            "",
            "---",
            "",
            rest.lstrip(),
        ])
        path.write_bytes(text.encode("utf-8"))
        swapped += 1
        print(f"  EP{ep:04d} 換成原站的校對版")
    return swapped


def main() -> int:
    args = parse_args()
    print(f"下載 {TARBALL_URL} …", flush=True)
    blob = _get(TARBALL_URL)
    print(f"  {len(blob) / 1e6:.1f} MB", flush=True)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    written = same = 0
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
        for m in tar:
            # 路徑長這樣：gooaye-agent-main/transcripts/EP0001.md
            parts = m.name.split("/")
            if not m.isfile() or len(parts) != 3 or parts[1] != "transcripts" or not parts[2].endswith(".md"):
                continue
            data = tar.extractfile(m).read()
            dest = OUT_DIR / parts[2]
            if not args.force and dest.exists() and dest.read_bytes() == data:
                same += 1
                continue
            # 本機已換成原站校對版、冷備份還是語音稿的，不要蓋回去
            if (not args.force and dest.exists() and b'source: "official_audio_asr"' in data
                    and _front(dest.read_text(encoding="utf-8")).get("source") != "official_audio_asr"):
                same += 1
                continue
            dest.write_bytes(data)
            written += 1

    episodes = sorted(p.name for p in OUT_DIR.glob("EP*.md"))
    if not episodes:
        print("沒有解出任何逐字稿，來源的目錄結構可能改了", file=sys.stderr)
        return 1
    print(f"寫入 {written} 檔、未變 {same} 檔；共 {len(episodes)} 集（{episodes[0]} – {episodes[-1]}）")
    swapped = replace_asr_with_reviewed()
    still = sorted(p.stem for p in OUT_DIR.glob("EP*.md")
                   if _front(p.read_text(encoding="utf-8")).get("source") == "official_audio_asr")
    print(f"換成校對版 {swapped} 集；仍是語音辨識稿 {len(still)} 集{('：' + '、'.join(still)) if still else ''}")
    print(f"位置：{OUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
