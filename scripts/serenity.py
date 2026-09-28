"""X 帳號 @aleabitoreddit（Serenity）的貼文擷取與解析。

他是 AI／半導體供應鏈的分析者，貼文以「找供應鏈上沒人看的瓶頸」為主軸，
提及最多的是 SIVE、NBIS、LITE、AXTI、AAOI、NVDA、IREN 這一類光通訊、
記憶體與電力半導體的標的 —— 與這個專案的美股對照表（docs/data/us_link.json）
有 78 檔重疊，所以他講的東西接得回台股族群，這是收這份資料的理由。

這一支只負責「取得與解析」，寫檔在 fetch_x.py，出前端資料在 build_x.py。

## 資料從哪來

X 未登入時仍然會把首屏的貼文「伺服器端算好」塞在 HTML 裡（React Server
Component 的資料 blob）。這一支就是讀那一段，不碰 cookie、不碰登入狀態、
不用 API key。實測可取得完整內容，包含長貼文的全文。

走過而不採用的路，理由記在這裡免得有人再試一次：

  · **官方 API** —— 免費層讀不到別人的時間軸，Basic 一個月 200 美金。
  · **單篇 status 頁** —— 未登入只回 og:description 的 51 字摘要，
    補抓歷史這條路是死的。歷史只能靠既有存檔（見 fetch_x.py 的 --seed）。
  · **Nitter 各公開實例** —— 實測全數連不上，X 封掉 guest token 之後就沒了。
  · **r.jina.ai 之類的純文字代理** —— 對 x.com 這個網域回 403（它那邊被
    濫用擋掉了），不能當主要來源。

## 首屏只有五則，所以抓取頻率是設計的一部分

profile 一次只吐首屏那幾則（實測 5 則），而他日均約 15 則。**每天只跑一次
會漏掉大半**，這不是重試能補的 —— 漏掉的貼文沒有第二個地方拿得到（見上面
單篇頁那條）。所以排程是每 3 小時一次，一天 8 次 × 5 則 = 40 則的容量，
對日均 15 則留了兩倍以上的餘裕；他偶爾一晚連發十幾則，餘裕就是留給那種時候的。

## 長貼文的全文在另一個欄位

超過 280 字的貼文，`full_text` 是**截斷版**，結尾接一個 t.co 連結；完整內容
在 `note_tweet.note_tweet_results.result.text`。他的深度分析幾乎都是長貼文，
只讀 full_text 的話收到的全是開頭三句，所以 `parse_profile` 一律優先取
note 的那一份。這是這支解析器最容易錯、而且錯了也看不出來的地方 ——
畫面上每一則都有內容，只是每一則都被砍在第 280 字。
"""

from __future__ import annotations

import json
import re
import subprocess
from datetime import datetime, timezone

import twse

USER = "aleabitoreddit"
USER_NAME = "Serenity"

DATA_DIR = twse.DATA_DIR / "x"
TWEET_DIR = DATA_DIR / "tweets"
TICKER_DIR = DATA_DIR / "ticker"
STATE_PATH = DATA_DIR / "state.json"
INDEX_PATH = DATA_DIR / "index.json"
TICKERS_PATH = DATA_DIR / "tickers.json"

PROFILE_URL = f"https://x.com/{USER}"

# 一般瀏覽器的 UA。X 對 curl 的預設 UA 只回登入牆的空殼，
# 換成瀏覽器的字串才會吐出含貼文的那一份 HTML。
USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

# 摘要長度。ticker 檔裡每篇存這麼多字，全文留在月檔、前端點開才載 ——
# 他提最多的 SIVE 有 691 篇，整包存全文那一個檔就 400 KB。
SUMMARY_CHARS = 240

# $XXXX。後面不接英數是為了讓 `$SPY.` 收得到、而 `$150k`、`$SUBWAY`（六個字母）
# 收不到。cashtag 一律轉大寫比對，X 上寫小寫的不算少。
CASHTAG_RE = re.compile(r"\$([A-Za-z]{1,5})(?![A-Za-z0-9])")

