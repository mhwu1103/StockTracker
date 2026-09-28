"""川普的貼文（Truth Social 與 X）擷取、解析與主題標記。

收他的理由跟 Serenity 相反：Serenity 講的是個股，他講的是**政策** ——
關稅、對中國、晶片、利率、能源、戰事。那些話一出來，台股是整族一起跳空，
不是一檔一檔。所以這一頁的索引軸是「主題 → 台股族群」，不是「代號 → 族群」。

## 只收他自己寫的字

這一頁要的是「他說了什麼」，所以三種貼文不收：

  · **純影片／純圖片／純連結** —— 沒有字，主題標不上去，也讀不出他的意思。
    他在兩個平台上都有一大半是這種（Truth Social 的最近 100 則裡 71 則）。
  · **ReTruth／RT** —— 內文是別人寫的。收進來的話，別人的話會被當成他說的。

## 兩個來源

**Truth Social（主力）** 經由 trumpstruth.org。他的文字發言幾乎都先發在那裡。
官方 API（`truthsocial.com/api/v1/…`）回 Cloudflare 403；trumpstruth.org 是
Defending Democracy Together 維護的完整存檔，robots.txt 全開放，列表頁一頁最多
100 則，底下有「下一頁」連結可以一路往回翻 —— 補歷史與每 3 小時的增量都走這一頁。
那裡**沒有互動數**，所以 Truth Social 的貼文沒有讚數。

**X（補充）** 讀 profile 首屏，路與 Serenity 完全一樣，所以 fetch_text、
ts_from_id、欄位解析都借 scripts/serenity.py。X 上有字的貼文多半是
Truth Social 的同文複製，build_trump.py 合併時會去重。X 的歷史補不回來
（Wayback 上 2026-06 之後的快照只救得回 6 則），從第一次排程開始累積。

X 的影片貼文 `full_text` 只有一個 t.co —— 那就是影片本身（`media_entities2[]
.indices` 指的正是那一段）。先照 indices 把那段刪掉，剩下沒有字的就整則不收；
其餘的 t.co 換成 `url_entities` 裡的 expanded_url。

走過而不採用的路：GitHub 上 `stiles/trump-truth-social-archive` 的社群存檔
（2025-10 之後斷斷續續、停在 2026-05-02、有編碼亂碼）。
"""

from __future__ import annotations

import base64
import html as htmllib
import json
import re
from datetime import datetime, timezone

import serenity
import twse

USER = "realDonaldTrump"
USER_NAME = "Donald J. Trump"

DATA_DIR = twse.DATA_DIR / "trump"
TWEET_DIR = DATA_DIR / "tweets"          # X
TRUTH_DIR = DATA_DIR / "truth"           # Truth Social
TOPIC_DIR = DATA_DIR / "topic"
STATE_PATH = DATA_DIR / "state.json"
INDEX_PATH = DATA_DIR / "index.json"

# 兩個來源各自的月檔目錄。月檔分開存，兩支抓取腳本才互不相干。
SOURCE_DIRS = {"x": TWEET_DIR, "truth": TRUTH_DIR}

PROFILE_URL = f"https://x.com/{USER}"
TRUTH_LIST_URL = "https://www.trumpstruth.org/?sort=desc&per_page=100"


