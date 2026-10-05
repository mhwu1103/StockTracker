"""抓 MK（Gooaye）全部集數的逐字稿 -> data/gooaye/transcripts/EP0001.md …。

逐字稿不是自己轉的：社群已經有人整理成一份冷備份 ——
GitHub 上 huijoson/gooaye-agent 的 transcripts/ 目錄，一集一個 Markdown，
開頭是 YAML frontmatter（episode、title、episode_date、duration、youtube_url、source），
大部分來自 whatmkreallysaid.com，少數是自動語音轉錄。目錄裡的 README.md 是全集索引表。

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
import sys
import tarfile
import urllib.request
from pathlib import Path

REPO = "huijoson/gooaye-agent"
BRANCH = "main"
TARBALL_URL = f"https://codeload.github.com/{REPO}/tar.gz/refs/heads/{BRANCH}"
OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "gooaye" / "transcripts"


def parse_args():
    ap = argparse.ArgumentParser(description="抓 MK 逐字稿")
    ap.add_argument("--force", action="store_true", help="內容沒變也重寫")
    return ap.parse_args()


def main() -> int:
    args = parse_args()
    print(f"下載 {TARBALL_URL} …", flush=True)
    req = urllib.request.Request(TARBALL_URL, headers={"User-Agent": "StockTracker"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        blob = resp.read()
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
            dest.write_bytes(data)
            written += 1

    episodes = sorted(p.name for p in OUT_DIR.glob("EP*.md"))
    if not episodes:
        print("沒有解出任何逐字稿，來源的目錄結構可能改了", file=sys.stderr)
        return 1
    print(f"寫入 {written} 檔、未變 {same} 檔；共 {len(episodes)} 集（{episodes[0]} – {episodes[-1]}）")
    print(f"位置：{OUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