# 這些是貨幣與常見縮寫，不是股票代號。混進去的話 ticker 索引會多出一堆空族群。
NOT_TICKER = {
    "USD", "TWD", "JPY", "EUR", "GBP", "CNY", "KRW", "RMB", "HKD",
    "B", "M", "K", "T", "BN", "MM", "USDT", "USDC",
}


def fetch_text(url: str, *, timeout: int = 35, retries: int = 3) -> str:
    """抓一個公開頁面。

    用 curl 而不是 requests：X 會依 TLS 指紋擋掉一部分程式化的客戶端，
    curl 目前過得去。requirements.txt 裡只有 requests，curl 則是 runner 與
    開發機都有的東西，不必為了這一支多裝相依。
    """
    last = None
    for attempt in range(1, retries + 1):
        try:
            result = subprocess.run(
                ["curl", "-L", "-sS", "--fail-with-body",
                 "--connect-timeout", "10", "--max-time", str(timeout),
                 "-A", USER_AGENT, url],
                capture_output=True, timeout=timeout + 10,
            )
            if result.returncode != 0:
                detail = (result.stderr or b"").decode("utf-8", "replace").strip()
                raise RuntimeError(detail[:200] or f"curl 回 {result.returncode}")
            text = result.stdout.decode("utf-8", "replace")
            if not text.strip():
                raise RuntimeError("回應是空的")
            return text
        except Exception as err:  # noqa: BLE001 —— 重試前不分類型
            last = err
            if attempt < retries:
                import time
                time.sleep(3.0 * attempt)
    raise RuntimeError(f"抓不到 {url}：{last}")


def _js_str(segment: str, field: str):
    """從 RSC 的資料 blob 裡取一個字串欄位。

    blob 是 JS 物件字面值（`full_text:"…"`，鍵沒有引號），不是 JSON，
    所以只能照欄位名抓，再借 JSON 的字串規則把跳脫還原回來 —— 兩者的
    跳脫語法在這裡是相容的，而自己寫 unescape 會在 \\uXXXX 上出錯。
    """
    m = re.search(rf'\b{re.escape(field)}:"((?:\\.|[^"\\])*)"', segment)
    if not m:
        return None
    try:
        return json.loads('"' + m.group(1) + '"')
    except ValueError:
        return m.group(1)


def _js_int(segment: str, field: str):
    m = re.search(rf'\b{re.escape(field)}:(?:"(\d+)"|(\d+))', segment)
    if not m:
        return None
    return int(m.group(1) or m.group(2))


def tickers_in(text: str) -> list:
    """貼文裡提到的股票代號，去重後照出現順序。"""
    out = []
    for raw in CASHTAG_RE.findall(text or ""):
        t = raw.upper()
        if t in NOT_TICKER or t in out:
            continue
        out.append(t)
    return out


# 貼文 id 是 snowflake，高位就是毫秒時間戳。X 的 epoch 是 2010-11-04。
SNOWFLAKE_EPOCH_MS = 1288834974657


def ts_from_id(tid) -> str:
    """從貼文 id 解出發文時間（UTC 的 ISO 字串）。

    profile 的 blob 裡**多數貼文沒有 created_at**（實測 5 則只有 1 則有），
    但 id 本身就帶著時間。對照過那一則有 created_at 的：解出 02:06:06.122，
    HTML 寫的是 02:06:06，秒數一致。

    這比讀欄位可靠 —— 欄位缺席時整則貼文會沒有時間，而時間是分月存檔的依據。
    """
    return (datetime.fromtimestamp(((int(tid) >> 22) + SNOWFLAKE_EPOCH_MS) / 1000, timezone.utc)
            .isoformat(timespec="seconds").replace("+00:00", "Z"))