# ---------------------------------------------------------------------------
# 主題 → 台股族群
# ---------------------------------------------------------------------------
#
# 族群名稱必須與 docs/data/us_link.json 的 groups[].name 一字不差 —— 前端會用它
# 跟美股頁、四市題材對起來。build_trump.py 每一輪都會核對，對不上的會印出來。
#
# 關鍵字是**英文、以字界切**：`\bchips?\b` 不會吃到 "chipper"，`\bAI\b` 不會吃到
# "said"。大小寫不分，但 AI 例外 —— 他全大寫寫東西是常態（"MAKE AMERICA GREAT
# AGAIN"），而小寫的 "ai" 在英文裡幾乎只會是拼錯，所以那一條單獨區分大小寫。
#
# 對照的判斷標準是「這句話一出來，台股哪一族會先動」，不是字面上的產業分類。
# 例如「關稅」對到的是傳產與運輸：電子業的關稅多半有豁免或另案處理（那會落在
# 「晶片」這一條），真正按表操課被課到的是紡織、製鞋、鋼鐵、汽車零件。
#
# groups 是空的主題（中國、股市）照樣標：它們回答的是「他今天在講什麼」，
# 只是沒有單一一族可以對。
TOPICS = [
    {"k": "tariff", "label": "關稅",
     "re": r"\btariffs?\b|\btrade (?:deals?|wars?|deficits?|imbalances?)\b|\breciprocal\b|\bduties\b",
     "g": ["傳產", "運輸"]},
    {"k": "chips", "label": "晶片",
     "re": r"\bchips?\b|\bsemiconductors?\b|\bCHIPS Act\b|\bNvidia\b|\bIntel\b|\bMicron\b"
           r"|\bTSMC\b|\bfabs?\b|\bfoundr(?:y|ies)\b",
     "g": ["晶圓代工 · 封測", "IC 設計", "半導體設備 · 測試介面"]},
    {"k": "taiwan", "label": "台灣",
     "re": r"\bTaiwan(?:ese)?\b|\bTSMC\b",
     "g": ["晶圓代工 · 封測"]},
    {"k": "ai", "label": "AI",
     "re": r"(?-i:\bAI\b)|\bartificial intelligence\b|\bdata cent(?:er|re)s?\b|\bStargate\b",
     "g": ["AI 伺服器", "網通 · 交換器", "重電 · 電網 · 綠能"]},
    {"k": "china", "label": "中國",
     "re": r"\bChina\b|\bChinese\b|\bBeijing\b|\bPresident Xi\b|\bXi Jinping\b|\bCCP\b",
     "g": []},
    {"k": "fed", "label": "利率",
     "re": r"\bthe Fed\b|\bFederal Reserve\b|\bPowell\b|\binterest rates?\b|\brate cuts?\b"
           r"|\bcut rates\b|\binflation\b|\bTreasur(?:y|ies)\b|\bbond yields?\b",
     "g": ["金融"]},
    {"k": "energy", "label": "能源",
     # 單獨的 energy 不收：他替候選人背書的制式句是 "Restore American Energy
     # DOMINANCE"，一年幾百次，收了這一條就全是背書文。military 同理（見下一條）。
     "re": r"\boil\b|\bnatural gas\b|\bLNG\b|\bdrill(?:ing)?\b|\bpipelines?\b|\bgasoline\b"
           r"|\benergy (?:prices?|costs?|production|exports?)\b"
           r"|\belectricity\b|\bpower plants?\b|\bnuclear (?:power|plants?|reactors?)\b|\bpower grid\b|\bcoal\b",
     "g": ["重電 · 電網 · 綠能", "傳產"]},
    {"k": "defense", "label": "軍事",
     "re": r"\bmilitary (?:spending|budget|equipment|contracts?)\b|\bPentagon\b|\bDepartment of War\b"
           r"|\bmissiles?\b|\bdrones?\b|\bweapons\b|\bdefen[cs]e (?:spending|budget|contractors?|industry)\b"
           r"|\bfighter jets?\b|\bF-35s?\b|\bGolden Dome\b|\bshipbuilding\b|\bwarships?\b",
     "g": ["軍工 · 航太 · 無人機"]},
    {"k": "war", "label": "戰事",
     "re": r"\bIran(?:ian)?\b|\bRussia(?:n)?\b|\bUkrain(?:e|ian)\b|\bPutin\b|\bZelensky\b"
           r"|\bIsrael\b|\bGaza\b|\bHamas\b|\bVenezuela\b|\bceasefire\b|\bpeace deal\b",
     "g": ["軍工 · 航太 · 無人機"]},
    {"k": "metals", "label": "鋼鋁 · 稀土",
     "re": r"\bsteel\b|\balumin(?:um|ium)\b|\bcopper\b|\brare earths?\b|\bcritical minerals\b",
     "g": ["傳產", "CCL · 上游材料"]},
    {"k": "autos", "label": "汽車",
     "re": r"\bauto(?:s|mobiles?|makers?| industry| plants?)\b|\bcar (?:companies|makers|plants)\b"
           r"|\belectric vehicles?\b|\bEVs?\b|\bTesla\b",
     "g": ["傳產", "功率元件 · 第三代半導體"]},
    {"k": "pharma", "label": "藥價",
     "re": r"\bdrug prices?\b|\bpharma(?:ceuticals?)?\b|\bprescription drugs?\b|\bmost favored nation\b",
     "g": ["生技醫療"]},
    {"k": "apple", "label": "蘋果",
     "re": r"\bApple\b|\biPhones?\b|\bTim Cook\b",
     "g": ["光學 · 面板", "PCB · 載板"]},
    {"k": "market", "label": "股市",
     "re": r"\bstock market\b|\bDow\b|\bS&P\b|\bNASDAQ\b|\b401\(?k\)?s?\b|\ball[- ]time highs?\b",
     "g": []},
    {"k": "crypto", "label": "加密貨幣",
     "re": r"\bcrypto(?:currency|currencies)?\b|\bBitcoin\b|\bstablecoins?\b",
     "g": []},
]

