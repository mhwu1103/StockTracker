"""X 帳號的貼文擷取與解析。收哪幾個帳號、各自怎麼接回台股，都在 ACCOUNTS。

這一支只負責「取得與解析」，寫檔在 fetch_x.py，出前端資料在 build_x.py。

## 收了誰、為什麼收

  · **@aleabitoreddit（Serenity）** —— AI／半導體供應鏈的分析者，主軸是「找
    供應鏈上沒人看的瓶頸」。他提過的七百個代號裡有 78 檔在這個專案的美股對照表
    （docs/data/us_link.json）上，所以他講的東西接得回台股族群。
  · **@elonmusk** —— 他一句話就是台股機器人、低軌衛星、AI 伺服器族群隔天的
    跳空來源。但他**幾乎不用 $cashtag**，照 Serenity 那套只認代號的索引，他的
    貼文一檔都接不到。所以這個帳號另外配一張關鍵字表（ELON_TOPICS）：講到
    Optimus 就歸「Optimus 人形機器人」，接到台股的機器人族群；講到 Grok、
    Colossus 就歸 xAI，接到 AI 伺服器。

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

profile 一次只吐首屏那幾則（實測 5 則，Elon 那邊其中 1 則是置頂的舊文）。
Serenity 日均約 15 則，Elon 約 70 則。**漏掉的貼文沒有第二個地方拿得到**
（見上面單篇頁那條），所以排程頻率不是效能取捨，是資料完整性本身。現在是
每 30 分鐘一次：一天 48 次 × 4 則 = 192 則的容量，對 Elon 的日均 70 則留了
兩倍半的餘裕。但他偶爾半夜一小時連發十幾則，那種時候半小時一輪還是會漏幾則
—— 這是公開首屏這條路的上限，fetch_x.py 會在整屏都是新的時候印警告。

公開 profile 的「貼文」分頁**不含回覆**。Elon 的回覆量比貼文還多，那一半
這裡收不到，頁面上要說清楚。

## 長貼文的全文在另一個欄位

超過 280 字的貼文，`full_text` 是**截斷版**，結尾接一個 t.co 連結；完整內容
在 `note_tweet.note_tweet_results.result.text`。Serenity 的深度分析幾乎都是
長貼文，只讀 full_text 的話收到的全是開頭三句，所以一律優先取 note 的那一份。
這是這支解析器最容易錯、而且錯了也看不出來的地方 —— 畫面上每一則都有內容，
只是每一則都被砍在第 280 字。

## 引用與轉推：被引用的那一則整段嵌在同一段裡

引用推文的版面是 `自己的 full_text … quoted_tweet_results:{被引用那一則的
全部欄位，含它自己的 note_tweet}`。第一版取「這一段裡最長的 note text」當
內文，結果 Elon 的「Accurate」存成了被他引用的那一篇 AGI 長文 —— 內文是別人
寫的，作者欄卻是他，而且看起來完全合理。所以 `_split_nested` 先在
`quoted_tweet_results` / `retweeted_status_result` 那裡切開：前面才是自己的，
後面那一則另外存成 `quote`（Elon 的「True」不帶原文根本看不懂）。
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass, field
from datetime import datetime, timezone

import twse

DATA_ROOT = twse.DATA_DIR / "x"
ACCOUNTS_PATH = DATA_ROOT / "accounts.json"

# 一般瀏覽器的 UA。X 對 curl 的預設 UA 只回登入牆的空殼，
# 換成瀏覽器的字串才會吐出含貼文的那一份 HTML。
USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

# 摘要長度。ticker 檔裡每篇存這麼多字，全文留在月檔、前端點開才載 ——
# Serenity 提最多的 SIVE 有 691 篇，整包存全文那一個檔就 400 KB。
SUMMARY_CHARS = 240

# 被引用那一則存多少字。它是用來看懂「他在回應什麼」的上下文，不是存檔的對象
# —— 那一則的全文在原作者自己的時間軸上，這裡不必再存一份。
QUOTE_CHARS = 400

# $XXXX。後面不接英數是為了讓 `$SPY.` 收得到、而 `$150k`、`$SUBWAY`（六個字母）
# 收不到。cashtag 一律轉大寫比對，X 上寫小寫的不算少。
CASHTAG_RE = re.compile(r"\$([A-Za-z]{1,5})(?![A-Za-z0-9])")

# 這些是貨幣與常見縮寫，不是股票代號。混進去的話 ticker 索引會多出一堆空族群。
NOT_TICKER = {
    "USD", "TWD", "JPY", "EUR", "GBP", "CNY", "KRW", "RMB", "HKD",
    "B", "M", "K", "T", "BN", "MM", "USDT", "USDC",
}


@dataclass(frozen=True)
class Topic:
    """一個關鍵字主題：沒有 cashtag 的貼文靠它接回台股。

    key 跟 cashtag 共用同一個索引空間（ticker/<key>.json），所以一律用小寫開頭
    或底線之類 cashtag 不可能長成的樣子 —— 不然「TSLA」主題與 $TSLA 會撞在同一檔。
    例外是刻意要併進代號的（Tesla → TSLA），那種直接寫代號，用 us_link 的族群。
    """
    key: str
    name: str
    pattern: str
    groups: tuple = ()          # 台股族群名，要跟 us_link.json 的 group name 一字不差


# Elon 的關鍵字表。
#
# 收的原則是「講到它，台股有一族會動」，不是「他的公司全列」—— The Boring
# Company、X 這個平台本身都不收：前者台股沒有對應，後者他每則都在講。
#
# 字要寫得夠窄。`Falcon` 單獨出現太常見（球隊、車款），所以只收 Falcon 9／Heavy；
# `Dragon` 也一樣只收 Crew／Cargo Dragon；`X` 更是根本不能當關鍵字。
# `\b` 夾住是為了不讓 Grokking、Teslas 以外的東西混進來 —— Teslas 另外放寬。
ELON_TOPICS = (
    Topic("TSLA", "Tesla",
          r"\bTesla(?:s|'s)?\b|\bFSD\b|\bRobotaxi|\bCybercab|\bCybertruck|\bModel [3SXY]\b"
          r"|\bMegapack|\bPowerwall|\bGiga ?(?:Texas|Berlin|Shanghai|Nevada|factory)"),
    Topic("optimus", "Optimus 人形機器人", r"\bOptimus\b|\bhumanoid",
          ("機器人 · 自動化 · 工具機",)),
    Topic("xai", "xAI · Grok", r"\bxAI\b|\bGrok\b|\bColossus\b|\bMacrohard\b",
          ("AI 伺服器",)),
    Topic("spacex", "SpaceX · Starship",
          r"\bSpaceX\b|\bStarship\b|\bSuper Heavy\b|\bFalcon (?:9|Heavy)\b|\bRaptor [23]\b"
          r"|\b(?:Crew|Cargo) Dragon\b|\bStarbase\b",
          ("軍工 · 航太 · 無人機",)),
    # 台股的低軌衛星供應鏈（啟碁、昇達科、華通）在 us_link 裡歸網通那一族
    Topic("starlink", "Starlink 低軌衛星", r"\bStarlink\b|\bStarshield\b",
          ("網通 · 交換器",)),
    Topic("neuralink", "Neuralink", r"\bNeuralink\b|\bBlindsight\b", ("生技醫療",)),
)


@dataclass(frozen=True)
class Account:
    user: str                   # X 的帳號（不含 @）
    name: str                   # 顯示名
    title: str                  # 頁面標題
    blurb: str                  # 一句話說明這個帳號為什麼在這裡
    # 貼文存檔的切法：month = YYYY-MM.json，day = YYYY-MM-DD.json。
    #
    # Elon 一個月兩千則，月檔是 1 MB 以上的一整行 JSON。排程每 30 分鐘一輪、
    # 每一輪他都有新貼文，照月檔存的話每一輪都是一次 1 MB 的 git 差異，
    # 一個月 repo 會長好幾百 MB。切成日檔之後每一輪只重寫當天那幾十 KB。
    bucket: str = "month"
    archive_url: str | None = None      # --seed 用的歷史存檔
    topics: tuple = field(default=())   # 關鍵字主題（沒有的就只認 cashtag）

    @property
    def data_dir(self):
        return DATA_ROOT / self.user

    @property
    def tweet_dir(self):
        return self.data_dir / "tweets"

    @property
    def ticker_dir(self):
        return self.data_dir / "ticker"

    @property
    def state_path(self):
        return self.data_dir / "state.json"

    @property
    def index_path(self):
        return self.data_dir / "index.json"

    @property
    def tickers_path(self):
        return self.data_dir / "tickers.json"

    @property
    def profile_url(self):
        return f"https://x.com/{self.user}"

    def bucket_of(self, row: dict) -> str:
        """這則貼文歸哪一個存檔。沒有時間的歸到 unknown，不要讓它擋住整批寫入。"""
        ts = row.get("ts") or ""
        n = 10 if self.bucket == "day" else 7
        return ts[:n] if len(ts) >= n else "unknown"

    def bucket_path(self, bucket: str):
        return self.tweet_dir / f"{bucket}.json"

    def ticker_path(self, ticker: str):
        return self.ticker_dir / f"{ticker}.json"

    def tags_in(self, *texts) -> list:
        """貼文提到的標的：cashtag 在前、關鍵字主題在後，去重後照出現順序。"""
        joined = "\n".join(t for t in texts if t)
        out = tickers_in(joined)
        for topic in self.topics:
            if topic.key not in out and re.search(topic.pattern, joined, re.IGNORECASE):
                out.append(topic.key)
        return out

    def load_state(self) -> dict:
        if self.state_path.exists():
            try:
                return json.loads(self.state_path.read_text(encoding="utf-8"))
            except ValueError:
                pass
        return {}


ACCOUNTS = {
    a.user: a for a in (
        Account(
            user="aleabitoreddit",
            name="Serenity",
            title="Serenity 供應鏈觀點",
            blurb="談 AI 與半導體供應鏈上還沒被看到的瓶頸",
            archive_url=("https://raw.githubusercontent.com/yan-labs/serenity-aleabitoreddit"
                         "/HEAD/data/aleabitoreddit_tweets.json"),
        ),
        Account(
            user="elonmusk",
            name="Elon Musk",
            title="Elon Musk",
            blurb="Tesla、Optimus、xAI、SpaceX／Starlink —— 台股機器人、AI 伺服器、低軌衛星族群的消息面",
            bucket="day",
            topics=ELON_TOPICS,
        ),
    )
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

    這比讀欄位可靠 —— 欄位缺席時整則貼文會沒有時間，而時間是分檔存檔的依據。
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

    「這一段」必須已經把被引用的那一則切掉（見 `_split_nested`），不然最長的
    那個可能是別人的長文。
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


NESTED_RE = re.compile(r"\b(quoted_tweet_results|retweeted_status_result):")


def _split_nested(seg: str):
    """(自己那一段, 巢狀那一則的種類, 巢狀那一段)。沒有巢狀的話後兩者是 None。

    巢狀那一則（被引用的、或被轉推的原文）的範圍是從標記開始，到它自己的
    rest_id **最後一次出現**為止 —— RSC 在物件收尾時會再帶一次 id。那之後
    剩下的一小段又回到外層，所以自己那一段是「標記之前 ＋ 那之後」。
    外層的 note_tweet 如果排在巢狀之後，就是落在後面那一截。
    """
    m = NESTED_RE.search(seg)
    if not m:
        return seg, None, None
    inner = seg[m.end():]
    ids = re.findall(r'rest_id:"(\d+)"', inner)
    # 第一個 rest_id 是那一則貼文自己的（User 的 rest_id 排在它後面）
    end = len(inner)
    if ids:
        last = inner.rfind(f'rest_id:"{ids[0]}"')
        end = last + len(ids[0]) + 10
    kind = "quote" if m.group(1) == "quoted_tweet_results" else "repost"
    return seg[:m.start()] + inner[end:], kind, inner[:end]


def _own_text(seg: str, locked: bool = False):
    # 長貼文的全文在 note_tweet；兩個欄位同時存在時 full_text 是 280 字的
    # 截斷版，所以順序不能反。
    text = _note_text(seg) or _js_str(seg, "full_text")
    if not text and locked:
        text = _js_str(seg, "text")
    return (text or "").strip() or None


def _nested(inner: str) -> dict | None:
    """被引用／被轉推的那一則：{id, u, text}。

    它自己也可能引用了別人（引用中的引用），那一層不再往下收 —— 切掉，只留
    這一則自己的話。
    """
    own, _, _ = _split_nested(inner)
    tid = re.search(r'rest_id:"(\d+)"', own)
    text = _own_text(own)
    if not tid or not text:
        return None
    return {
        "id": tid.group(1),
        "u": _js_str(own, "screen_name"),
        "text": text,
    }


def parse_profile(html: str, user: str) -> list:
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

        # 置頂文每一輪都在首屏，但它是舊文。標起來，fetch_x.py 算「這一輪有幾則
        # 新的」時要扣掉它 —— 不然整屏五則裡最多只會有四則新的，「首屏整屏都是
        # 新的＝正在漏」那個警告永遠不會響。
        pinned = 'Pinned"' in seg

        own, kind, inner = _split_nested(seg)
        nested = _nested(inner) if inner else None

        # 付費訂閱（Super Follows）的貼文，未訂閱時只拿得到 og 等級的短預覽，
        # 結尾是刪節號。它是真的沒有全文，不是解析失敗 —— 標記起來，讓前端
        # 說得出「這則要訂閱才看得到」，而不是假裝那 51 個字就是全文。
        locked = "TweetPreviewDisplay" in own

        text = _own_text(own, locked)
        if kind == "repost" and nested:
            # 純轉推的 full_text 是「RT @某人: 」加上截斷的原文。內文就用原文，
            # 另外標出這是轉推、原作者是誰 —— 那不是他寫的字。
            text = nested["text"]
        if not text:
            continue

        row = {
            "id": tid,
            "ts": ts_from_id(tid),
            "text": text,
            "locked": locked or None,
            "pinned": pinned or None,
            "likes": _js_int(own, "favorite_count"),
            "replies": _js_int(own, "reply_count"),
            "reposts": _js_int(own, "retweet_count"),
            "bookmarks": _js_int(own, "bookmark_count"),
            "url": f"https://x.com/{user}/status/{tid}",
        }
        if nested and kind == "quote":
            quoted = dict(nested)
            quoted["text"], _ = summarize(quoted["text"], QUOTE_CHARS)
            row["quote"] = quoted
        elif nested:
            row["repost_of"] = nested["u"]
        rows.append(row)
    return rows


def fetch_latest(acct: Account) -> list:
    """抓 profile 首屏的那幾則。時間新的在前。"""
    rows = parse_profile(fetch_text(acct.profile_url), acct.user)
    for row in rows:
        # 引用的話，被引用那一則的內容也算他在講的主題 —— Elon 引用一篇
        # 講 Grok 的貼文、只回一句「Upgrades」，他講的就是 Grok。
        row["tickers"] = acct.tags_in(row["text"], (row.get("quote") or {}).get("text"))
    rows.sort(key=lambda r: int(r["id"]), reverse=True)
    return rows


def summarize(text: str, limit: int = SUMMARY_CHARS) -> tuple:
    """(摘要, 是否被截斷)。切在字界上，不要把單字剖一半。"""
    text = (text or "").strip()
    if len(text) <= limit:
        return text, False
    cut = text[:limit]
    space = cut.rfind(" ")
    if space > limit * 0.6:
        cut = cut[:space]
    return cut.rstrip() + "…", True