def _note_text(segment: str):
    """note_tweet 裡的長貼文全文。

    取**最長**的 text 而不是第一個：note 的結構是
    `note_tweet_results.result.{entity_set:{symbols:[{text:"AKAM"},…]}, text:"全文"}`，
    entity_set 排在全文前面，照順序抓會抓到 `AKAM`、`SPY` 這種 cashtag 字串
    —— 而且看起來很像成功抓到了東西（第一版就是這樣，存進去三則貼文的內文
    分別是「AKAM」「SPY」四個字）。全文一定是這一段裡最長的那個。
    """
    note_at = segment.find("note_tweet")
    if note_at < 0:
        return None
    cands = []
    for m in re.finditer(r'\btext:"((?:\\.|[^"\\])*)"', segment[note_at:]):
        try:
            cands.append(json.loads('"' + m.group(1) + '"'))
        except ValueError:
            cands.append(m.group(1))
    return max(cands, key=len) if cands else None


def parse_profile(html: str, user: str = USER) -> list:
    """從 profile 頁的 HTML 解析出貼文。

    切段用 `entry_id:"tweet-<id>"`：它一則一個、順序就是時間軸的順序，而且
    **只標記這個帳號自己的貼文**。用 `__typename:"Tweet"` 切會把引用的那一則
    原文也收成獨立紀錄；用 status 連結切則會漏掉沒有連結形式的那幾則。

    **entry_id 落在每一則的尾端**，不是開頭：一則的版面是
    `rest_id … favorite_count … full_text … note_tweet … entry_id`。
    所以一段的範圍是「上一個 entry_id 之後，到這一個 entry_id 為止」。
    切反的話每一則都會配到下一則的內文 —— 時間、讚數、正文各自來自相鄰的
    兩則貼文，而每一欄看起來都是合法的值。
    """
    marks = list(re.finditer(r'entry_id:"tweet-(\d+)"', html))
    if not marks:
        return []

    rows = []
    for i, m in enumerate(marks):
        start = marks[i - 1].end() if i else 0
        seg = html[start:m.start()]
        tid = m.group(1)

        # 付費訂閱（Super Follows）的貼文，未訂閱時只拿得到 og 等級的短預覽，
        # 結尾是刪節號。它是真的沒有全文，不是解析失敗 —— 標記起來，讓前端
        # 說得出「這則要訂閱才看得到」，而不是假裝那 51 個字就是全文。
        locked = "TweetPreviewDisplay" in seg

        # 長貼文的全文在 note_tweet；兩個欄位同時存在時 full_text 是 280 字的
        # 截斷版，所以順序不能反。
        text = _note_text(seg) or _js_str(seg, "full_text")
        if not text and locked:
            text = _js_str(seg, "text")
        if not text:
            continue

        text = text.strip()
        rows.append({
            "id": tid,
            "ts": ts_from_id(tid),
            "text": text,
            "locked": locked or None,
            "likes": _js_int(seg, "favorite_count"),
            "replies": _js_int(seg, "reply_count"),
            "reposts": _js_int(seg, "retweet_count"),
            "bookmarks": _js_int(seg, "bookmark_count"),
            "tickers": tickers_in(text),
            "url": f"https://x.com/{user}/status/{tid}",
        })
    return rows


def fetch_latest() -> list:
    """抓 profile 首屏的那幾則。時間新的在前。"""
    rows = parse_profile(fetch_text(PROFILE_URL))
    rows.sort(key=lambda r: int(r["id"]), reverse=True)
    return rows


def month_of(row: dict) -> str:
    """這則貼文歸哪一個月檔。沒有時間的歸到 unknown，不要讓它擋住整批寫入。"""
    ts = row.get("ts") or ""
    return ts[:7] if len(ts) >= 7 else "unknown"


def month_path(month: str):
    return TWEET_DIR / f"{month}.json"


def ticker_path(ticker: str):
    return TICKER_DIR / f"{ticker}.json"


def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except ValueError:
            pass
    return {}


def summarize(text: str) -> tuple:
    """(摘要, 是否被截斷)。切在字界上，不要把單字剖一半。"""
    text = (text or "").strip()
    if len(text) <= SUMMARY_CHARS:
        return text, False
    cut = text[:SUMMARY_CHARS]
    space = cut.rfind(" ")
    if space > SUMMARY_CHARS * 0.6:
        cut = cut[:space]
    return cut.rstrip() + "…", True