# 主題 → 族群底下的**哪幾個子族群**。台股代號從 docs/data/themes.json 取（子族群名稱
# 也要與那份一字不差，build_trump.py 會核對）。
#
# 沒寫在這裡的族群就是整族都算。要寫的是那種整族太粗的：「汽車」對到傳產的話，
# 塑化、水泥、零售都會跟著列出來，而他講的是汽車關稅，會動的只有汽車零件。
TOPIC_SUBS = {
    "tariff": {"傳產": ["紡織／製鞋", "汽車零件", "鋼鐵"], "運輸": ["貨櫃航運", "散裝航運"]},
    "taiwan": {"晶圓代工 · 封測": ["晶圓代工"]},
    "ai": {"網通 · 交換器": ["交換器／白牌", "網通零組件"],
           "重電 · 電網 · 綠能": ["重電設備", "電線電纜"]},
    "fed": {"金融": ["壽險型金控", "證券／租賃"]},
    "energy": {"傳產": ["塑化"]},
    "metals": {"傳產": ["鋼鐵", "金屬回收／稀有金屬"], "CCL · 上游材料": ["玻纖布／銅箔／樹脂"]},
    "autos": {"傳產": ["汽車零件"], "功率元件 · 第三代半導體": ["功率半導體"]},
    "pharma": {"生技醫療": ["新藥／CDMO／學名藥"]},
    "apple": {"光學 · 面板": ["鏡頭／光學元件"], "PCB · 載板": ["印刷電路板"]},
}

for _t in TOPICS:
    _t["rx"] = re.compile(_t["re"], re.I)
    _t["subs"] = TOPIC_SUBS.get(_t["k"], {})


# 替候選人背書的貼文。
#
# 他有字的貼文**一半以上是背書**（Truth Social 2026-08-11～14 那一頁，66 則裡
# 38 則），而每一則背書都附一段制式的政見清單：「keep the price of Gasoline, Oil,
# and all forms of Energy VERY LOW」「Champion our Military」「Tariffs」……
# 不排除的話，「能源」「軍事」「關稅」這幾個主題的次數會跟著他背書了幾個人走，
# 而不是跟著他對那件事說了什麼走。所以背書文不標主題，前端也預設收起來。
ENDORSE_RE = re.compile(
    r"\b(?:Complete and Total|Full and Total|Complete and Unwavering|Strong) Endorsement\b"
    r"|\bhas my (?:Complete|Full|Total|Strong)\b[^.!]{0,40}\bEndorsement\b"
    r"|\bI (?:am proud to|proudly) endorse\b|\bHonor to endorse\b", re.I)


def is_endorsement(text: str) -> bool:
    return bool(ENDORSE_RE.search(text or ""))


def topics_in(text: str) -> list:
    """這則貼文碰到哪幾個主題，照 TOPICS 的順序。背書文一律不標。"""
    if not text or is_endorsement(text):
        return []
    return [t["k"] for t in TOPICS if t["rx"].search(text)]


# ---------------------------------------------------------------------------
# 解析
# ---------------------------------------------------------------------------

def _segments(html: str):
    """(貼文 id, 那一則的片段)。切法與 serenity.parse_profile 一致：
    entry_id 落在每一則的**尾端**，所以一段是「上一個 entry_id 之後到這一個為止」。"""
    marks = list(re.finditer(r'entry_id:"tweet-(\d+)"', html))
    for i, m in enumerate(marks):
        start = marks[i - 1].end() if i else 0
        yield m.group(1), html[start:m.start()]


