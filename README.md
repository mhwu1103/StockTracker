# 台股成交值排行追蹤器

每天自動抓取臺灣證券交易所的上市收盤行情，算出**成交值前 200 大排行**並保存歷史，
用手機開網址就能看排行、進出榜與個股排名走勢。

沒有伺服器、沒有資料庫：排程跑在 GitHub Actions，資料是 repo 裡的 JSON，
前端是純靜態網頁掛在 GitHub Pages。

## 功能

| 分頁 | 內容 |
|---|---|
| 排行 | 任一交易日的成交值前 200 大，含相對前 1／5／20 日的名次變化箭頭、連續進榜天數、搜尋 |
| 站穩 | 新進榜後連續留在榜上的股票：剛滿 N 天（N 可選 2／3／5／10）與連續 N 天以上 |
| 異動 | 新進榜、掉出榜、名次進步／退步最多的前 20 名 |
| 個股 | 排名走勢與成交值走勢圖（未進前 300 的日子會斷線）、區間統計與全期間紀錄 |
| 對照 | 自選任兩個交易日並排比較 |
| 大盤 | 大盤與前 200 大的成交值走勢，以及前 200／前 10 大佔大盤的資金集中度 |
| 族群 | 榜上各產業的檔數、成交值與佔比，可展開看該產業當日在榜的個股 |

最新資料距今太久時，頂部會顯示過期提醒，避免把舊資料誤看成當天的盤。

## 資料來源

| 用途 | 端點 |
|---|---|
| 當日收盤（每日排程） | `https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL` |
| 指定日期（歷史回補） | `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=YYYYMMDD&type=ALLBUT0999&response=json` |
| 產業別對照 | `https://openapi.twse.com.tw/v1/opendata/t187ap03_L` |

兩者產出的資料格式已統一，同一天用兩條路徑抓取結果完全一致。
範圍是**上市**股票與 ETF，已排除權證、牛熊證等商品。

## 目錄結構

```
scripts/
  twse.py           共用：抓取、欄位正規化、民國轉西元
  fetch_daily.py    抓當日 → docs/data/daily/YYYY-MM-DD.json
  backfill.py       用 MI_INDEX 逐日回補歷史（可中斷續跑）
  build_history.py  由 daily/ 重算 index.json 與 history/YYYY.json
  fetch_industry.py 抓上市公司的產業別 → docs/data/industry.json
  notify_telegram.py 把當日新進榜／連續 2、3、5 天的清單推播到 Telegram
  serve.py          本機開發用的靜態伺服器（送出 no-store，不會被快取咬）
docs/               GitHub Pages 網站根目錄
  index.html app.js style.css sw.js manifest.webmanifest icons/
  data/
    index.json      交易日清單 + 每日大盤／前 200／前 10 大成交值
    industry.json   代號 -> 產業中文名（ETF 與特別股由前端補規則）
    daily/          每日前 300 名（多存 100 名以便判斷前 200 的進出榜）
                    前 200 名另帶 streak（連續進榜天數）與 since（連續起算日）
    history/        依年度切檔的「個股 → 每日 (名次, 成交值)」轉置表
```

產業別採證交所的官方分類，與市場口中的題材族群（AI 伺服器、重電等）不一定對得起來；
分類取自最新一次抓取的結果，並回頭套用到歷史日期。

`docs/data/history/`、`index.json` 與 daily 檔裡的連續進榜欄位都是衍生資料，
`build_history.py` 每次都由 `daily/` 從頭重算，只有內容真的改變的檔案才會重寫。

連續進榜天數以「成交值前 200 名」為準。若某段連續紀錄一路連到本站最早的日期
（目前是 2024-08-16），前端會顯示成 `連 484+ 天`，表示實際天數可能更長。

## 本機使用

```bash
pip install -r requirements.txt
python scripts/fetch_daily.py        # 抓最新一個交易日
python scripts/fetch_industry.py     # 抓產業別對照（偶爾跑一次就好）
python scripts/build_history.py      # 重建索引與歷史
cd docs && python -m http.server 8765
```

瀏覽器開 <http://localhost:8765>。

回補更多歷史（每次請求間隔 4 秒以免被證交所限流，兩年約需 35 分鐘）：

```bash
python scripts/backfill.py --from 2024-08-16 --to 2026-08-14
python scripts/build_history.py
```

## 部署到 GitHub Pages

1. 把整個目錄推上 GitHub。
2. Settings → Pages → Source 選 **`GitHub Actions`**（不是 `Deploy from a branch`）。
   排程流程會自己把 `docs/` 發佈出去；走分支部署的話，機器人的 push 不會觸發
   Pages 重新建置，網站會停在舊資料。
3. Settings → Actions → General → Workflow permissions 選 `Read and write permissions`
   （排程需要把資料 commit 回 repo）。
4. Actions 分頁手動跑一次「每日更新成交值排行」確認流程正常。

每天的資料是由 GitHub 配發的臨時虛擬機提交的，作者顯示為 `github-actions[bot]`，
用的是每次執行自動產生、結束即失效的 `GITHUB_TOKEN`，你不需要設定任何金鑰。

之後每個交易日台灣時間 16:30 左右會自動更新。

## Telegram 每日推播（選用）

每個交易日收盤後推播當日新進榜、以及連續進榜 2／3／5 天的清單。
沒有設定金鑰時這一步會自動略過，不影響其他流程。

1. Telegram 找 **@BotFather** → `/newbot` → 取得 bot token。
2. 對你的新 bot 隨便說一句話，然後開
   `https://api.telegram.org/bot<TOKEN>/getUpdates`，找 `"chat":{"id":...}` 就是你的 chat id。
3. GitHub repo → Settings → Secrets and variables → Actions → New repository secret，
   分別新增 `TELEGRAM_BOT_TOKEN` 與 `TELEGRAM_CHAT_ID`。

**金鑰只放在 GitHub secret，不要寫進程式碼或 commit。** 程式從環境變數讀取，
不會出現在原始碼或執行紀錄裡。

先在本機預覽訊息長什麼樣（不需要金鑰、不會發送）：

```bash
python scripts/notify_telegram.py --dry-run
```

要調整推播哪幾種連續天數，改 `notify_telegram.py` 最上面的 `STREAK_GROUPS`。

## 手機使用

開 `https://<你的帳號>.github.io/StockTracker/`，用瀏覽器選單的
「加入主畫面」／「安裝應用程式」，就會有獨立圖示、且離線時仍可看最後一次載入的資料。

## 備註

- 目前只涵蓋上市（TWSE），尚未包含上櫃（TPEx）。
- 接下來想做什麼、以及各項目的優先級與規格，見 [ROADMAP.md](ROADMAP.md)。
- 資料僅供參考，非投資建議。
