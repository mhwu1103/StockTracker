"""X 帳號 @realDonaldTrump 的貼文擷取、解析與主題標記。

收這個帳號的理由跟 Serenity 相反：Serenity 講的是個股，他講的是**政策** ——
關稅、對中國、晶片、利率、能源、戰事。那些話一出來，台股是整族一起跳空，
不是一檔一檔。所以這一頁的索引軸是「主題 → 台股族群」，不是「代號 → 族群」。

擷取的路與 Serenity 完全一樣（未登入讀 profile 首屏的伺服器端資料 blob），
所以 fetch_text、ts_from_id、字串欄位的解析都直接借 scripts/serenity.py，
這一支只放他這個帳號特有的東西。那條路為什麼是這條、別的路為什麼走不通，
理由都在 serenity.py 的 docstring。

## 他在 X 上發的多半是影片

實測首屏 5 則全是影片貼文，`full_text` 只有一個 t.co 連結 —— 那個連結就是
影片本身（`media_entities2[].indices` 指的正是那一段）。他的文字發言主要在
Truth Social，X 這邊比較像是轉貼演講與訪談的片段。

所以這裡要做兩件事，否則畫面上會是一整排「https://t.co/…」：

  · 把媒體連結從內文切掉（照 indices 切，不是照字串找 —— 同一個 t.co 在
    內文裡出現兩次的時候，只有 indices 知道哪一個是媒體）。
  · 媒體另存成 `media`：類型、縮圖、影片長度。前端畫得出「這是一段 3 分鐘
    的影片」，而不是一則空白的貼文。

其餘的 t.co（外部連結）換成 `url_entities` 裡的 expanded_url。存 t.co 的話
使用者看不出那是連到哪裡，而 t.co 本身哪天失效了也還原不回來。

## Truth Social 為什麼不收

試過，走不通，記在這裡免得有人再試一次：

  · `truthsocial.com/api/v1/accounts/…/statuses` —— 回 Cloudflare 403。
  · GitHub 上 `stiles/trump-truth-social-archive` 的社群存檔 —— 有 2.9 萬則，
    但 2025-10 之後斷斷續續、最後一則停在 2026-05-02，而且有編碼亂碼。
    只能當歷史，接不了即時。
"""

from __future__ import annotations

import json
import re

import serenity
import twse

USER = "realDonaldTrump"
USER_NAME = "Donald J. Trump"

DATA_DIR = twse.DATA_DIR / "trump"
TWEET_DIR = DATA_DIR / "tweets"
TOPIC_DIR = DATA_DIR / "topic"
STATE_PATH = DATA_DIR / "state.json"
INDEX_PATH = DATA_DIR / "index.json"

PROFILE_URL = f"https://x.com/{USER}"


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

for _t in TOPICS:
    _t["rx"] = re.compile(_t["re"], re.I)


def topics_in(text: str) -> list:
    """這則貼文碰到哪幾個主題，照 TOPICS 的順序。"""
    if not text:
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


def parse_profile(html: str) -> list:
    """首屏的貼文，帶媒體、展開後的連結與主題標記。

    文字與互動數交給 serenity.parse_profile（長貼文在 note_tweet、付費預覽那幾個
    坑它都處理過了），這裡只補他這個帳號需要的欄位。
    """
    base = {r["id"]: r for r in serenity.parse_profile(html, USER)}
    rows = []
    for tid, seg in _segments(html):
        row = base.get(tid)
        media = _media(seg)
        if row is None:
            # 純影片、連 t.co 都沒有的那種：serenity 那邊會因為沒有內文而跳過，
            # 但對他這個帳號來說，一段影片就是一則完整的貼文。
            if not media:
                continue
            row = {
                "id": tid,
                "ts": serenity.ts_from_id(tid),
                "text": "",
                "likes": serenity._js_int(seg, "favorite_count"),
                "replies": serenity._js_int(seg, "reply_count"),
                "reposts": serenity._js_int(seg, "retweet_count"),
                "bookmarks": serenity._js_int(seg, "bookmark_count"),
                "url": f"https://x.com/{USER}/status/{tid}",
            }
        text = _strip_media(row.get("text") or "", serenity._js_str(seg, "full_text") or "", media)
        for short, full in _urls(seg):
            text = text.replace(short, full)
        text = text.strip()

        views = re.search(r'\bviews:(?:\$R\[\d+\]=)?\{count:"(\d+)"', seg)
        # 轉推：entry_id 仍然是他的，但內文是別人的。標出來，不然會被當成他說的話。
        rt = "retweeted_status_result" in seg

        row.pop("tickers", None)      # 他不寫 cashtag，這個欄位永遠是空的
        row.update({
            "text": text,
            "media": media or None,
            "views": int(views.group(1)) if views else None,
            "rt": rt or None,
            "topics": topics_in(text),
        })
        rows.append({k: v for k, v in row.items() if v is not None})
    return rows


def fetch_latest() -> list:
    """抓 profile 首屏的那幾則。時間新的在前。"""
    rows = parse_profile(serenity.fetch_text(PROFILE_URL))
    rows.sort(key=lambda r: int(r["id"]), reverse=True)
    return rows


def month_path(month: str):
    return TWEET_DIR / f"{month}.json"


def topic_path(key: str):
    return TOPIC_DIR / f"{key}.json"


def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except ValueError:
            pass
    return {}