def _block(seg: str, field: str) -> str:
    """`field:$R[n]=[ … ]` 那一段陣列的原文，括號配對到結尾。沒有就回空字串。

    `$R[n]=` 是 RSC 序列化的參照標記，本身也帶方括號，所以不能直接找下一個 `[`。
    """
    m = re.search(rf"\b{re.escape(field)}:(?:\$R\[\d+\]=)?\[", seg)
    if not m:
        return ""
    depth = 0
    in_str = esc = False
    for i in range(m.end() - 1, len(seg)):
        c = seg[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                return seg[m.end() - 1:i + 1]
    return ""


def _media(seg: str) -> list:
    """media_entities2 裡的每一個媒體：{type, thumb, ms, at:[起, 迄]}。

    一個媒體物件的欄位順序是 `expanded_url … indices … media_url_https … type …
    video_info{duration_millis, variants}`，所以以 expanded_url 為界切成一段一個。
    `type` 用字界比對，不會吃到 variants 裡的 `content_type`。
    """
    out = []
    for part in re.split(r"(?=\bexpanded_url:)", _block(seg, "media_entities2"))[1:]:
        thumb = serenity._js_str(part, "media_url_https")
        if not thumb:
            continue
        idx = re.search(r"\bindices:(?:\$R\[\d+\]=)?\[(\d+),(\d+)\]", part)
        item = {
            "type": serenity._js_str(part, "type") or "photo",
            "thumb": thumb,
            "ms": serenity._js_int(part, "duration_millis"),
            "at": [int(idx.group(1)), int(idx.group(2))] if idx else None,
        }
        out.append({k: v for k, v in item.items() if v is not None})
    return out


def _urls(seg: str) -> list:
    """url_entities 裡的外部連結：[(t.co, 展開後的網址)]。"""
    out = []
    for part in re.split(r"(?=\bexpanded_url:)", _block(seg, "url_entities"))[1:]:
        full = serenity._js_str(part, "expanded_url")
        short = serenity._js_str(part, "url")
        if short and full and short.startswith("https://t.co/"):
            out.append((short, full))
    return out


def _strip_media(text: str, full_text: str, media: list) -> str:
    """把媒體的 t.co 從內文刪掉。

    indices 指的是 `full_text` 那一份裡的位置，而內文可能來自 note_tweet（長貼文），
    兩者的位置對不上。所以不照位置切內文，而是先用 indices 從 full_text 取出
    **那一段 t.co 字串**，再到內文裡把那個字串刪掉 —— 外部連結的 t.co 不會被誤刪。
    """
    for m in media:
        at = m.pop("at", None)
        if not at or not full_text:
            continue
        short = full_text[at[0]:at[1]]
        if short.startswith("https://t.co/"):
            text = text.replace(short, "")
    return text


URL_RE = re.compile(r"https?://\S+")


def has_words(text: str) -> bool:
    """去掉網址之後還有沒有字。只剩一條連結的貼文等於沒說話。"""
    return bool(re.search(r"[A-Za-z]{2,}", URL_RE.sub("", text or "")))


def parse_profile(html: str) -> list:
    """X 首屏裡**有字的**貼文，連結已展開、影片的 t.co 已刪掉。

    文字與互動數交給 serenity.parse_profile（長貼文在 note_tweet、付費預覽那幾個
    坑它都處理過了），這裡只負責清掉媒體連結、濾掉沒有字的與轉推。
    """
    base = {r["id"]: r for r in serenity.parse_profile(html, USER)}
    rows = []
    for tid, seg in _segments(html):
        row = base.get(tid)
        if row is None:
            continue
        # 轉推：entry_id 仍然是他的，但內文是別人的
        if "retweeted_status_result" in seg or (row.get("text") or "").startswith("RT @"):
            continue
        text = _strip_media(row.get("text") or "", serenity._js_str(seg, "full_text") or "", _media(seg))
        for short, full in _urls(seg):
            text = text.replace(short, full)
        text = text.strip()
        if not has_words(text):
            continue

        views = re.search(r'\bviews:(?:\$R\[\d+\]=)?\{count:"(\d+)"', seg)
        row.pop("tickers", None)      # 他不寫 cashtag，這個欄位永遠是空的
        row.update({
            "src": "x",
            "text": text,
            "views": int(views.group(1)) if views else None,
            "topics": topics_in(text),
        })
        rows.append({k: v for k, v in row.items() if v is not None})
    return rows


def fetch_latest() -> tuple:
    """抓 X profile 首屏：(有字的那幾則，時間新的在前, 首屏總共幾則)。

    總數要另外回：首屏五則全是影片時「有字的」是 0，那是常態；
    總數也是 0 才代表頁面結構變了。
    """
    html = serenity.fetch_text(PROFILE_URL)
    rows = parse_profile(html)
    rows.sort(key=lambda r: int(r["id"]), reverse=True)
    return rows, sum(1 for _ in _segments(html))


# ---------------------------------------------------------------------------
# Truth Social（經由 trumpstruth.org）
# ---------------------------------------------------------------------------

_STATUS_RE = re.compile(
    r'(?P<rt><div class="status__reblog-indicator">(?:(?!<div class="status").)*?)?'
    r'<div class="status" data-status-url="(?P<page>[^"]+)"', re.S)


def _html_text(fragment: str) -> str:
    """status__content 的 HTML 轉成純文字：段落之間空一行、<br> 換行、實體還原。"""
    s = re.sub(r"<br\s*/?>", "\n", fragment)
    s = re.sub(r"</p>\s*<p[^>]*>", "\n\n", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = htmllib.unescape(s).replace("\xa0", " ")
    return re.sub(r"\n{3,}", "\n\n", s).strip()


def parse_truth_list(page: str) -> tuple:
    """trumpstruth.org 列表頁 -> (有字的貼文, 這一頁最舊一則的時間, 下一頁網址)。

    一則的版面是 `[reblog-indicator] <div class="status" …> … header 裡的 <time>
    與 Original Post 連結 … status__content … </div>`。**ReTruth 的標記排在那一則
    的前面**，不在裡面 —— 所以切段時要把前面那一塊一起吃進來，照 status 的 div
    切的話，那個標記會落在上一則的尾巴，變成「上一則是轉發」。

    「翻到哪裡了」**讀下一頁連結裡的 cursor**，不取這一頁貼文的最舊時間。cursor
    是 base64 的 `{"status_created_at": "2026-08-11 14:10:37", …}`（UTC），就是
    翻頁實際依據的位置；而頁面上的 <time> 對 ReTruth 顯示的是**被轉發那一則的
    原始時間** —— 第一版取最舊時間，一則轉發五月舊文的 ReTruth 讓它以為已經翻過
    6/1，停在 7 月中，而 log 上看起來是正常結束。
    沒有下一頁（翻到底）時才退回這一頁最舊的那一則。
    """
    marks = list(_STATUS_RE.finditer(page))
    rows = []
    oldest = None
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(page)
        block = page[m.end():end]
        t = re.search(r'<time datetime="([^"]+)"', block)
        oid = re.search(r'truthsocial\.com/@\w+/(\d+)', block)
        if not t or not oid:
            continue
        ts = (datetime.fromisoformat(t.group(1)).astimezone(timezone.utc)
              .isoformat(timespec="seconds").replace("+00:00", "Z"))
        oldest = ts if oldest is None or ts < oldest else oldest
        if m.group("rt"):
            continue
        body = re.search(r'<div class="status__content"[^>]*>(.*?)</div>', block, re.S)
        text = _html_text(body.group(1)) if body else ""
        if not has_words(text):
            continue
        rows.append({
            "id": oid.group(1),
            "ts": ts,
            "src": "truth",
            "text": text,
            "topics": topics_in(text),
            "url": f"https://truthsocial.com/@{USER}/{oid.group(1)}",
        })
    nxt = re.search(r'<a href="([^"]+)" class="button button--xsmall">Next Page', page)
    if not nxt:
        return rows, oldest, None
    url = htmllib.unescape(nxt.group(1))
    at = _cursor_ts(url)
    return rows, at or oldest, url


def _cursor_ts(url: str):
    """下一頁連結的 cursor 解出來的時間（UTC ISO）。解不出來回 None。"""
    m = re.search(r"cursor=([A-Za-z0-9_\-=%]+)", url)
    if not m:
        return None
    raw = m.group(1).replace("%3D", "=")
    try:
        payload = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
        at = datetime.strptime(payload["status_created_at"], "%Y-%m-%d %H:%M:%S")
    except (ValueError, KeyError, TypeError):
        return None
    return at.replace(tzinfo=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def month_path(month: str, src: str = "x"):
    return SOURCE_DIRS[src] / f"{month}.json"


def topic_path(key: str):
    return TOPIC_DIR / f"{key}.json"


def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except ValueError:
            pass
    return {}
