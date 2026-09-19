"""檢查前端版號三處是否一致。

`docs/sw.js` 的 VERSION、`docs/index.html` 與 `docs/us.html` 裡每一個 `?v=` 都必須
是同一個數字。這是靠人記得同步的約定，而它已經漏過一次：us.html 卡在 ?v=25 的時候
index.html 已經到 35，中間十個版本裡 us.html 一直載的是另一份 style.css 快取——
畫面看起來正常，所以沒人發現。

版號一錯開的後果不只是快取：sw.js 的 SHELL 預載的是 `style.css?v=<VERSION>`，
對不上的那一份就不在離線快取裡。

用法：
    python scripts/check_frontend_version.py          # 不一致時 exit 1 並列出來
    python scripts/check_frontend_version.py --set 38 # 三處一起改成 38
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

DOCS = Path(__file__).resolve().parent.parent / "docs"
PAGES = ("index.html", "us.html")

SW_RE = re.compile(r"(const VERSION = ')(\d+)(')")
QS_RE = re.compile(r"(\?v=)(\d+)")


def collect() -> dict[str, list[tuple[str, str]]]:
    """每個檔案裡出現的版號：{檔名: [(出處, 版號), ...]}。"""
    found: dict[str, list[tuple[str, str]]] = {}

    sw = (DOCS / "sw.js").read_text(encoding="utf-8")
    m = SW_RE.search(sw)
    if not m:
        sys.exit("讀不到 docs/sw.js 的 VERSION，格式是不是改了？")
    found["sw.js"] = [("VERSION", m.group(2))]

    for name in PAGES:
        text = (DOCS / name).read_text(encoding="utf-8")
        hits = QS_RE.findall(text)
        if not hits:
            sys.exit(f"讀不到 docs/{name} 的 ?v=，格式是不是改了？")
        found[name] = [(f"?v={v}", v) for _, v in hits]

    return found


def bump(version: str) -> None:
    sw_path = DOCS / "sw.js"
    sw_path.write_text(
        SW_RE.sub(lambda m: f"{m.group(1)}{version}{m.group(3)}", sw_path.read_text(encoding="utf-8")),
        encoding="utf-8",
    )
    for name in PAGES:
        path = DOCS / name
        path.write_text(
            QS_RE.sub(lambda m: f"{m.group(1)}{version}", path.read_text(encoding="utf-8")),
            encoding="utf-8",
        )
    print(f"三處版號都設成 {version} 了。")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--set", metavar="N", help="把三處版號一起改成 N")
    args = parser.parse_args()

    if args.set:
        if not args.set.isdigit():
            sys.exit("版號要是數字。")
        bump(args.set)
        return 0

    found = collect()
    versions = {v for hits in found.values() for _, v in hits}
    if len(versions) == 1:
        print(f"前端版號一致：{versions.pop()}")
        return 0

    print("前端版號不一致：", file=sys.stderr)
    for name, hits in found.items():
        uniq = sorted({v for _, v in hits})
        print(f"  docs/{name:12} {', '.join(uniq)}", file=sys.stderr)
    print("\n改任何一支外殼檔（html／js／css）時，三處要一起加一。", file=sys.stderr)
    print("用 python scripts/check_frontend_version.py --set <N> 一次改完。", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
