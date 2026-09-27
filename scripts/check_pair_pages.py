"""檢查並排頁（jp.html／kr.html 與 us.html 的「看並排」軸）的版面選擇器沒有漏。

## 為什麼要有這一支

並排表不是卡片堆疊，它是通欄的一張表，所以 `style.css` 要為它下**三條**版面規則：

    基準         max-width: 1060px            通欄、內容直接鋪在背景上
    ≤767px       padding 收窄
    ≥1024px      max-width: none + 左右留白   桌面的 .view 換成捲動窗格

三條各自帶一份 `[data-view="…"]` 的頁面清單，而**只改其中一份不會有任何東西壞掉**
——至少在你看的那個寬度不會。漏掉 ≥1024px 那一份的症狀是：桌面上窗格只剩 1060px、
捲軸停在半路、右邊空掉一整片，而手機看起來完全正常。

這一行已經漏掉三次了：日股頁自己一次、美股的並排軸一次、韓股頁一次。三次的症狀
一模一樣，三次都是有人在桌面上開了頁面才發現。檢查的成本是一秒鐘。

## 檢查兩件事

1. 三條規則的頁面清單**完全一致**。
2. 每一個載入 `pair.js` 的獨立頁面（它的 `<body data-view>`）都在那份清單裡，
   而且 `pair.js` 的 MARKETS 認得它 —— 新增一頁卻整組忘了改 CSS 的話，
   第一項會通過（三條仍然一致），只有這一項擋得住。

用法：
    python scripts/check_pair_pages.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

DOCS = Path(__file__).resolve().parent.parent / "docs"

# 「[data-view="jp"] .view」這種形狀。後面接不接 .pair-view 不管：美股頁多那一段
# 是為了不波及它另外兩個軸的卡片，頁面清單上它仍然算一票。
VIEW_RE = re.compile(r'\[data-view="([^"]+)"\]\s*\.view')
COMMENT_RE = re.compile(r"/\*.*?\*/", re.S)
# CSS 的選擇器群組：從上一個大括號之後到 `{` 為止
SELECTOR_RE = re.compile(r"([^{}]*)\{")


def css_page_sets() -> list[tuple[set, str]]:
    """style.css 裡每一條並排版面規則各自的頁面清單。"""
    css = COMMENT_RE.sub("", (DOCS / "style.css").read_text(encoding="utf-8"))
    out = []
    for m in SELECTOR_RE.finditer(css):
        keys = set(VIEW_RE.findall(m.group(1)))
        if keys:
            out.append((keys, " ".join(m.group(1).split())))
    return out


# 真的把 pair.js 掛上去的 <script>，不是「文章裡提到 pair.js」。用子字串比對的話，
# 註解寫「這一頁不吃 pair.js」的頁面會被算進來 —— cross.html 就是這樣被誤判的。
PAIR_SCRIPT_RE = re.compile(r'<script[^>]+src="pair\.js')


def pair_pages() -> dict[str, str]:
    """載入 pair.js 的獨立頁面：{data-view: 檔名}。"""
    out = {}
    for path in sorted(DOCS.glob("*.html")):
        text = path.read_text(encoding="utf-8")
        if not PAIR_SCRIPT_RE.search(text):
            continue
        m = re.search(r'<body[^>]*\bdata-view="([^"]+)"', text)
        if not m:
            sys.exit(f"docs/{path.name} 載入了 pair.js 卻沒有 <body data-view>")
        out[m.group(1)] = path.name
    return out


def pair_markets() -> set:
    """pair.js 的 MARKETS 認得哪幾個市場。"""
    js = (DOCS / "pair.js").read_text(encoding="utf-8")
    m = re.search(r"const MARKETS = \{(.*?)\n\};", js, re.S)
    if not m:
        sys.exit("讀不到 docs/pair.js 的 MARKETS，格式是不是改了？")
    return set(re.findall(r"^  (\w+): \{", m.group(1), re.M))


def main() -> int:
    rules = css_page_sets()
    if len(rules) < 2:
        sys.exit("style.css 裡找不到兩條以上的並排版面規則，選擇器是不是改了？")

    bad = False
    sets = {frozenset(keys) for keys, _ in rules}
    if len(sets) != 1:
        bad = True
        print("並排表的版面規則頁面清單對不起來：", file=sys.stderr)
        for keys, sel in rules:
            print(f"  {'、'.join(sorted(keys)):<16} {sel}", file=sys.stderr)
        print("\n三條規則（基準／≤767px／≥1024px）要列同一組頁面。"
              "只改一份的話手機看起來正常，桌面的窗格會只剩 1060px。", file=sys.stderr)

    listed = set().union(*[keys for keys, _ in rules])
    pages, markets = pair_pages(), pair_markets()

    missing_css = sorted(set(pages) - listed)
    if missing_css:
        bad = True
        print(f"\n這幾頁載入了 pair.js 卻不在 style.css 的並排版面規則裡："
              f"{'、'.join(f'{k}（docs/{pages[k]}）' for k in missing_css)}", file=sys.stderr)

    missing_js = sorted(set(pages) - markets)
    if missing_js:
        bad = True
        print(f"\n這幾頁的 data-view 不在 pair.js 的 MARKETS 裡："
              f"{'、'.join(f'{k}（docs/{pages[k]}）' for k in missing_js)}", file=sys.stderr)

    if bad:
        return 1

    print(f"並排頁版面一致：{'、'.join(sorted(listed))}"
          f"（{len(rules)} 條規則，pair.js 帶 {'、'.join(sorted(markets))}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
