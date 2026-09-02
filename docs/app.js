'use strict';

const DATA = 'data';
const TOP = 200;                       // 排行榜與進出榜的門檻
const KEPT = 300;                      // daily/*.json 每天留幾名（twse.py 的 TOP_N）
const CHART_CDN = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js';

// 圖表線色。Chart.js 吃不到 CSS 變數，只能寫死；深淺色模式都看得清楚的中間色調。
const LINE = { rank: '#2f6fed', market: '#2f6fed', top200: '#7b61ff', top10: '#d92d20' };

// K 線：台股習慣紅漲綠跌，與 style.css 的 --up／--down 同一個調子。
const CANDLE = { up: '#d92d20', down: '#0d9145' };

// 疊在 K 線上的均線。日數與「均線」分頁的 MA_WINDOWS 是同一套定義，
// 但這裡是拿 K 線檔自己的收盤價現算的，不是讀 daily 裡那份（那份只有前 200 名有）。
const KLINE_MAS = [
  { win: 5, color: '#f79009' },
  { win: 20, color: '#2f6fed' },
  { win: 60, color: '#7b61ff' },
];

// K 線要往前多抓幾個月當均線的暖身。60 日線約需三個月，湊不齊的那幾天就空著。
const KLINE_LEAD_MONTHS = 3;

// 這份 app.js 自己的版號，取自 index.html 的 <script src="app.js?v=N">。
// 「新資料配舊前端」的災情全靠這個數字才認得出來，所以錯誤訊息一定要帶上它。
const APP_VERSION = (() => {
  try {
    return new URL(document.currentScript.src).searchParams.get('v') || 'dev';
  } catch (err) {
    return 'dev';
  }
})();

const TAIPEI_OFFSET_MIN = 8 * 60;
// 最新資料距今超過這麼多個日曆日就提示。週五收盤後到週一盤中最多差 3 天，
// 取 4 是為了讓正常的週末不會誤報 —— 寧可晚一天提醒，也不要天天狼來了。
const STALE_DAYS = 4;

const SCOPES = [
  { value: 'all', label: '全部' },
  { value: 'twse', label: '上市' },
  { value: 'tpex', label: '上櫃' },
];
const SCOPE_KEY = 'stocktracker.scope';

const state = {
  index: null,
  scope: 'all',        // 排行範圍：all 全部／twse 上市／tpex 上櫃
  date: null,          // 目前選定的交易日
  baseline: 1,         // 比較基準：往前 N 個交易日
  span: 120,           // 個股走勢顯示的交易日數
  query: '',           // 排行榜搜尋字串
  industry: {},        // code -> 產業中文名（industry.json，抓不到時為空）
  themes: [],          // 題材族群（themes.json，抓不到時為空陣列）
  themesUpdated: '',   // themes.json 的維護日期，族群頁要標出來
  grouping: 'industry',// 族群頁的分類軸：industry 官方產業／theme 題材族群
  sectorSort: 'flow',  // 族群頁排序：flow 資金增減／shift 佔比位移／value 成交值
  sector: '',          // 排行榜的分類篩選；'' 代表全部
  sort: 'rank',        // 排行榜排序欄位
  floor: 0,            // 排行榜成交值門檻（億）
  watch: new Set(),    // 自選股代號
  streakDays: 3,       // 「站穩」分頁要看的連續進榜天數
  burstLots: 20000,    // 「爆量」分頁的成交量門檻（張）
  burstHigh: 60,       // 「爆量」分頁要求量創幾日新高
  burstRed: 'red',     // 「爆量」分頁要不要只看收紅：red 只看收紅／any 不限漲跌
  maWindow: 5,         // 「均線」分頁看哪一條線：5／10／20／60 日
  maDays: 3,           // 「均線」分頁的「近 N 個交易日內穿越」
  maSide: 'up',        // 「均線」分頁：up 剛站上／down 剛跌破
  maStack: 'any',      // 「均線」分頁的四線篩選：any 不限／up 四線全上／down 四線全下
  maZone: 'any',       // 「均線」分頁的 MACD 篩選：any 不限／up 柱在零軸上／down 柱在零軸下
  macdSide: 'up',      // 「MACD」分頁：up 黃金交叉／down 死亡交叉
  macdWhen: '3',       // 「MACD」分頁的時點：近 N 日已交叉，或 d1 明天／d2 後天
  macdStack: 'any',    // 「MACD」分頁的四線篩選：沿用均線頁的 any／up／down
  holderLots: 400,     // 「大戶」分頁的大戶門檻（張），HOLDER_LOTS 的 value
  holderSpan: 'q1',    // 「大戶」分頁拿哪一段當基準（HOLDER_SPANS 的 value）
  holders: null,       // Promise<holders/index.json>，進到大戶頁才載
  holderWeek: new Map(),// 集保資料日 -> Promise<holders/weekly/{日期}.json>
  holderStock: new Map(),// 代號 -> Promise<holders/stock/{代號}.json|null>
  quoteCat: 'all',     // 「報價」分頁的品類篩選；'all' 代表全部
  quoteSpan: 'm1',     // 「報價」分頁看哪一個期間的變化（QUOTE_SPANS 的 value）
  quoteChart: 365,     // 「報價」個別品項的圖表要顯示幾天；0 代表全部
  quotes: null,        // Promise<quotes/index.json>，進到報價頁才載
  quoteSeries: new Map(),// 品類 -> Promise<quotes/series/{cat}.json|null>
  daily: new Map(),    // date -> Promise<payload>
  history: new Map(),  // year -> Promise<payload>
  kline: new Map(),    // market/code/month -> Promise<payload|null>
  charts: [],
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v, digits = 1) =>
  v === null || v === undefined ? '—' : v.toLocaleString('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtValue = (yuan) => `${num(yuan / 1e8)} 億`;   // 資料庫存的是元
const fmtOku = (oku) => `${num(oku)} 億`;             // history 存的已是億元
const trend = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');

// --------------------------------------------------------------------------
// 快取救援
//
// data/index.json 一律 cache: 'reload' 抓最新的，外殼（app.js）卻可能被瀏覽器或
// Service Worker 留在舊版——舊 app.js 讀不懂新的 index.json，整頁就掛在「載入失敗」。
// index.html 的 ?v= 版號與 sw.js 的 no-cache 是預防；這裡是萬一還是撞上時的解法。
// --------------------------------------------------------------------------
const HEAL_KEY = 'stocktracker.healed';

/** 丟掉 Service Worker 與它的所有快取再重載。自選股在 localStorage，不動。 */
async function resetCaches() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (err) {
    /* 清不乾淨也還是要重載，至少會再跟伺服器要一次 */
  }
  location.reload();
}

/**
 * 自動修一次就好。修完還是壞的話一定是別的原因，再重載下去就是無限迴圈。
 * 無痕模式讀不到 sessionStorage，那就不自動重載，讓使用者自己按按鈕。
 */
function autoHealOnce() {
  try {
    if (sessionStorage.getItem(HEAL_KEY)) return false;
    sessionStorage.setItem(HEAL_KEY, APP_VERSION);
  } catch (err) {
    return false;
  }
  resetCaches();
  return true;
}

/** 壞掉時的畫面：講清楚發生什麼事，並給一個真的能自救的按鈕。 */
function failBox(message, detail = '') {
  return `<p class="hint">${esc(message)}</p>
    ${detail ? `<p class="hint">${esc(detail)}</p>` : ''}
    <p class="hint"><button class="pill" id="reset-cache">清除快取並重新載入</button></p>`;
}

// 委派在 document 上：連 index.json 都還沒讀到時也要能按
document.addEventListener('click', (e) => {
  if (e.target.closest('#reset-cache')) resetCaches();
});

// --------------------------------------------------------------------------
// 資料存取
// --------------------------------------------------------------------------
function getJSON(path, opts) {
  return fetch(path, opts).then((res) => {
    if (!res.ok) throw new Error(`${path} (${res.status})`);
    return res.json();
  });
}

function loadDaily(date, scope = state.scope) {
  if (!date) return Promise.resolve(null);
  const key = `${scope}/${date}`;
  if (!state.daily.has(key)) state.daily.set(key, getJSON(`${DATA}/daily/${scope}/${date}.json`));
  return state.daily.get(key);
}

function loadHistory(year, scope = state.scope) {
  const key = `${scope}/${year}`;
  if (!state.history.has(key)) {
    // 某個範圍不一定每一年都有資料（例如上櫃是後來才開始收的），當成空的即可，
    // 個股頁那幾年就只是沒有點而已，不該整頁掛掉。
    state.history.set(key, getJSON(`${DATA}/history/${scope}/${year}.json`)
      .catch(() => ({ dates: [], stocks: {} })));
  }
  return state.history.get(key);
}

/**
 * 個股 K 線：一檔一個月一個檔（見 twse.py 的 kline_path）。
 * 那個月沒有檔（個股還沒上市、停牌整個月、回補還沒補到）就當成 null，
 * 不是錯誤——K 線本來就只畫得出有資料的那幾天。
 */
function loadKlineMonth(market, code, month) {
  const key = `${market}/${code}/${month}`;
  if (!state.kline.has(key)) {
    state.kline.set(key, getJSON(`${DATA}/kline/${market}/${code}/${month}.json`).catch(() => null));
  }
  return state.kline.get(key);
}

/** '2026-03' ~ '2026-08' -> ['2026-03', …, '2026-08']；起點晚於終點時回空陣列。 */
function monthsInRange(from, to) {
  const out = [];
  let [year, month] = from.split('-').map(Number);
  const [endYear, endMonth] = to.split('-').map(Number);
  while (year < endYear || (year === endYear && month <= endMonth)) {
    out.push(`${year}-${String(month).padStart(2, '0')}`);
    if ((month += 1) > 12) { month = 1; year += 1; }
  }
  return out;
}

/** '2026-03' 往前 2 個月 -> '2026-01' */
function monthBack(month, back) {
  const [year, index] = month.split('-').map(Number);
  const total = year * 12 + (index - 1) - back;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** 這個市場的 K 線涵蓋範圍（index.json 由 build_history.py 寫入）。 */
const klineRange = (market) => (state.index.kline || {})[market] || null;

/** 把數個月檔攤平成一條依日期排序的 [{ date, o, h, l, c }]。 */
async function loadKline(market, code, fromMonth, toMonth) {
  const range = klineRange(market);
  if (!range) return [];
  const from = fromMonth < range.from.slice(0, 7) ? range.from.slice(0, 7) : fromMonth;
  const to = toMonth > range.to.slice(0, 7) ? range.to.slice(0, 7) : toMonth;
  const files = await Promise.all(monthsInRange(from, to).map((m) => loadKlineMonth(market, code, m)));

  const rows = [];
  for (const file of files) {
    if (!file) continue;
    for (let i = 0; i < file.d.length; i += 1) {
      const [o, h, l, c] = file.q[i];
      rows.push({ date: `${file.month}-${String(file.d[i]).padStart(2, '0')}`, o, h, l, c });
    }
  }
  return rows.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * K 線檔是依市場分的，但排行範圍可以是「全部」——那時只有當日在榜的個股帶得出
 * m 欄位。查不到就兩個市場都試一次，反正猜錯的那次就是一批 404，讀不到當沒有。
 */
async function loadKlineAuto(code, market, fromMonth, toMonth) {
  for (const m of market ? [market] : ['twse', 'tpex']) {
    const rows = await loadKline(m, code, fromMonth, toMonth);
    if (rows.length) return rows;
  }
  return [];
}

/** 目前範圍的每日成交值序列（index.json 裡三種範圍各存一份）*/
function scopeSeries() {
  const scopes = state.index.scopes || {};
  return scopes[state.scope] || null;
}

/** 該範圍在這一天有沒有資料。缺資料時序列裡是 null。 */
function hasScopeData(date) {
  const ser = scopeSeries();
  if (!ser) return false;
  const i = state.index.dates.indexOf(date);
  return i >= 0 && ser.marketValues[i] !== null;
}

const scopeLabel = () => (SCOPES.find((s) => s.value === state.scope) || SCOPES[0]).label;

/**
 * 以台北時區計算某個交易日距今幾個日曆日。
 * 資料是收盤資料，比到「日」就夠，不必管時分秒。
 */
function daysSinceTaipei(dateIso) {
  const now = new Date();
  const taipei = new Date(now.getTime() + (now.getTimezoneOffset() + TAIPEI_OFFSET_MIN) * 60000);
  const today = Date.UTC(taipei.getFullYear(), taipei.getMonth(), taipei.getDate());
  const [y, m, d] = dateIso.split('-').map(Number);
  return Math.round((today - Date.UTC(y, m - 1, d)) / 86400000);
}

/** 由目前日期往前推 n 個交易日，超出範圍回傳 null */
function dateBack(n, from = state.date) {
  const i = state.index.dates.indexOf(from);
  return i - n >= 0 ? state.index.dates[i - n] : null;
}

// --------------------------------------------------------------------------
// 自選股（只存在這台裝置的瀏覽器裡，不會上傳，也不會跟 Telegram 推播同步）
// --------------------------------------------------------------------------
const WATCH_KEY = 'stocktracker.watch';

function loadWatch() {
  try {
    const raw = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch (err) {
    return new Set();   // 無痕模式或被擋掉時就當作沒有自選
  }
}

function toggleWatch(code) {
  if (state.watch.has(code)) state.watch.delete(code);
  else state.watch.add(code);
  try {
    localStorage.setItem(WATCH_KEY, JSON.stringify([...state.watch]));
  } catch (err) {
    /* 存不進去也不影響這次瀏覽 */
  }
}

/**
 * 代號 -> 產業。industry.json 只涵蓋上市「公司」，所以要補三條規則。
 * 這幾條規則與 scripts/fetch_industry.py 的說明一致，改動時兩邊要一起看。
 */
const ETF_LABEL = 'ETF';
const OTHER_LABEL = '其他';

function industryOf(code) {
  const map = state.industry;
  if (map[code]) return map[code];
  if (code.startsWith('00')) return ETF_LABEL;             // ETF／ETN 不在公司清單裡
  const parent = code.replace(/[A-Z]+$/, '');              // 特別股沿用母公司的分類
  if (map[parent]) return map[parent];
  return OTHER_LABEL;
}

/** 把一份股票清單依官方產業彙總成 [{ name, count, value, codes }]，成交值由大到小。 */
function bySector(stocks) {
  const acc = new Map();
  for (const s of stocks) {
    const name = industryOf(s.code);
    const cur = acc.get(name) || { name, count: 0, value: 0, codes: [] };
    cur.count += 1;
    cur.value += s.value;
    cur.codes.push(s.code);
    acc.set(name, cur);
  }
  return [...acc.values()].sort((a, b) => b.value - a.value);
}

/**
 * 題材族群（themes.json）。與官方產業別並存而不是取代它：官方分類一檔只有一類、
 * 跟著證交所自動更新、永遠不會漏掉任何一檔；題材族群是人工維護的供應鏈視角，
 * 貼近盤面語言，但一檔可以同時屬於多個族群，也會有名單還沒補到的股票。
 */
const UNGROUPED_LABEL = '未分類';
const ETF_GROUP_LABEL = 'ETF · 指數商品';

const hasThemes = () => state.themes.length > 0;

/** 某個題材族群（或其中一個子族群）的成分代號。 */
function themeCodes(groupName, subName) {
  const group = state.themes.find((g) => g.name === groupName);
  if (!group) return new Set();
  const subs = subName ? group.subs.filter((s) => s.name === subName) : group.subs;
  return new Set(subs.flatMap((s) => s.codes));
}

/**
 * 依題材族群彙總成 [{ name, count, value, subs?, codes? }]，成交值由大到小。
 * 名單外的個股歸「未分類」並固定排在最後；ETF 依 industryOf() 自動成一族，
 * 這樣新掛牌的 ETF 不必手動補進 themes.json。
 */
function byTheme(stocks) {
  const pool = new Map(stocks.map((s) => [s.code, s]));
  const sum = (codes) => codes.reduce((n, c) => n + pool.get(c).value, 0);
  const taken = new Set();
  const groups = [];

  for (const group of state.themes) {
    const members = new Set();   // 同一檔同時列在兩個子族群時只算一次
    const subs = [];
    for (const sub of group.subs) {
      const codes = sub.codes.filter((c) => pool.has(c));
      if (!codes.length) continue;
      subs.push({ name: sub.name, codes, value: sum(codes) });
      codes.forEach((c) => { members.add(c); taken.add(c); });
    }
    if (!members.size) continue;
    groups.push({
      name: group.name,
      count: members.size,
      codes: [...members],      // 加權漲跌幅要用；同一檔列在兩個子族群時只算一次
      value: sum([...members]),
      subs: subs.sort((a, b) => b.value - a.value),
    });
  }

  const bucket = (name, list) => {
    if (!list.length) return;
    const codes = list.map((s) => s.code);
    groups.push({ name, count: codes.length, value: sum(codes), codes });
  };
  const left = stocks.filter((s) => !taken.has(s.code));
  bucket(ETF_GROUP_LABEL, left.filter((s) => industryOf(s.code) === ETF_LABEL));
  bucket(UNGROUPED_LABEL, left.filter((s) => industryOf(s.code) !== ETF_LABEL));

  return groups.sort((a, b) => {
    if (a.name === UNGROUPED_LABEL) return 1;      // 未分類是名單的缺口，不是族群
    if (b.name === UNGROUPED_LABEL) return -1;
    return b.value - a.value;
  });
}

function rankMap(payload) {
  const map = new Map();
  if (payload) for (const s of payload.stocks) map.set(s.code, s);
  return map;
}

// --------------------------------------------------------------------------
// 共用畫面元件
// --------------------------------------------------------------------------
function deltaBadge(cur, prev) {
  if (prev === undefined || prev === null) return '<span class="delta badge-new">NEW</span>';
  const d = prev - cur;
  if (d === 0) return '<span class="delta flat">—</span>';
  return `<span class="delta ${trend(d)}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>`;
}

/**
 * 連續進前 200 名的天數；若連到資料起點則以 + 表示實際可能更長。
 * withDate 為真時一併標出這段連續進榜是從哪一天開始的。
 */
function streakLabel(stock, withDate = false) {
  if (!stock || !stock.streak) return null;
  const truncated = stock.since === state.index.dates[0];
  const days = `連 ${stock.streak}${truncated ? '+' : ''} 天`;
  return withDate ? `${stock.since} 起 · ${days}` : days;
}

// 只有「全部」範圍的資料才帶 m 欄位，因為只有那時候才需要分辨是哪個市場
const MARKET_TAGS = { twse: '上市', tpex: '上櫃' };

const hasIndustry = () => Object.keys(state.industry).length > 0;

function stockRow(stock, base) {
  const prev = base ? base.rank : null;
  const pct = stock.changePct;
  const pctText = pct === null || pct === undefined ? '' : `<em class="${trend(pct)}">${pct > 0 ? '+' : ''}${pct.toFixed(2)}%</em>`;
  const streak = streakLabel(stock, true);
  return `<a class="row" href="#/stock/${stock.code}">
    <div class="rank"><span class="no">${stock.rank}</span>${deltaBadge(stock.rank, prev)}</div>
    <div class="ident"><span class="name">${state.watch.has(stock.code) ? '<span class="star">★</span>' : ''}${esc(stock.name)}</span>
      <span class="code">${stock.code}${stock.m ? ` · ${esc(MARKET_TAGS[stock.m])}` : ''}${hasIndustry() ? ` · ${esc(industryOf(stock.code))}` : ''}</span>
      ${streak ? `<span class="streak">${streak}</span>` : ''}</div>
    <div class="figures"><span class="value">${fmtValue(stock.value)}</span>
      <span class="price">${stock.close === null ? '' : num(stock.close, 2)} ${pctText}</span></div>
  </a>`;
}

function listCard(title, subtitle, rows, emptyText = '無') {
  return `<section class="card">
    <h2>${esc(title)} ${subtitle ? `<small>${esc(subtitle)}</small>` : ''}</h2>
    ${rows.length ? rows.join('') : `<p class="hint">${esc(emptyText)}</p>`}
  </section>`;
}

// --------------------------------------------------------------------------
// 一句話
//
// 這一頁只帶一句話走的話，該是哪一句。句子裡的每個數字都取自這一頁當下真正
// 算出來的東西，篩選條件換了句子就跟著換——寫死的結論換一天就會說謊。
//
// 卡片放在內容的最上面，當導讀用：先講結論，再讓圖表與清單去印證它。
// 四個分頁共用同一個外形：標題、一句話、四格重點數字、一段註解。只有一句話而沒有
// 數字的版本看起來就是一段孤零零的字；數字沒有句子又回到「自己去讀」——兩個要一起給。
//
// 只有四個分頁有：排行（合計與集中度不在畫面上）、大盤（今天對比期間平均）、
// 族群（改用佔比位移挑，跟預設排序看到的不同）、流向（把兩張抽象的圖翻成人話）。
// 其他分頁上面本來就有統計格、下面的清單也已經排好序，再寫一句只是把畫面唸一遍——
// 一半的一句話在複述，讀者就會學會跳過這張卡，連真的有話說的那幾張一起跳過。
// --------------------------------------------------------------------------
function takeaway(sentence, sub, stats = [], note = '') {
  const cells = stats
    .map((s) => `<div class="stat"><b class="${s.cls || ''}">${s.b}</b><span>${s.span}</span></div>`)
    .join('');
  return `<section class="card takeaway">
    <h2>一句話 ${sub ? `<small>${esc(sub)}</small>` : ''}</h2>
    <p class="lede">${sentence}</p>
    ${cells ? `<div class="stat-grid">${cells}</div>` : ''}
    ${note ? `<p class="note">${note}</p>` : ''}
  </section>`;
}

/** 統計格裡的「幾漲幾跌」這種一格塞兩個方向的數字 */
const pair = (a, b) => `<span class="up">${a}</span> / <span class="down">${b}</span>`;

/** 句子裡帶紅綠的數字：v 只決定顏色，text 才是要顯示的字 */
const tint = (v, text) => `<em class="${trend(v)}">${text}</em>`;

function pills(name, options, current) {
  return `<div class="pills">${options
    .map((o) => `<button class="pill ${o.value === current ? 'active' : ''}" data-${name}="${o.value}">${esc(o.label)}</button>`)
    .join('')}</div>`;
}

const SORTS = [
  { value: 'rank', label: '依名次' },
  { value: 'change', label: '依漲跌幅' },
  { value: 'delta', label: '依名次變化' },
];

const FLOORS = [
  { value: 0, label: '不限成交值' },
  { value: 50, label: '50 億以上' },
  { value: 100, label: '100 億以上' },
  { value: 200, label: '200 億以上' },
];

const BASELINES = [
  { value: 1, label: '對比前一日' },
  { value: 5, label: '對比 5 日前' },
  { value: 20, label: '對比 20 日前' },
];

const GROUPINGS = [
  { value: 'industry', label: '官方產業' },
  { value: 'theme', label: '題材族群' },
];
const GROUPING_KEY = 'stocktracker.grouping';

// --------------------------------------------------------------------------
// 分頁一：排行榜
// --------------------------------------------------------------------------
/**
 * 排行頁的一句話。跟著篩選條件走：沒篩就講整個榜的集中度，篩過就講這一批的合計
 * 與它在榜上的份量——「佔榜上幾 %」是篩完之後唯一還對照得回大盤的數字。
 */
function rankSay(picked, top, baseMap, baseDate) {
  if (!picked.length) {
    return takeaway('目前的條件在這一天沒有命中任何一檔，把成交值門檻、分類或關鍵字放寬看看。',
      '依目前的篩選條件');
  }
  const sum = (list) => list.reduce((n, s) => n + s.value, 0);
  const boardValue = sum(top);
  const pickValue = sum(picked);
  const biggest = picked.reduce((a, b) => (b.value > a.value ? b : a));
  const up = picked.filter((s) => s.changePct > 0).length;
  const down = picked.filter((s) => s.changePct < 0).length;
  const fresh = picked.filter((s) => !baseMap.has(s.code)).length;
  const whole = picked.length === top.length;
  const top10 = num((sum(top.filter((s) => s.rank <= 10)) / boardValue) * 100);
  const share = num((pickValue / boardValue) * 100);

  // 沒篩就講整個榜的集中度，篩過的第一件事是「這批有幾檔、佔榜上多少」
  const stats = whole
    ? [
      { b: okuText(pickValue), span: `前 ${TOP} 大成交值`, cls: 'sm' },
      { b: `${top10}%`, span: '前 10 大佔比', cls: 'sm' },
      { b: pair(up, down), span: '漲 / 跌', cls: 'sm' },
      { b: esc(biggest.name), span: `最大一檔 ${okuText(biggest.value)}`, cls: 'sm accent' },
    ]
    : [
      { b: `${picked.length} 檔`, span: '符合條件', cls: 'sm' },
      { b: okuText(pickValue), span: '合計成交值', cls: 'sm' },
      { b: `${share}%`, span: `佔前 ${TOP} 大`, cls: 'sm' },
      { b: pair(up, down), span: '漲 / 跌', cls: 'sm' },
    ];

  return takeaway(
    `${whole ? `${state.date} 榜上前 ${TOP} 大` : `這批 ${picked.length} 檔`}成交值合計
     <b>${okuText(pickValue)}</b>，${whole ? `其中前 10 大就吃掉 ${top10}%`
      : `佔榜上前 ${TOP} 大的 ${share}%`}，最大的一檔是
     <a class="accent" href="#/stock/${biggest.code}"><b>${esc(biggest.name)}</b>
      ${biggest.code}（${okuText(biggest.value)}）</a>；
     這批裡 ${tint(1, `${up} 檔收漲`)}、${tint(-1, `${down} 檔收跌`)}${baseDate && fresh
      ? `，其中 ${fresh} 檔是對比 ${baseDate} 的新進榜` : ''}。`,
    whole ? `${state.date} 全榜` : '依目前的篩選條件',
    stats,
    `合計與佔比算的都是畫面上這一批，改篩選條件會跟著重算。
     成交值是買賣雙邊的總量、本身沒有方向，紅綠講的是收盤漲跌。`);
}

async function renderRank(view) {
  const baseDate = dateBack(state.baseline);
  const [today, base] = await Promise.all([loadDaily(state.date), loadDaily(baseDate)]);
  const baseMap = rankMap(base);
  const top = today.stocks.filter((s) => s.rank <= TOP);

  // 產業選單只列當日榜上有的產業，選了不存在的產業會看到空清單沒有意義
  const sectors = hasIndustry() ? bySector(top).map((g) => g.name) : [];
  const opt = (value, label, current) =>
    `<option value="${esc(value)}" ${String(value) === String(current) ? 'selected' : ''}>${esc(label)}</option>`;

  // 題材族群同樣只列當日榜上有成分股的，大族群與子族群都能選
  const themePicks = hasThemes()
    ? byTheme(top).filter((g) => g.subs).flatMap((g) => [
      { value: `T:${g.name}`, label: g.name },
      ...(g.subs.length > 1
        ? g.subs.map((sub) => ({ value: `T:${g.name}/${sub.name}`, label: `　${sub.name}` }))
        : []),
    ])
    : [];

  const pickSelect = `<select id="sector-pick" aria-label="篩選">
      ${opt('', '全部', state.sector)}
      ${state.watch.size ? opt('!WATCH', `★ 只看自選（${state.watch.size}）`, state.sector) : ''}
      ${hasIndustry() ? opt('!ETF', '排除 ETF', state.sector) : ''}
      ${sectors.length ? `<optgroup label="官方產業">${sectors.map((n) => opt(n, n, state.sector)).join('')}</optgroup>` : ''}
      ${themePicks.length ? `<optgroup label="題材族群">${themePicks.map((o) => opt(o.value, o.label, state.sector)).join('')}</optgroup>` : ''}
    </select>`;

  const sortSelect = `<select id="sort-pick" aria-label="排序">
      ${SORTS.map((o) => opt(o.value, o.label, state.sort)).join('')}
    </select>`;

  const floorSelect = `<select id="floor-pick" aria-label="成交值門檻">
      ${FLOORS.map((o) => opt(o.value, o.label, state.floor)).join('')}
    </select>`;

  view.innerHTML = `
    <div class="controls">
      <input type="search" id="q" placeholder="搜尋代號或名稱" value="${esc(state.query)}">
      ${pickSelect}${sortSelect}${floorSelect}
      ${pills('baseline', BASELINES, state.baseline)}
    </div>
    <div id="rank-say"></div>
    <section class="card">
      <h2>成交值前 ${TOP} 大 <small>${baseDate ? `名次變化 vs ${baseDate}` : '無比較基準'}</small></h2>
      <div id="rank-list"></div>
    </section>`;

  const pickFilter = () => {
    const sel = state.sector;
    if (!sel) return () => true;
    if (sel === '!WATCH') return (s) => state.watch.has(s.code);
    if (sel === '!ETF') return (s) => industryOf(s.code) !== ETF_LABEL;
    if (sel.startsWith('T:')) {
      const [name, sub] = sel.slice(2).split('/');
      const codes = themeCodes(name, sub);
      return (s) => codes.has(s.code);
    }
    return (s) => industryOf(s.code) === sel;
  };

  // 排序用的鍵值一律「越大越前面」，沒有值的排到最後
  const sortKey = (s) => {
    if (state.sort === 'change') return s.changePct ?? -Infinity;
    if (state.sort === 'delta') {
      const base = baseMap.get(s.code);
      return base ? base.rank - s.rank : -Infinity;   // 新進榜沒有前次名次可比
    }
    return -s.rank;
  };

  const paint = () => {
    const q = state.query.trim().toLowerCase();
    const match = pickFilter();
    // 一句話講的是「畫面上這一批」，所以要留下篩過的股票本身，不能只留下畫好的列
    const picked = top
      .filter(match)
      .filter((s) => s.value >= state.floor * 1e8)
      .filter((s) => !q || s.code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
      .sort((a, b) => sortKey(b) - sortKey(a));
    const rows = picked.map((s) => stockRow(s, baseMap.get(s.code)));

    const watchNote = state.sector === '!WATCH'
      ? `<p class="note">自選清單：<code id="watch-codes">${[...state.watch].sort().join(',')}</code>
          <button class="linky" id="copy-watch">複製</button><br>
          自選股只存在這台裝置的瀏覽器。要讓 Telegram 也只推這幾檔，把上面這串設成 <code>WATCHLIST</code> secret。</p>`
      : '';
    $('#rank-list').innerHTML =
      (rows.length ? rows.join('') : '<p class="hint">找不到符合的股票</p>') + watchNote;
    $('#rank-say').innerHTML = rankSay(picked, top, baseMap, baseDate);

    const copy = $('#copy-watch');
    if (copy) {
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText($('#watch-codes').textContent);
          copy.textContent = '已複製';
        } catch (err) {
          copy.textContent = '請手動選取複製';
        }
      });
    }
  };
  paint();

  $('#q').addEventListener('input', (e) => {
    state.query = e.target.value;
    paint();
  });

  $('#sector-pick').addEventListener('change', (e) => {
    state.sector = e.target.value;
    paint();
  });
  $('#sort-pick').addEventListener('change', (e) => {
    state.sort = e.target.value;
    paint();
  });
  $('#floor-pick').addEventListener('change', (e) => {
    state.floor = Number(e.target.value);
    paint();
  });
}

// --------------------------------------------------------------------------
// 分頁二：站穩（新進榜之後連續留在榜上的股票）
// --------------------------------------------------------------------------
const STREAK_TARGETS = [
  { value: 2, label: '2 天' },
  { value: 3, label: '3 天' },
  { value: 5, label: '5 天' },
  { value: 10, label: '10 天' },
];

async function renderStreak(view) {
  const [today, base] = await Promise.all([loadDaily(state.date), loadDaily(dateBack(1))]);
  const baseMap = rankMap(base);
  const n = state.streakDays;

  const onBoard = today.stocks.filter((s) => s.streak);
  const rookies = onBoard.filter((s) => s.streak === 1);
  // 剛滿 N 天：N 個交易日前新進榜，之後每個交易日都還在榜上
  const justHit = onBoard.filter((s) => s.streak === n).sort((a, b) => a.rank - b.rank);
  // 連續 N 天以上，天數短的排前面 —— 越前面代表越新的面孔
  const sustained = onBoard
    .filter((s) => s.streak >= n)
    .sort((a, b) => a.streak - b.streak || a.rank - b.rank);

  const rows = (list) => list.map((s) => stockRow(s, baseMap.get(s.code)));

  view.innerHTML = `
    <div class="controls">${pills('streak', STREAK_TARGETS, n)}</div>
    <div class="card"><div class="stat-grid">
      <div class="stat"><b class="up">${justHit.length}</b><span>剛滿 ${n} 天</span></div>
      <div class="stat"><b>${rookies.length}</b><span>今日新進榜</span></div>
      <div class="stat"><b>${sustained.length}</b><span>連 ${n} 天以上</span></div>
    </div></div>
    ${listCard(`剛滿 ${n} 天`, `${n} 個交易日前進榜，之後每天都站穩`, rows(justHit),
      `${state.date} 沒有剛好連續進榜 ${n} 天的股票`)}
    ${listCard(`連續 ${n} 天以上`, '天數由短到長，越前面是越新的面孔', rows(sustained))}`;
}

// --------------------------------------------------------------------------
// 分頁三：異動（進榜／掉榜／名次升降）
// --------------------------------------------------------------------------
function diffDays(current, base, topN = TOP) {
  const cur = current.stocks.filter((s) => s.rank <= topN);
  const bas = base.stocks.filter((s) => s.rank <= topN);
  const curMap = new Map(cur.map((s) => [s.code, s]));
  const basMap = new Map(bas.map((s) => [s.code, s]));

  const moved = cur
    .filter((s) => basMap.has(s.code))
    .map((s) => ({ ...s, prev: basMap.get(s.code).rank, delta: basMap.get(s.code).rank - s.rank }));

  return {
    entered: cur.filter((s) => !basMap.has(s.code)),
    left: bas.filter((s) => !curMap.has(s.code)),
    up: moved.filter((s) => s.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 20),
    down: moved.filter((s) => s.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 20),
    basMap,
  };
}

function diffSections(current, base, labelA, labelB) {
  const d = diffDays(current, base);
  const rows = (list) => list.map((s) => stockRow(s, d.basMap.get(s.code)));
  const leftRows = d.left.map(
    (s) => `<a class="row" href="#/stock/${s.code}">
      <div class="rank"><span class="no">${s.rank}</span><span class="delta down">OUT</span></div>
      <div class="ident"><span class="name">${esc(s.name)}</span><span class="code">${s.code}</span></div>
      <div class="figures"><span class="value">${fmtValue(s.value)}</span><span class="price">${esc(labelA)} 名次</span></div>
    </a>`
  );

  return `
    <div class="card"><div class="stat-grid">
      <div class="stat"><b class="up">${d.entered.length}</b><span>新進榜</span></div>
      <div class="stat"><b class="down">${d.left.length}</b><span>掉出榜</span></div>
      <div class="stat"><b>${TOP - d.entered.length}</b><span>續留</span></div>
    </div></div>
    ${listCard(`新進榜（${labelB}）`, `${labelA} 未在前 ${TOP}`, rows(d.entered))}
    ${listCard(`掉出榜（${labelA}）`, `${labelB} 已不在前 ${TOP}`, leftRows)}
    ${listCard('名次進步最多', 'Top 20', rows(d.up))}
    ${listCard('名次退步最多', 'Top 20', rows(d.down))}`;
}

async function renderMoves(view) {
  const baseDate = dateBack(state.baseline);
  if (!baseDate) {
    view.innerHTML = '<p class="hint">資料不足，無法比較。請選較晚的日期或先回補歷史。</p>';
    return;
  }
  const [today, base] = await Promise.all([loadDaily(state.date), loadDaily(baseDate)]);
  view.innerHTML = `<div class="controls">${pills('baseline', BASELINES, state.baseline)}</div>
    ${diffSections(today, base, baseDate, state.date)}`;
}

// --------------------------------------------------------------------------
// 分頁：爆量（量放大、量創新高、而且收紅的股票）
//
// 三個條件是「同時成立」：成交量夠大（絕對量）、量創 N 日新高（相對自己的過去）、
// 收盤價高於開盤價（當天這根 K 是紅的）。前兩個講的是量，第三個講的是那些量
// 有沒有把價格推上去——只看量會把爆量下殺的出貨也算進來。
// --------------------------------------------------------------------------
const BURST_LOTS = [
  { value: 5000, label: '5 千張' },
  { value: 10000, label: '1 萬張' },
  { value: 20000, label: '2 萬張' },
  { value: 50000, label: '5 萬張' },
];

const BURST_HIGHS = [
  { value: 20, label: '20 日新高' },
  { value: 60, label: '60 日新高' },
  { value: 120, label: '120 日新高' },
];

const BURST_REDS = [
  { value: 'red', label: '只看收紅' },
  { value: 'any', label: '不限漲跌' },
];

// build_history.py 的 VOL_HIGH_MAX：再往前算對「爆量」已經沒有分辨力
const VOL_HIGH_MAX = 250;

/** 成交量新高天數。build_history.py 省略了 1（連昨天都沒超過），讀不到就是 1。 */
const volHigh = (stock) => stock.vh || 1;

const volHighLabel = (n) => `創 ${n >= VOL_HIGH_MAX ? `${VOL_HIGH_MAX}+` : n} 日新高`;

/** 成交量從股數換成張，取整數——零股湊出來的個位數在這裡沒有意義 */
const lots = (volume) => Math.round(volume / 1000);

function burstRow(stock, base) {
  const pct = stock.changePct;
  const pctText = pct === null || pct === undefined ? '' : `<em class="${trend(pct)}">${pct > 0 ? '+' : ''}${pct.toFixed(2)}%</em>`;
  const price = stock.open === null || stock.open === undefined
    ? `${stock.close === null ? '' : num(stock.close, 2)} ${pctText}`
    : `開 ${num(stock.open, 2)} → 收 ${num(stock.close, 2)} ${pctText}`;
  return `<a class="row" href="#/stock/${stock.code}">
    <div class="rank"><span class="no">${stock.rank}</span>${deltaBadge(stock.rank, base ? base.rank : null)}</div>
    <div class="ident"><span class="name">${state.watch.has(stock.code) ? '<span class="star">★</span>' : ''}${esc(stock.name)}</span>
      <span class="code">${stock.code}${stock.m ? ` · ${esc(MARKET_TAGS[stock.m])}` : ''}${hasIndustry() ? ` · ${esc(industryOf(stock.code))}` : ''}</span>
      <span class="streak">${volHighLabel(volHigh(stock))}</span></div>
    <div class="figures"><span class="value">${num(lots(stock.volume), 0)} 張</span>
      <span class="price">${price}</span></div>
  </a>`;
}

async function renderBurst(view) {
  const [today, base] = await Promise.all([loadDaily(state.date), loadDaily(dateBack(1))]);
  const baseMap = rankMap(base);
  const minLots = state.burstLots;
  const minHigh = state.burstHigh;

  // 開盤價是後來才加的欄位，加欄位之前抓的日子沒有——那些日子分不出紅黑，
  // 收紅這個選項就不該出現在畫面上，免得看起來有篩其實沒篩。
  const hasOpen = today.stocks.some((s) => s.open !== null && s.open !== undefined);
  const onlyRed = hasOpen && state.burstRed === 'red';
  const isRed = (s) => s.open !== null && s.open !== undefined && s.close !== null && s.close > s.open;

  const big = today.stocks.filter((s) => lots(s.volume) > minLots);
  const fresh = big.filter((s) => volHigh(s) >= minHigh);
  const red = hasOpen ? fresh.filter(isRed) : [];
  const hits = (onlyRed ? red : fresh).slice().sort((a, b) => b.volume - a.volume);

  const conditions = `成交量 > ${num(minLots, 0)} 張 · 量創 ${minHigh} 日新高${onlyRed ? ' · 收盤價 > 開盤價' : ''}`;

  view.innerHTML = `
    <div class="controls">${pills('burstlots', BURST_LOTS, minLots)}${pills('bursthigh', BURST_HIGHS, minHigh)}
      ${hasOpen ? pills('burstred', BURST_REDS, state.burstRed) : ''}</div>
    ${hasOpen ? '' : `<p class="hint">${state.date} 的資料沒有開盤價（這個欄位是後來才加的），
      分不出收紅收黑，所以這一天只能篩「量夠大」與「量創新高」兩個條件。
      要補齊請執行 <code>python scripts/backfill.py --from ${state.date} --to ${state.date} --force</code>，
      再跑一次 <code>python scripts/build_history.py</code>。</p>`}
    <div class="card"><div class="stat-grid">
      <div class="stat"><b class="up">${hits.length}</b><span>符合條件</span></div>
      <div class="stat"><b>${big.length}</b><span>量 &gt; ${num(minLots, 0)} 張</span></div>
      <div class="stat"><b>${fresh.length}</b><span>其中創 ${minHigh} 日新高</span></div>
      <div class="stat"><b class="${onlyRed ? 'up' : ''}">${hasOpen ? red.length : '—'}</b>
        <span>其中收紅${hasOpen && !onlyRed ? '（未篩）' : ''}</span></div>
    </div></div>
    ${listCard(`${state.date} ${onlyRed ? '爆量收紅' : '爆量'}`, `${conditions}　依成交量排序`,
      hits.map((s) => burstRow(s, baseMap.get(s.code))),
      `${state.date} 沒有符合這${onlyRed ? '三' : '兩'}個條件的股票，把門檻放寬看看`)}
    <section class="card">
      <h2>這些條件在看什麼</h2>
      <p class="note">「量 &gt; ${num(minLots, 0)} 張」是絕對量的門檻，濾掉小型股平常的碎量；
        「創 ${minHigh} 日新高」是拿它跟自己的過去比，同一檔股票天天都有量不算，要比前 ${minHigh} 個交易日都大才算。
        這兩個講的都是量。</p>
      <p class="note">「收盤價 &gt; 開盤價」則是另一件事：要求這些量有把價格推上去。
        量價四象限那張圖裡的右下角（爆量下殺）量也很大，但那是出貨不是進場。
        ${onlyRed
          ? `現在是<b>只看收紅</b>，這 ${fresh.length - red.length} 檔收黑的爆量股沒有列出來——
             切到「不限漲跌」就看得到，量一樣大、方向相反。`
          : `現在是<b>不限漲跌</b>，收紅與收黑的爆量股都在名單上${hasOpen ? `（其中 ${red.length} 檔收紅）` : ''}。
             切到「只看收紅」可以把爆量下殺的那一群濾掉。`}</p>
      <p class="note">⚠ 量的歷史只看得到「當天成交值前 ${KEPT} 名」的資料，沒進榜的日子一律當成量比今天小。
        對突然爆量的股票這個假設是對的（它先前連成交值前 ${KEPT} 名都排不上），
        但低價高量股平常就算量大也排不進成交值前 ${KEPT} 名，新高天數會被高估。
        新高天數最多算到 ${VOL_HIGH_MAX} 天，顯示成 ${VOL_HIGH_MAX}+ 的實際可能更長。</p>
      <p class="note">名次與 NEW／▲▼ 是成交值在${esc(scopeLabel())}裡的排名與對比前一交易日的變化，
        跟這些條件無關，只是拿來對照這檔在榜上的位置。這是條件篩選的結果，不是買賣訊號。</p>
    </section>`;
}
// --------------------------------------------------------------------------
// 分頁：均線（剛站上／剛跌破 5／10／20／60 日線）
// --------------------------------------------------------------------------
// daily 檔裡 ma／mav 兩個陣列的順序，與 build_history.py 的 MA_WINDOWS 一致
const MA_WINDOWS = [5, 10, 20, 60];
const MA_STREAK_MAX = 60;              // build_history.py 的同名常數：天數最多算到這裡
// 「近 N 個交易日內剛穿越」；0 是特例，代表不看天數、現在在那一側就算
const MA_LOOKBACKS = [1, 3, 5, 10, 0];

const MA_SIDES = [
  { value: 'up', label: '剛站上' },
  { value: 'down', label: '剛跌破' },
];

// 四條線的位置：不限／四條都收在線上／四條都收在線下
const MA_STACKS = [
  { value: 'any', label: '不限' },
  { value: 'up', label: '四線全上' },
  { value: 'down', label: '四線全下' },
];

function maAt(stock, key, win) {
  const arr = stock[key];
  const i = MA_WINDOWS.indexOf(win);
  if (!arr || i < 0 || arr[i] === undefined || arr[i] === null) return null;
  return arr[i];
}

/** 已連續站上（正）或跌破（負）幾個交易日；null 代表收盤價不連續、算不出來 */
const maRun = (stock, win) => maAt(stock, 'ma', win);
const maPrice = (stock, win) => maAt(stock, 'mav', win);

/**
 * 收在這條線之上（true）／之下（false）；null 代表這條線算不出來。
 *
 * 位置只要有均線價就判斷得出來，比「連續幾天」寬鬆——天數在資料剛好夠算均線、
 * 卻不夠往回數的日子會是 null，位置那時候仍然是確定的。
 */
function maAbove(stock, win) {
  const line = maPrice(stock, win);
  if (line === null || stock.close === null || stock.close === undefined) return null;
  return stock.close > line;
}

/** 四條線是不是全都收在同一側（dir：up 全上／down 全下）；有一條算不出來就不算 */
const maStacked = (stock, dir) => MA_WINDOWS.every((w) => maAbove(stock, w) === (dir === 'up'));

/** 這一檔是不是在近 days 個交易日內剛穿越；days 為 0 代表不限天數，只看現在在哪一側 */
function maHit(stock, win, side, days) {
  if (!days) {
    const above = maAbove(stock, win);
    return above === null ? false : above === (side === 'up');
  }
  const run = maRun(stock, win);
  if (run === null) return false;
  return side === 'up' ? run >= 1 && run <= days : run <= -1 && run >= -days;
}

// 線別已經寫在卡片標題與右側，這裡只講「第幾天」，長度才塞得進一行
function maRunLabel(run) {
  if (run === null) return '資料不足';
  const days = Math.abs(run);
  const verb = run > 0 ? '站上' : '跌破';
  if (days === 1) return `今天剛${verb}`;
  return `${verb}第 ${days >= MA_STREAK_MAX ? `${MA_STREAK_MAX}+` : days} 天`;
}

/** 四條線的一覽：▲ 收在線上、▼ 收在線下、· 資料不足 */
const maChips = (stock) =>
  MA_WINDOWS.map((w) => {
    const above = maAbove(stock, w);
    const mark = above === null ? '·' : above ? '▲' : '▼';
    return `<span class="ma-chip ${above === null ? 'flat' : above ? 'up' : 'down'}">${w}${mark}</span>`;
  }).join('');

function maRow(stock, base, win) {
  const pct = stock.changePct;
  const pctText = pct === null || pct === undefined ? '' : `<em class="${trend(pct)}">${pct > 0 ? '+' : ''}${pct.toFixed(2)}%</em>`;
  const line = maPrice(stock, win);
  const bias = line ? (stock.close / line - 1) * 100 : null;
  return `<a class="row" href="#/stock/${stock.code}">
    <div class="rank"><span class="no">${stock.rank}</span>${deltaBadge(stock.rank, base ? base.rank : null)}</div>
    <div class="ident"><span class="name">${state.watch.has(stock.code) ? '<span class="star">★</span>' : ''}${esc(stock.name)}</span>
      <span class="code">${stock.code}${stock.m ? ` · ${esc(MARKET_TAGS[stock.m])}` : ''}${hasIndustry() ? ` · ${esc(industryOf(stock.code))}` : ''}</span>
      <span class="streak">${maRunLabel(maRun(stock, win))}</span>
      <span class="ma-chips">${maChips(stock)}${macdChip(stock)}</span></div>
    <div class="figures"><span class="value">${num(stock.close, 2)} ${pctText}</span>
      <span class="price">${win} 日線 ${num(line, 2)}${bias === null ? '' : ` · 乖離 <em class="${trend(bias)}">${signed(bias)}</em>`}</span></div>
  </a>`;
}

/**
 * 四條線 ×「近 1／3／5／10 日」的檔數矩陣，每一格都是可以按的選擇鈕。
 * 一眼看得出「今天是誰在穿越」——某一格特別多，那條線就是今天的分水嶺。
 */
function maMatrix(pool, side) {
  const verb = side === 'up' ? '站上' : '跌破';
  const head = MA_LOOKBACKS.map((d) => `<div class="head">${maSpanLabel(d)}</div>`).join('');
  const body = MA_WINDOWS.map((w) => {
    const cells = MA_LOOKBACKS.map((d) => {
      const on = w === state.maWindow && d === state.maDays;
      const count = pool.filter((s) => maHit(s, w, side, d)).length;
      return `<button class="pill cell ${on ? 'active' : ''}" data-maline="${w}" data-madays="${d}"
        aria-label="${maSpanLabel(d)}${verb} ${w} 日線">${count}</button>`;
    }).join('');
    return `<div class="rowlab">${w} 日線</div>${cells}`;
  }).join('');
  return `<div class="matrix"><div class="rowlab"></div>${head}${body}</div>`;
}

/** 矩陣欄名：0 是「不限天數、現在就在那一側」 */
const maSpanLabel = (days) => (days ? `近 ${days} 日` : '不限');

/** 同一件事寫成句子時的說法：「近 3 日站上」／「目前站上」 */
const maSpanText = (days) => (days ? `近 ${days} 日` : '目前');

async function renderMa(view) {
  const [today, base] = await Promise.all([loadDaily(state.date), loadDaily(dateBack(1))]);
  const baseMap = rankMap(base);
  const win = state.maWindow;
  const days = state.maDays;
  const side = state.maSide;
  const stack = state.maStack;
  const zone = state.maZone;
  const verb = side === 'up' ? '站上' : '跌破';
  const span = maSpanText(days);

  const board = today.stocks.filter((s) => s.rank <= TOP);
  const above = board.filter((s) => maAbove(s, win) === true).length;
  const below = board.filter((s) => maAbove(s, win) === false).length;
  const unknown = board.length - above - below;
  const allUp = board.filter((s) => maStacked(s, 'up')).length;
  const zoneUp = board.filter((s) => macdZoned(s, 'up')).length;
  // 柱正、DIF 卻還是負的——用來說明「柱的零軸」與「DIF 的零軸」是兩回事
  const zoneSplit = board.filter((s) => {
    const m = macdOf(s);
    return m ? macdAbove(m) && macdDif(m) < 0 : false;
  }).length;

  // 這一天完全沒有均線資料：多半是收盤價還沒回補到這麼早，講清楚怎麼補
  if (above + below === 0) {
    view.innerHTML = `<p class="hint">${state.date} 沒有均線資料。</p>
      <section class="card"><h2>要怎麼補</h2>
        <p class="note">均線要連續的收盤價才算得準，用的是 <code>docs/data/close/</code> 底下的全市場收盤價
          （排行用的 <code>daily/</code> 只留前 ${KEPT} 名，中間掉出榜的日子是空的，湊不出連續的價）。
          這份檔案是後來才加的，先前回補過的日子只有排行、沒有收盤價。</p>
        <p class="note">補這一天要連同它之前的 ${Math.max(...MA_WINDOWS) + Math.max(...MA_LOOKBACKS)} 個交易日一起補，
          60 日線才算得出來：<code>python scripts/backfill.py --to ${state.date} --days 170</code>，
          再跑一次 <code>python scripts/build_history.py</code>。</p>
      </section>`;
    return;
  }

  // 四線與 MACD 兩個篩選先套在池子上，矩陣的每一格與下面的清單都只算這個池子裡的
  const pool = board
    .filter((s) => stack === 'any' || maStacked(s, stack))
    .filter((s) => zone === 'any' || macdZoned(s, zone));
  const picked = [
    stack === 'any' ? '' : stack === 'up' ? '四線全上' : '四線全下',
    zone === 'any' ? '' : zone === 'up' ? '已黃金交叉' : '已死亡交叉',
  ].filter(Boolean);
  const pickedText = picked.length ? `　${picked.join('、')}` : '';
  const hits = pool
    .filter((s) => maHit(s, win, side, days))
    .sort((a, b) => Math.abs(maRun(a, win) || MA_STREAK_MAX + 1) - Math.abs(maRun(b, win) || MA_STREAK_MAX + 1)
      || a.rank - b.rank);

  view.innerHTML = `
    <div class="controls">${pills('maside', MA_SIDES, side)}${pills('mastack', MA_STACKS, stack)}</div>
    <div class="controls">${pills('mazone', MACD_ZONES, zone)}</div>
    <section class="card">
      <h2>${side === 'up' ? '剛站上' : '剛跌破'}${pickedText}
        <small>幾檔在近 N 個交易日內穿越，按數字換清單</small></h2>
      <div class="matrix-box">${maMatrix(pool, side)}</div>
    </section>
    <div class="card"><div class="stat-grid">
      <div class="stat"><b class="${side === 'up' ? 'up' : 'down'}">${hits.length}</b>
        <span>${span}${verb} ${win} 日線</span></div>
      <div class="stat"><b class="up">${above}</b><span>收在 ${win} 日線上</span></div>
      <div class="stat"><b class="down">${below}</b><span>收在 ${win} 日線下</span></div>
      <div class="stat"><b class="up">${allUp}</b><span>四線全上</span></div>
      <div class="stat"><b class="up">${zoneUp}</b><span>已黃金交叉</span></div>
      <div class="stat"><b>${unknown}</b><span>${win} 日線資料不足</span></div>
    </div></div>
    ${listCard(`${state.date} ${span}${verb} ${win} 日線${pickedText}`,
      `榜上前 ${TOP} 名　${days ? '穿越越新的排越前面' : '天數短的排前面'}`,
      hits.map((s) => maRow(s, baseMap.get(s.code), win)),
      `${state.date} 榜上沒有${picked.length ? `${picked.join('、')}、而且` : ''}${span}${verb} ${win} 日線的股票，把天數或線別換一個看看`)}
    <section class="card">
      <h2>這一頁在看什麼</h2>
      <p class="note">均線是收盤價的算術平均：${win} 日線就是含今天在內最近 ${win} 個交易日的收盤均價。
        「站上」是收盤價高於均線，「跌破」是收盤價不高於均線（剛好相等算在跌破那一側）。
        「近 N 日」數的是連續站上／跌破的天數：1 是今天剛穿越，3 是今天為穿越後的第 3 天——
        中間只要收回線的另一側，天數就重新起算。最後一欄的「不限」不看天數，是現在就收在那一側的全部。</p>
      <p class="note">每一列的 ${MA_WINDOWS.join('／')} 標記是這四條線各自的位置（▲ 收在線上、▼ 收在線下、· 資料不足），
        上面那排「四線全上／全下」就是拿這四個標記在篩：四個都 ▲ 代表短中長期的均線全在腳下，今天有 ${allUp} 檔。
        四條線裡只要有一條算不出來就不算數。乖離是收盤價離這條均線幾 %。</p>
      <p class="note">列尾的 MACD 標記與上面那排「已黃金交叉／已死亡交叉」，是把 MACD 頁的判斷借過來當第二個篩子。
        看的是柱（DIF − DEA）在零軸的哪一側：柱是正的代表 DIF 還在 DEA 之上，也就是<b>還停在黃金交叉後的那一側</b>，
        今天榜上有 ${zoneUp} 檔。「已」字是在說這是狀態不是事件——交叉可能是今天，也可能是二十天前；
        要找剛發生的那幾檔請到 MACD 頁按「近 N 日」。</p>
      <p class="note">⚠ 這裡的零軸是<b>柱</b>的零軸，不是 DIF 的零軸。兩者常被混為一談：
        柱翻正只代表短期動能追過了自己的均值，DIF 仍可能是負的（12 日 EMA 還壓在 26 日 EMA 底下、中期還沒翻多）。
        這兩件事在同一天各走各的很常見——今天榜上就有 ${zoneSplit} 檔是柱正、DIF 負。</p>
      <p class="note">兩個篩子是<b>疊加</b>的，矩陣裡的每一格也跟著只算篩過的池子——
        「近 3 日剛站上 20 日線」再加「已黃金交叉」，就是價格剛翻上均線、動能也還在交叉後那一側的那一群。
        條件疊起來命中數掉得很快，列出 0 檔多半是篩太緊，不是今天沒有訊號。</p>
      <p class="note">MACD 要 60 個連續交易日才算得出來，比 60 日線還嚴一點；算不出來的標成 · ，
        一旦選了「已黃金交叉／已死亡交叉」就會被篩掉——這一頁本來看得到的檔，套上 MACD 篩選後會少一批。</p>
      <p class="note">均線要連續的收盤價才算得準，所以這一頁吃的是 <code>docs/data/close/</code> 的全市場收盤價，
        不是排行的前 ${KEPT} 名。中間停牌、剛上市、或收盤價還沒回補到那麼早的，一律標成「資料不足」而不硬算——
        今天榜上的 ${win} 日線有 ${unknown} 檔是這種情況。</p>
      <p class="note">⚠ 收盤價沒有還原權值。除權息當天價格會跳空往下、均線卻還帶著除息前的價位，
        那一天的「跌破」可能只是除息造成的。</p>
      <p class="note">名次與 NEW／▲▼ 是成交值在${esc(scopeLabel())}裡的排名與對比前一交易日的變化，跟均線無關。
        這是條件篩選的結果，不是買賣訊號。</p>
    </section>`;
}

// --------------------------------------------------------------------------
// 分頁：MACD（黃金交叉／死亡交叉，以及明後天要收在多少才會交叉）
// --------------------------------------------------------------------------
// 平滑係數，與 build_history.py 的 MACD_FAST／MACD_SLOW／MACD_SIGNAL 一致
const MACD_A_FAST = 2 / (12 + 1);
const MACD_A_SLOW = 2 / (26 + 1);
const MACD_A_SIGNAL = 2 / (9 + 1);

// 台股單日漲跌幅上限。明天再怎麼走也只能走這麼多，要價超過這個幅度才交叉的就不必列
const PRICE_LIMIT = 10;

const MACD_SIDES = [
  { value: 'up', label: '黃金交叉' },
  { value: 'down', label: '死亡交叉' },
];

// 時點：數字是「已經交叉，且在近 N 個交易日內」，d1／d2 是還沒交叉的明天與後天
const MACD_WHENS = [
  { value: '1', label: '近 1 日' },
  { value: '3', label: '近 3 日' },
  { value: '5', label: '近 5 日' },
  { value: '10', label: '近 10 日' },
  { value: 'd1', label: '明天' },
  { value: 'd2', label: '後天' },
];

/** 柱狀值不是百分比，signed() 會多一個 % —— 這裡自己帶正負號 */
const macdNum = (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`;

function macdOf(stock) {
  const m = stock.macd;
  if (!m) return null;
  return { fast: m[0], slow: m[1], dea: m[2], run: m[3] === undefined ? null : m[3] };
}

const macdDif = (m) => m.fast - m.slow;
const macdHist = (m) => macdDif(m) - m.dea;
/** 柱在零軸上＝DIF 在 DEA 之上；等於零算在下面那一側，與均線的處理一致 */
const macdAbove = (m) => macdHist(m) > 0;

// 柱在零軸的哪一側——給均線頁當交叉篩選用的，和均線頁的 MA_STACKS 是對稱的一對：
// 兩邊都是拿對方的「現在站在哪一側」當篩子，不再多帶一套天數進來。
//
// 標籤寫「已黃金交叉」而不是「柱在零軸上」：MACD 圖上有兩條線都能叫零軸，
// 柱的零軸（DIF 在不在 DEA 之上）和 DIF 自己的零軸（12 日 EMA 在不在 26 日 EMA 之上）
// 是兩回事，榜上經常有幾十檔柱是正的、DIF 卻還是負的。這裡篩的一直是前者，
// 也就是「還在交叉後的那一側」——「已」字是在說這是狀態，不是今天剛發生的事件。
const MACD_ZONES = [
  { value: 'any', label: '不限' },
  { value: 'up', label: '已黃金交叉' },
  { value: 'down', label: '已死亡交叉' },
];

/** 柱在指定那一側（dir：up 零軸上／down 零軸下）；沒有 MACD 就不算數 */
function macdZoned(stock, dir) {
  const m = macdOf(stock);
  return m ? macdAbove(m) === (dir === 'up') : false;
}

/** 給均線頁的一枚 chip，語彙跟四線標記一致：▲ 柱在零軸上、▼ 在零軸下、· 資料不足 */
function macdChip(stock) {
  const m = macdOf(stock);
  const cls = !m ? 'flat' : macdAbove(m) ? 'up' : 'down';
  const mark = !m ? '·' : macdAbove(m) ? '▲' : '▼';
  return `<span class="ma-chip ${cls}">MACD${mark}</span>`;
}

/** 把 MACD 往後推一天，假設那天收在 price */
function macdAdvance(m, price) {
  const fast = m.fast + MACD_A_FAST * (price - m.fast);
  const slow = m.slow + MACD_A_SLOW * (price - m.slow);
  return { fast, slow, dea: m.dea + MACD_A_SIGNAL * (fast - slow - m.dea) };
}

/**
 * 下一個交易日收在多少，DIF 會剛好等於 DEA——也就是交叉的臨界價。
 *
 * 這不是預測，是解一條一元一次方程式：三條 EMA 都是「舊值 × 常數 ＋ 新收盤價 × 常數」，
 * 所以 DIF − DEA 對明天的收盤價是線性的，臨界價直接寫得出來。
 */
function macdCrossPrice(m) {
  const carried = (1 - MACD_A_FAST) * m.fast - (1 - MACD_A_SLOW) * m.slow;
  return (m.dea - carried) / (MACD_A_FAST - MACD_A_SLOW);
}

/**
 * 還沒交叉的股票，第 step 個交易日（1 明天、2 後天）要收在多少才會交叉。
 * 後天那一版把明天當成平盤，不然兩個未知數解不出一個答案。
 * 回傳 null 代表：沒有 MACD、今天已經在那一側了，或要價超過漲跌停。
 */
function macdOutlook(stock, side, step) {
  const m = macdOf(stock);
  if (!m || stock.close === null || stock.close === undefined) return null;
  const want = side === 'up';
  if (macdAbove(m) === want) return null;              // 今天就已經在那一側

  let cur = m;
  if (step === 2) {
    cur = macdAdvance(m, stock.close);
    if (macdAbove(cur) === want) return null;          // 明天平盤就會交叉，那是「明天」的事
  }
  const target = macdCrossPrice(cur);
  const need = (target / stock.close - 1) * 100;
  if (want ? need > PRICE_LIMIT : need < -PRICE_LIMIT) return null;
  return { target, need };
}

/** 已經交叉，而且是在近 days 個交易日內 */
function macdCrossed(stock, side, days) {
  const m = macdOf(stock);
  if (!m || m.run === null) return false;
  return side === 'up' ? m.run >= 1 && m.run <= days : m.run <= -1 && m.run >= -days;
}

/** 某個時點的選股結果，清單與 pill 上的檔數都用它 */
function macdPick(pool, side, when) {
  if (when === 'd1' || when === 'd2') {
    const step = when === 'd1' ? 1 : 2;
    return pool
      .map((s) => ({ stock: s, outlook: macdOutlook(s, side, step) }))
      .filter((x) => x.outlook)
      // 要走的幅度越小越前面：黃金交叉是越小越容易，死亡交叉則是越接近 0 越容易
      .sort((a, b) => (side === 'up' ? a.outlook.need - b.outlook.need : b.outlook.need - a.outlook.need))
      .map((x) => ({ ...x.stock, outlook: x.outlook }));
  }
  const days = Number(when);
  return pool
    .filter((s) => macdCrossed(s, side, days))
    .sort((a, b) => Math.abs(macdOf(a).run) - Math.abs(macdOf(b).run) || a.rank - b.rank);
}

function macdStateLabel(stock, side) {
  const m = macdOf(stock);
  if (!m) return '資料不足';
  if (stock.outlook) return `尚未交叉 · 柱 ${macdNum(macdHist(m))}`;
  if (m.run === null) return `柱 ${macdNum(macdHist(m))} · 天數不足`;
  const days = Math.abs(m.run);
  const name = m.run > 0 ? '黃金交叉' : '死亡交叉';
  if (days === 1) return `今天剛${name}`;
  return `${name}第 ${days >= MA_STREAK_MAX ? `${MA_STREAK_MAX}+` : days} 天`;
}

function macdRow(stock, base, side, when) {
  const m = macdOf(stock);
  const pct = stock.changePct;
  const pctText = pct === null || pct === undefined ? '' : `<em class="${trend(pct)}">${pct > 0 ? '+' : ''}${pct.toFixed(2)}%</em>`;
  const detail = stock.outlook
    ? `${when === 'd1' ? '明天' : '後天'}收${side === 'up' ? ' ≥ ' : ' ≤ '}${num(stock.outlook.target, 2)}
       · <em class="${trend(stock.outlook.need)}">${signed(stock.outlook.need)}</em>`
    : `DIF ${num(macdDif(m), 2)} · DEA ${num(m.dea, 2)}`;
  return `<a class="row" href="#/stock/${stock.code}">
    <div class="rank"><span class="no">${stock.rank}</span>${deltaBadge(stock.rank, base ? base.rank : null)}</div>
    <div class="ident"><span class="name">${state.watch.has(stock.code) ? '<span class="star">★</span>' : ''}${esc(stock.name)}</span>
      <span class="code">${stock.code}${stock.m ? ` · ${esc(MARKET_TAGS[stock.m])}` : ''}${hasIndustry() ? ` · ${esc(industryOf(stock.code))}` : ''}</span>
      <span class="streak">${macdStateLabel(stock, side)}</span>
      <span class="ma-chips">${maChips(stock)}</span></div>
    <div class="figures"><span class="value">${num(stock.close, 2)} ${pctText}</span>
      <span class="price">${detail}</span></div>
  </a>`;
}

async function renderMacd(view) {
  const [today, base] = await Promise.all([loadDaily(state.date), loadDaily(dateBack(1))]);
  const baseMap = rankMap(base);
  const side = state.macdSide;
  const when = state.macdWhen;
  const stack = state.macdStack;
  const name = side === 'up' ? '黃金交叉' : '死亡交叉';

  const board = today.stocks.filter((s) => s.rank <= TOP);
  const withMacd = board.filter((s) => macdOf(s));
  const above = withMacd.filter((s) => macdAbove(macdOf(s))).length;
  const allUp = withMacd.filter((s) => maStacked(s, 'up')).length;

  if (!withMacd.length) {
    view.innerHTML = `<p class="hint">${state.date} 沒有 MACD 資料。</p>
      <section class="card"><h2>要怎麼補</h2>
        <p class="note">MACD 是三條 EMA 疊出來的，EMA 沒有真正的起點，得從連續的收盤價一路遞推。
          連續資料少於 60 個交易日就不出數字，寧可空著也不給一個還帶著起點味道的值。</p>
        <p class="note">補收盤價：<code>python scripts/backfill.py --to ${state.date} --days 170</code>，
          再跑一次 <code>python scripts/build_history.py</code>。要看更早的日期就把天數再加大。</p>
      </section>`;
    return;
  }

  const pool = stack === 'any' ? withMacd : withMacd.filter((s) => maStacked(s, stack));
  const stackText = stack === 'any' ? '' : `　${stack === 'up' ? '四線全上' : '四線全下'}`;
  const whens = MACD_WHENS.map((w) => ({
    ...w,
    label: `${w.label} ${macdPick(pool, side, w.value).length}`,
  }));
  const hits = macdPick(pool, side, when);
  const forecast = when === 'd1' || when === 'd2';
  const title = forecast
    ? `${when === 'd1' ? '明天' : '後天'}可能${name}`
    : `近 ${when} 日${name}`;

  view.innerHTML = `
    <div class="controls">${pills('macdside', MACD_SIDES, side)}${pills('macdstack', MA_STACKS, stack)}</div>
    <div class="controls">${pills('macdwhen', whens, when)}</div>
    <div class="card"><div class="stat-grid">
      <div class="stat"><b class="${side === 'up' ? 'up' : 'down'}">${hits.length}</b><span>${title}</span></div>
      <div class="stat"><b class="up">${above}</b><span>柱在零軸上</span></div>
      <div class="stat"><b class="down">${withMacd.length - above}</b><span>柱在零軸下</span></div>
      <div class="stat"><b class="up">${allUp}</b><span>四線全上</span></div>
      <div class="stat"><b>${board.length - withMacd.length}</b><span>資料不足</span></div>
    </div></div>
    ${listCard(`${state.date} ${title}${stackText}`,
      forecast
        ? `榜上前 ${TOP} 名　${when === 'd2' ? '明天以平盤計　' : ''}要走的幅度小的排前面`
        : `榜上前 ${TOP} 名　交叉越新的排越前面`,
      hits.map((s) => macdRow(s, baseMap.get(s.code), side, when)),
      forecast
        ? `${state.date} 榜上沒有一檔${stackText ? `${stackText.trim()}、` : ''}在漲跌停範圍內${when === 'd1' ? '明天' : '後天'}就會${name}的`
        : `${state.date} 榜上沒有${stackText ? `${stackText.trim()}、而且` : ''}近 ${when} 日${name}的股票，把天數放寬看看`)}
    <section class="card">
      <h2>這一頁在看什麼</h2>
      <p class="note">DIF 是 12 日與 26 日 EMA 的差，DEA 是 DIF 的 9 日 EMA，柱狀圖是 DIF − DEA。
        柱由負轉正就是黃金交叉、由正轉負就是死亡交叉；柱剛好為 0 算在死亡交叉那一側。
        「近 N 日」與均線頁同一套算法：1 是今天剛交叉，3 是交叉後的第 3 天。</p>
      <p class="note"><b>「明天」「後天」不是預測，是解方程式。</b>三條 EMA 都是「舊值 × 常數 ＋ 新收盤價 × 常數」，
        所以「明天的柱要等於 0」是一條一元一次方程式，臨界價直接算得出來——清單上的
        「明天收 ≥ 某價」就是那個解，右邊的百分比是它離今天收盤價多遠。
        負的代表<b>連平盤或下跌都會交叉</b>，那是最接近成真的一群。</p>
      <p class="note">後天那一版多了一個假設：<b>明天以平盤計</b>。兩天有兩個未知數，不假設一個就解不出來。
        兩邊都只列漲跌停 ±${PRICE_LIMIT}% 走得到的，走不到的當作明天不可能發生。
        ETF 與部分商品沒有 ${PRICE_LIMIT}% 的限制，這個門檻對它們是保守了一點。</p>
      <p class="note">MACD 是三條 EMA 疊出來的，EMA 沒有真正的起點，要連續的收盤價跑夠久才穩，
        所以連續資料少於 60 個交易日的不出數字——今天榜上有 ${board.length - withMacd.length} 檔是這種情況。
        ⚠ 收盤價沒有還原權值，除權息當天的跳空會直接反映在 EMA 上。</p>
      <p class="note">每一列的 ${MA_WINDOWS.join('／')} 標記是四條均線的位置（▲ 收在線上、▼ 收在線下、· 資料不足），
        上面那排「四線全上／全下」就是拿這四個標記在篩，篩完連時點那排的計數也一起跟著縮：
        「近 3 日黃金交叉」再加「四線全上」，就是動能剛翻正、價格也已經站上短中長期均線的那一群，
        今天榜上四線全上的有 ${allUp} 檔。四條線裡只要有一條算不出來就不算數，條件疊起來命中數會掉得很快。</p>
        名次與 NEW／▲▼ 是成交值在${esc(scopeLabel())}裡的排名與對比前一交易日的變化。
        這是條件篩選與算術的結果，不是買賣訊號。</p>
    </section>`;
}

// --------------------------------------------------------------------------
// 分頁三：個股排名走勢
// --------------------------------------------------------------------------
async function seriesFor(code) {
  const years = [...state.index.years].sort();
  const byDate = new Map();
  let name = code;
  for (const year of years) {
    const hist = await loadHistory(year);
    const entry = hist.stocks[code];
    if (!entry) continue;
    name = entry.name;
    for (const [i, rank, value] of entry.p) byDate.set(hist.dates[i], { rank, value });
  }
  return { name, byDate };
}

/**
 * 全期間進榜紀錄。兩個容易踩到的地方：
 *   1. byDate 含 rank 201–300 的日子（daily 存 300 名是為了判斷進出榜），
 *      所以「有沒有進榜」要看 rank <= TOP，不能只看那天有沒有值。
 *   2. 連續性要用 index.dates 的索引判斷，不能拿日曆日相減（週末與休市日會斷）。
 */
function lifetimeStats(byDate) {
  const dates = state.index.dates;
  const runs = [];               // 每一段連續進榜：{ from, to, days }
  let open = null;               // 尚未結束的那一段
  let totalDays = 0;
  let best = null;               // { rank, date }，含 201–300 名的日子

  for (const date of dates) {
    const hit = byDate.get(date);
    if (hit && (best === null || hit.rank < best.rank)) best = { rank: hit.rank, date };

    if (hit && hit.rank <= TOP) {
      totalDays += 1;
      if (open) {
        open.days += 1;
        open.to = date;
      } else {
        open = { from: date, to: date, days: 1 };
        runs.push(open);
      }
    } else {
      open = null;
    }
  }

  const closed = runs.filter((r) => r !== open);
  const longest = runs.reduce((a, b) => (b.days > (a ? a.days : 0) ? b : a), null);
  const lastExit = closed.length
    ? dates[dates.indexOf(closed[closed.length - 1].to) + 1] ?? null
    : null;

  return {
    totalDays,
    spells: runs.length,
    best,
    longest,
    lastExit,
    // 第一段若一路連到資料起點，真正的天數可能更長
    truncated: longest !== null && longest.from === dates[0],
  };
}

function loadChartJs() {
  if (!loadChartJs.promise) {
    loadChartJs.promise = new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = CHART_CDN;
      tag.onload = () => resolve(window.Chart);
      tag.onerror = () => reject(new Error('圖表元件載入失敗（離線時無法繪圖）'));
      document.head.appendChild(tag);
    });
  }
  return loadChartJs.promise;
}

function destroyCharts() {
  state.charts.forEach((c) => c.destroy());
  state.charts = [];
}

/**
 * series：[{ data, color, label }]，單線就給一個元素（單線才填色，多線只畫線）。
 * suffix 會接在 tooltip 數值後面（例如 ' %'）；資料為 null 代表當日沒有值。
 */
function drawLine(Chart, canvas, labels, series, { reverse = false, suffix = '', emptyText = '未進榜' } = {}) {
  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: series.map((s) => ({
        label: s.label,
        data: s.data,
        borderColor: s.color,
        backgroundColor: `${s.color}22`,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.2,
        spanGaps: false,
        fill: series.length === 1,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: series.length > 1, labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: (c) => {
              const v = c.parsed.y;
              return `${c.dataset.label}：${v === null || v === undefined ? emptyText : v + suffix}`;
            },
          },
        },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 5, font: { size: 10 } }, grid: { display: false } },
        y: { reverse, ticks: { font: { size: 10 } }, grid: { color: 'rgba(128,128,128,.18)' } },
      },
    },
  });
  state.charts.push(chart);
}

/** 簡單移動平均；湊不滿 win 天的位置留 null，不用手上有幾天就除幾天。 */
function movingAverage(closes, win) {
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i += 1) {
    sum += closes[i];
    if (i >= win) sum -= closes[i - win];
    if (i >= win - 1) out[i] = sum / win;
  }
  return out;
}

/**
 * 把 K 線檔補成一定畫得出來的四價。
 *
 * 開高低是後來才收的（見 twse.py 的 write_closes），在那之前抓的日子只有收盤價。
 * 缺開盤就沿用前一天的收盤（等於當成平盤開出），缺高低就取開收的極值——
 * 畫出來是一根沒有影線的實體，不會假造出當天其實沒有的振幅。
 */
function fillCandles(rows) {
  let prevClose = null;
  return rows.map((r) => {
    const open = r.o ?? prevClose ?? r.c;
    const high = r.h ?? Math.max(open, r.c);
    const low = r.l ?? Math.min(open, r.c);
    prevClose = r.c;
    return { date: r.date, o: open, h: high, l: low, c: r.c, bare: r.h === null || r.l === null };
  });
}

/**
 * 日 K 線。Chart.js 沒有 K 線圖型，用兩組「浮動長條」疊出來：
 * 細的畫 [最低, 最高] 是影線，粗的畫 [開盤, 收盤] 是實體，
 * 兩組共用同一個 x 分類，寬度差就是影線與實體的差別。
 *
 * 十字線（開盤等於收盤）的實體高度是 0，長條會整根不見，
 * 所以補一個隨價格區間縮放的最小厚度，讓它至少還是一條看得見的橫線。
 */
function drawCandles(Chart, canvas, series, offset = 0) {
  // 均線要用完整序列（含 offset 之前那段暖身）才算得準，算完再切掉暖身段
  const warmed = series.map((r) => r.c);
  const mas = KLINE_MAS.map((ma) => movingAverage(warmed, ma.win).slice(offset));
  const candles = series.slice(offset);
  const labels = candles.map((r) => r.date);
  const highest = Math.max(...candles.map((r) => r.h));
  const lowest = Math.min(...candles.map((r) => r.l));
  const doji = Math.max((highest - lowest) / 400, 0.001);   // 十字線的最小實體厚度
  const colors = candles.map((r) => (r.c >= r.o ? CANDLE.up : CANDLE.down));

  const bar = (data, width, order) => ({
    type: 'bar',
    data,
    backgroundColor: colors,
    borderWidth: 0,
    barPercentage: width,
    categoryPercentage: 1,
    order,
  });

  const chart = new Chart(canvas, {
    data: {
      labels,
      datasets: [
        bar(candles.map((r) => [r.l, r.h]), 0.16, 3),
        bar(candles.map((r) => (Math.abs(r.c - r.o) < doji
          ? [r.o - doji / 2, r.o + doji / 2]
          : [r.o, r.c])), 0.68, 2),
        ...KLINE_MAS.map((ma, i) => ({
          type: 'line',
          label: `${ma.win} 日`,
          data: mas[i],
          borderColor: ma.color,
          borderWidth: 1.2,
          pointRadius: 0,
          spanGaps: false,
          order: 1,
        })),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        // 前兩筆是影線與實體，圖例只留均線
        legend: { labels: { boxWidth: 12, font: { size: 11 }, filter: (i) => i.datasetIndex >= 2 } },
        tooltip: {
          // 第 0 筆是影線（數字與實體重複），暖身不足還沒有值的均線也不必列
          filter: (item) => item.datasetIndex !== 0
            && !(item.datasetIndex >= 2 && item.parsed.y === null),
          callbacks: {
            label: (c) => {
              if (c.datasetIndex >= 2) return `${c.dataset.label}：${num(c.parsed.y, 2)}`;
              const r = candles[c.dataIndex];
              const chg = r.o ? ((r.c - r.o) / r.o) * 100 : null;
              return [
                `開 ${num(r.o, 2)}　收 ${num(r.c, 2)}`,
                r.bare ? '高低價：無資料' : `高 ${num(r.h, 2)}　低 ${num(r.l, 2)}`,
                chg === null ? '' : `開收 ${chg > 0 ? '+' : ''}${chg.toFixed(2)}%`,
              ].filter(Boolean);
            },
          },
        },
      },
      scales: {
        x: { stacked: false, ticks: { maxTicksLimit: 5, font: { size: 10 } }, grid: { display: false } },
        // 長條圖預設從 0 起算，股價圖那樣畫等於整張圖擠成一條線
        y: { beginAtZero: false, grace: '4%', ticks: { font: { size: 10 } },
             grid: { color: 'rgba(128,128,128,.18)' } },
      },
    },
  });
  state.charts.push(chart);
}

async function renderStockPicker(view) {
  const today = await loadDaily(state.date);
  view.innerHTML = `<div class="controls"><input type="search" id="q2" placeholder="輸入代號或名稱，例如 2330 / 台積電"></div>
    <section class="card"><h2>選擇個股 <small>${state.date} 前 ${TOP} 名</small></h2><div id="pick"></div></section>`;
  const top = today.stocks.filter((s) => s.rank <= TOP);
  const paint = (q = '') => {
    const key = q.trim().toLowerCase();
    $('#pick').innerHTML = top
      .filter((s) => !key || s.code.toLowerCase().includes(key) || s.name.toLowerCase().includes(key))
      .slice(0, 60)
      .map((s) => stockRow(s, null))
      .join('') || '<p class="hint">找不到符合的股票</p>';
  };
  paint();
  $('#q2').addEventListener('input', (e) => paint(e.target.value));
}

async function renderStock(view, code) {
  if (!code) return renderStockPicker(view);

  const [{ name, byDate }, todayPayload] = await Promise.all([seriesFor(code), loadDaily(state.date)]);
  if (!byDate.size) {
    view.innerHTML = `<p class="hint">${esc(code)} 在目前的歷史資料中沒有進過前 300 名。</p>`;
    return;
  }

  const upTo = state.index.dates.indexOf(state.date) + 1;
  const labels = state.index.dates.slice(Math.max(0, upTo - state.span), upTo);
  const ranks = labels.map((d) => (byDate.has(d) ? byDate.get(d).rank : null));
  const values = labels.map((d) => (byDate.has(d) ? byDate.get(d).value : null));

  const appeared = ranks.filter((r) => r !== null);
  const inTop = appeared.filter((r) => r <= TOP).length;
  const best = appeared.length ? Math.min(...appeared) : null;
  const latest = byDate.get(state.date);
  const todayEntry = todayPayload.stocks.find((s) => s.code === code);
  const streak = streakLabel(todayEntry);
  const lt = lifetimeStats(byDate);
  const allDays = state.index.dates.length;

  // K 線：多抓幾個月當均線暖身，畫的時候再切回 labels 這一段
  const market = state.scope === 'all' ? todayEntry?.m ?? null : state.scope;
  const series = fillCandles(await loadKlineAuto(
    code, market, monthBack(labels[0].slice(0, 7), KLINE_LEAD_MONTHS), state.date.slice(0, 7),
  )).filter((r) => r.date <= state.date);
  const klineFrom = series.findIndex((r) => r.date >= labels[0]);
  const drawn = klineFrom < 0 ? 0 : series.length - klineFrom;
  const klineStart = Object.values(state.index.kline || {}).map((r) => r.from).sort()[0];

  const watched = state.watch.has(code);
  view.innerHTML = `
    <div class="controls">
      ${pills('span', SPANS, state.span)}
      <button class="pill ${watched ? 'active' : ''}" data-watch="${code}">${watched ? '★ 已加入自選' : '☆ 加入自選'}</button>
    </div>
    <section class="card">
      <h2>${esc(name)} <small>${code} · 近 ${labels.length} 個交易日</small></h2>
      <div class="stat-grid">
        <div class="stat"><b>${latest ? latest.rank : '—'}</b><span>${state.date} 名次</span></div>
        <div class="stat"><b>${latest ? fmtOku(latest.value) : '—'}</b><span>成交值</span></div>
        <div class="stat"><b>${best ?? '—'}</b><span>區間最佳名次</span></div>
        <div class="stat"><b>${inTop}/${labels.length}</b><span>區間進榜天數</span></div>
        <div class="stat"><b>${streak ?? '—'}</b><span>連續進前 ${TOP}</span></div>
        <div class="stat"><b class="sm">${todayEntry?.since ?? '—'}</b><span>連續起算日</span></div>
      </div>
      ${todayEntry && todayEntry.since === state.index.dates[0]
        ? `<p class="note">這段連續進榜從本站最早一天（${state.index.dates[0]}）就開始了，實際天數可能更長。</p>`
        : ''}
    </section>
    <section class="card">
      <h2>全期間紀錄 <small>${state.index.dates[0]} 起 ${allDays} 個交易日</small></h2>
      <div class="stat-grid">
        <div class="stat"><b>${lt.totalDays}</b><span>進前 ${TOP} 天數</span></div>
        <div class="stat"><b>${num((lt.totalDays / allDays) * 100, 0)}%</b><span>佔全部交易日</span></div>
        <div class="stat"><b>${lt.spells || '—'}</b><span>進榜波段</span></div>
        <div class="stat"><b>${lt.best ? lt.best.rank : '—'}</b><span>歷史最佳名次</span></div>
        <div class="stat"><b>${lt.longest ? `${lt.longest.days}${lt.truncated ? '+' : ''}` : '—'}</b><span>最長連續天數</span></div>
        <div class="stat"><b class="sm">${lt.lastExit ?? '—'}</b><span>上次掉出榜</span></div>
      </div>
      <p class="note">
        ${lt.best ? `最佳名次出現在 ${lt.best.date}。` : ''}
        ${lt.longest ? `最長連續進榜 ${lt.longest.from} ~ ${lt.longest.to}。` : '本站資料期間內沒有進過前 200 名。'}
        ${lt.truncated ? '這段一路連到本站最早一天，實際天數可能更長。' : ''}
        ${lt.lastExit ? '' : lt.spells ? '從未掉出過前 200 名。' : ''}
      </p>
    </section>
    <section class="card">
      <h2>日 K 線 <small>${drawn ? `近 ${drawn} 個交易日` : '無資料'}</small></h2>
      ${drawn
        ? `<div class="chart-box tall"><canvas id="c-kline"></canvas></div>
           <p class="note">紅漲綠跌，實體是開盤到收盤、影線是當日最高最低。
           三條均線由這張圖自己的收盤價現算，湊不滿天數的那幾天就不畫。
           價格沒有還原權值，除權息當天的跳空是真的跳空，不是資料錯。</p>`
        : `<p class="hint">這一段期間沒有四價資料。K 線的資料${klineStart ? `自 ${klineStart} 起` : '尚未產生'}，
           較早的日子只有成交值排行。</p>`}
    </section>
    <section class="card">
      <h2>成交值排名走勢 <small>斷線＝當日未進前 300</small></h2>
      <div class="chart-box"><canvas id="c-rank"></canvas></div>
    </section>
    <section class="card">
      <h2>成交值走勢 <small>億元</small></h2>
      <div class="chart-box"><canvas id="c-value"></canvas></div>
    </section>
    <p class="hint"><a class="linky" href="#/holders/${code}">看這一檔的大股東持股趨勢 →</a></p>`;

  try {
    const Chart = await loadChartJs();
    if (drawn) drawCandles(Chart, $('#c-kline'), series, klineFrom);
    drawLine(Chart, $('#c-rank'), labels, [{ data: ranks, color: LINE.rank, label: '名次' }], { reverse: true });
    drawLine(Chart, $('#c-value'), labels, [{ data: values, color: LINE.top10, label: '成交值(億)' }]);
  } catch (err) {
    document.querySelectorAll('.chart-box').forEach((box) => {
      box.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
    });
  }
}

// --------------------------------------------------------------------------
// 分頁：大戶（集保股權分散）
//
// 集保結算所每週五結算一次，把每一檔的股東依持股張數分級。這一頁只問一件事：
// 這一段時間，籌碼是往大戶那邊集中，還是散到散戶手上。
//
// 「大戶」從幾張算起是可以選的。市場上 400 張與 1,000 張兩種說法都有人用，
// 而且看的東西不一樣：400 張以上含了不少中實戶，1,000 張以上幾乎只剩法人與公司派。
// 官方那張表的級距就是 100／200／400／600／800／1,000 張，門檻只能從這裡挑 ——
// 中間的數字（比如 500 張）官方沒有分，硬給只會是假的精確。
//
// 兩件事一定要先講清楚，不然這一頁很容易被讀成「主力在買」：
//   1. 集保分的是「帳戶」不是實質股東。外資的持股掛在保管銀行底下，一家保管銀行
//      就是一個千張大戶；公司派、董監與庫藏股同樣落在大戶級距。台積電的千張大戶
//      常年在八成以上，那是外資與國發基金，不是有人在偷偷吃貨。
//   2. 這是一週一次的存量快照，不是買賣紀錄。看得出集中度往哪邊移動，
//      看不出是誰買的、什麼價位買的。
// --------------------------------------------------------------------------
const HOLDER_SPANS = [
  { value: 'w1', label: '較前一週', days: 7, min: 4, max: 21 },
  { value: 'm1', label: '近一月', days: 30, min: 15, max: 60 },
  { value: 'q1', label: '近一季', days: 90, min: 45, max: 200 },
  { value: 'y1', label: '近一年', days: 365, min: 200, max: 600 },
];

// 快照裡每一檔的 17 個數字，順序即 scripts/holders.py 的 FIELDS，兩邊必須一致：
// cum1..cum15 是「第 N 級（含）以上佔集保庫存數的比例」，再加股東人數與庫存張數。
const H_CUM = 0;         // cum1 的位置；第 N 級以上就在 H_CUM + N - 1
const H_HEADS = 15;      // p10 的位置；第 N 級以上的戶數就在 H_HEADS + N - HEADS_BASE
const HEADS_BASE = 10;   // 只有大戶那六層（第 10~15 級）留了戶數
const H_PEOPLE = 21;     // 股東人數（集保帳戶數，十五級合計）
const H_LOTS = 22;       // 集保庫存張數

// 大戶門檻。官方的級距就這個解析度，選單只能從這些張數裡挑。
const HOLDER_LOTS = [
  { value: 100, label: '100 張' },
  { value: 200, label: '200 張' },
  { value: 400, label: '400 張' },
  { value: 600, label: '600 張' },
  { value: 800, label: '800 張' },
  { value: 1000, label: '1000 張' },
];
// 張數 -> 級距編號，與 scripts/holders.py 的 LEVEL_OF_LOTS 是同一套定義
const LOT_LEVEL = { 100: 10, 200: 11, 400: 12, 600: 13, 800: 14, 1000: 15 };
const SMALL_LEVEL = 10;        // 散戶＝不到 100 張，也就是 cum1 減 cum10
const TOP_LEVEL = 15;          // 千張大戶
const HOLDER_LOTS_KEY = 'stocktracker.holderlots';

const HOLDER_TOP = 20;         // 每張榜取前幾名
const HOLDER_ROWS = 26;        // 個股頁的逐週明細最多列幾個資料日（約半年的週資料）
const HOLDER_MOVE_MIN = 0.01;  // 小於這個 pp 的變化只是四捨五入的雜訊，不算加碼或減碼

// 三條比例線與一條人數線。與 K 線那組均線的顏色分開，免得看起來像同一種東西。
const HLINE = { big: '#d92d20', top: '#7b61ff', small: '#0d9145', people: '#2f6fed' };

function loadHolderIndex() {
  // 集保一週才動一次，與交易日無關，所以目錄一律抓最新的；
  // 每週快照與個股序列都是「同一個網址內容不再變」的檔案，照常吃快取。
  if (!state.holders) state.holders = getJSON(`${DATA}/holders/index.json`, { cache: 'reload' });
  return state.holders;
}

function loadHolderWeek(date) {
  if (!state.holderWeek.has(date)) {
    state.holderWeek.set(date, getJSON(`${DATA}/holders/weekly/${date}.json`));
  }
  return state.holderWeek.get(date);
}

function loadHolderStock(code) {
  if (!state.holderStock.has(code)) {
    state.holderStock.set(code, getJSON(`${DATA}/holders/stock/${code}.json`).catch(() => null));
  }
  return state.holderStock.get(code);
}

const daysBetween = (from, to) => Math.round((new Date(to) - new Date(from)) / 86400000);

const holderSpanSpec = () => HOLDER_SPANS.find((s) => s.value === state.holderSpan) || HOLDER_SPANS[2];

/** 第 N 級（含）以上的持股比例。索引就是級距編號減一。 */
const cumAt = (row, level) => row[H_CUM + level - 1];

/** 目前選定的門檻以上的比例，例如「400 張以上」。 */
const bigAt = (row) => cumAt(row, LOT_LEVEL[state.holderLots]);

/**
 * 散戶（100 張以下）。cum1 是十五個級距的合計、cum10 是 100 張以上，兩者相減
 * 就是不到 100 張的那一段 —— 不用 100 減，因為 cum1 已經把「差異數調整」那一列
 * 排除在外了，拿 100 去減會把它算進散戶頭上。
 */
const smallAt = (row) => cumAt(row, 1) - cumAt(row, SMALL_LEVEL);

/**
 * 第 N 級（含）以上有幾個集保帳戶。
 *
 * 這個數字是用來拆穿比例的：級距是門檻不是連續的尺，一個原本持有 900 張的帳戶
 * 買到 1,100 張，他整個部位會一次跳到千張那一層 —— 比例搬動一大塊、戶數只多一個。
 * 小型股上這是常態（一檔七萬張的股票，一個千張帳戶就佔 1.3 個百分點），
 * 只看比例會把「原本就在的人跨過了那條線」讀成「有人從市場上大買」。
 */
const headsAt = (row, level) => row[H_HEADS + level - HEADS_BASE];

/** 目前選定門檻以上有幾戶。 */
const bigHeads = (row) => headsAt(row, LOT_LEVEL[state.holderLots]);

const headsText = (n) => (n === null || n === undefined ? '—' : `${n.toLocaleString('zh-TW')} 戶`);

/**
 * 這一層握有幾張。比例乘上集保庫存換算而來 —— 比例只留兩位小數，所以尾數有幾張的
 * 誤差，看的是量級不是精確值。
 *
 * 之所以要把它換算出來：比例的分母（集保庫存）自己會變，減資或增資之後「比例上升」
 * 與「張數增加」可以是相反的兩件事。張數是那一層真正握著的東西，沒有分母問題。
 */
const lotsHeld = (row, pick) => Math.round((pick(row) / 100) * row[H_LOTS]);

/**
 * 戶數的變化是整數，寫成 +4 就好，不要跟比例的 pp 混在一起。
 * 沒變的寫 ±0 而不是 0 —— 一排 +2、+3 之間夾一個光禿禿的 0，會被讀成「只有 0 戶」。
 */
const headsDelta = (v) => (v === null || v === undefined ? '' : v === 0 ? '±0' : `${v > 0 ? '+' : ''}${v}`);

const lotsText = () => `${state.holderLots} 張以上`;

const pctText = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(2)}%`);

/** 比例的變化用「百分點」不是「百分比」：87.5% 變 88.0% 是 +0.5pp，不是 +0.5%。 */
const ppText = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}pp`);

const peopleText = (n) =>
  (n === null || n === undefined ? '—'
    : n >= 10000 ? `${(n / 10000).toFixed(1)} 萬人` : `${n.toLocaleString('zh-TW')} 人`);

function mid(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const half = sorted.length >> 1;
  return sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
}

/** 目前選定的交易日往回找，最近一份集保資料是哪一週。都比它晚就回 null。 */
function holderWeekAt(weeks, date) {
  let found = null;
  for (const w of weeks) {
    if (w.d > date) break;
    found = w;
  }
  return found;
}

/**
 * 拿來比的那一份。集保是週資料，往前回補的那一段又稀疏到半年才一份，所以只接受
 * 落在 [min, max] 天之內的快照，並取最接近目標天數的那一份；湊不出來就回 null。
 *
 * 少了這個下限，「較前一週」會拿半年前那一筆去比 —— 算出來的數字是真的，
 * 標籤卻是假的。寧可顯示「—」，也不要給一個看起來很像上週的數字。
 */
function holderBaseWeek(weeks, cur, spec) {
  let best = null;
  let bestGap = Infinity;
  for (const w of weeks) {
    if (w.d >= cur.d) break;
    const gap = daysBetween(w.d, cur.d);
    if (gap < spec.min || gap > spec.max) continue;
    if (Math.abs(gap - spec.days) < bestGap) {
      best = w;
      bestGap = Math.abs(gap - spec.days);
    }
  }
  return best;
}

/** 一檔的某個數字變化；沒有基準就回 null（不是 0 —— 那是「沒得比」不是「沒有變」）。 */
const holderDelta = (entry, pick) => (entry.prev ? pick(entry.cur) - pick(entry.prev) : null);

/** 股東人數的變化用百分比：一檔 3 萬人、一檔 300 萬人，差幾個人不能放在一起比。 */
const peopleChange = (entry) =>
  (entry.prev && entry.prev[H_PEOPLE] ? (entry.cur[H_PEOPLE] / entry.prev[H_PEOPLE] - 1) * 100 : null);

function holderRow(entry) {
  const { stock, cur, prev } = entry;
  const chip = (label, text, delta, fmt) =>
    `<span class="chip">${label} ${text}${
      delta === null ? '' : ` <em class="${trend(delta)}">${fmt(delta)}</em>`}</span>`;
  const chips = [
    // 門檻已經選在千張時，再放一個千張的小字就是把同一個數字寫兩次
    ...(state.holderLots === 1000 ? [] : [
      chip('千張', pctText(cumAt(cur, TOP_LEVEL)),
        holderDelta(entry, (r) => cumAt(r, TOP_LEVEL)), ppText),
    ]),
    chip('散戶', pctText(smallAt(cur)), holderDelta(entry, smallAt), ppText),
    chip('股東', peopleText(cur[H_PEOPLE]), peopleChange(entry), (v) => signedPct(v, 1)),
  ].join('');
  const dBig = holderDelta(entry, bigAt);
  const dHeads = holderDelta(entry, bigHeads);
  return `<a class="row" href="#/holders/${stock.code}">
    <div class="rank"><span class="no">${stock.rank}</span><span class="delta flat">名次</span></div>
    <div class="ident">
      <span class="name">${state.watch.has(stock.code) ? '<span class="star">★</span>' : ''}${esc(stock.name)}</span>
      <span class="code">${stock.code}${stock.m ? ` · ${esc(MARKET_TAGS[stock.m])}` : ''}${
        hasIndustry() ? ` · ${esc(industryOf(stock.code))}` : ''}</span>
      <span class="chips">${chips}</span>
    </div>
    <div class="figures">
      <span class="value">${pctText(bigAt(cur))}</span>
      <span class="price">${esc(lotsText())}${prev ? ` <em class="${trend(dBig)}">${ppText(dBig)}</em>` : ''}</span>
      <span class="price">${headsText(bigHeads(cur))}${
        prev ? ` <em class="${trend(dHeads)}">${headsDelta(dHeads)}</em>` : ''}</span>
    </div>
  </a>`;
}

/** 這一頁共用的一段話：這些數字能講什麼、不能講什麼。 */
const HOLDER_CAVEAT = `集保分的是<b>帳戶</b>不是實質股東：外資持股掛在保管銀行底下，
  一家保管銀行就是一個千張大戶，公司派、董監與庫藏股同樣落在大戶級距 ——
  台積電的千張大戶常年在八成以上，那是外資與國發基金，不是有人在偷偷吃貨。
  比例的分母是集保庫存數，未集保的實體股票不在裡面。
  這是一週一次的<b>存量</b>快照，看得出集中度往哪邊移動，看不出是誰買的、什麼價位買的。`;

/** 門檻選單。散戶那一段固定在 100 張以下，只有大戶這一頭跟著選。 */
const holderLotsControls = () => `
  <div class="controls">${pills('holderlots', HOLDER_LOTS, state.holderLots)}</div>
  <div class="controls">${pills('holderspan', HOLDER_SPANS, state.holderSpan)}</div>`;

async function renderHolderList(view, index) {
  const weeks = index.weeks || [];
  const cur = holderWeekAt(weeks, state.date);
  if (!cur) {
    view.innerHTML = `${holderLotsControls()}
      <p class="hint">${state.date} 之前還沒有集保資料，最早一份是 ${esc(weeks[0].d)}。<br>
      請把日期往後挪，或執行 <code>scripts/backfill_holders.py</code> 往前回補。</p>`;
    return;
  }

  const spec = holderSpanSpec();
  const base = holderBaseWeek(weeks, cur, spec);
  const [today, curSnap, baseSnap] = await Promise.all([
    loadDaily(state.date),
    loadHolderWeek(cur.d),
    base ? loadHolderWeek(base.d) : Promise.resolve(null),
  ]);

  // 出發點與其他分頁一樣是「當日成交值前 200 名」，不是集保那三千多檔 ——
  // 沒進榜的股票在本站沒有成交值、產業與名次可以擺在旁邊對照。
  const top = today.stocks.filter((s) => s.rank <= TOP);
  const rows = [];
  const missing = [];
  for (const stock of top) {
    const now = curSnap.stocks[stock.code];
    if (!now) {
      missing.push(stock);
      continue;
    }
    rows.push({ stock, cur: now, prev: (baseSnap && baseSnap.stocks[stock.code]) || null });
  }

  if (!rows.length) {
    view.innerHTML = `<p class="hint">${esc(cur.d)} 那一份集保資料裡，${state.date}
      榜上這 ${top.length} 檔一檔都沒有。</p>`;
    return;
  }

  const graded = rows.filter((r) => r.prev);
  const moved = (r) => holderDelta(r, bigAt);
  const up = graded.filter((r) => moved(r) > HOLDER_MOVE_MIN).sort((a, b) => moved(b) - moved(a));
  const down = graded.filter((r) => moved(r) < -HOLDER_MOVE_MIN).sort((a, b) => moved(a) - moved(b));
  const concentrated = rows.slice().sort((a, b) => bigAt(b.cur) - bigAt(a.cur));
  const shrinking = graded
    .filter((r) => peopleChange(r) < 0)
    .sort((a, b) => peopleChange(a) - peopleChange(b));

  const peopleNow = graded.reduce((sum, r) => sum + r.cur[H_PEOPLE], 0);
  const peopleThen = graded.reduce((sum, r) => sum + r.prev[H_PEOPLE], 0);
  const peopleAll = peopleThen ? (peopleNow / peopleThen - 1) * 100 : null;

  // 第二格擺的是「另一個參照點」：平常是千張大戶，門檻已經選在千張時改看 400 張，
  // 否則兩格會是同一個數字，等於白白浪費一格
  const alt = state.holderLots === 1000
    ? { level: LOT_LEVEL[400], label: '400 張以上' }
    : { level: TOP_LEVEL, label: '千張大戶' };

  // 統計格一排三個，所以要嘛三個、要嘛六個 —— 湊四個的話尾巴會露出兩塊灰色空位
  const stats = [
    { b: pctText(mid(rows.map((r) => bigAt(r.cur)))), span: `${lotsText()}中位數` },
    { b: pctText(mid(rows.map((r) => cumAt(r.cur, alt.level)))), span: `${alt.label}中位數` },
    { b: pctText(mid(rows.map((r) => smallAt(r.cur)))), span: '散戶比例中位數' },
    { b: graded.length ? pair(up.length, down.length) : '—', span: '加碼／減碼（檔）' },
    { b: peopleAll === null ? '—' : signedPct(peopleAll, 2), span: '股東人數合計', cls: trend(peopleAll) },
    { b: `${rows.length}/${top.length}`, span: '榜上查得到集保' },
  ];

  const baseText = base
    ? `對比 ${base.d}（${daysBetween(base.d, cur.d)} 天前）`
    : `${spec.label}湊不出基準`;

  const gapNote = base
    ? ''
    : `<p class="note">目前這 ${weeks.length} 份集保資料裡，找不到落在${esc(spec.label)}那個區間
       （${spec.min}～${spec.max} 天前）的一份，所以這一頁的變化欄全部留白。
       換一個期間，或等每週的快照累積起來 —— 往前回補的那一段是稀疏的，
       短期比較本來就湊不出基準。</p>`;

  // 「這一份不是全市場」要講得出理由：是典藏檔案被切斷，還是我們只逐檔補了一批。
  // 少了這句，那一週查不到的股票看起來就像退出了集保。
  const partialNote = (week, when) =>
    (week && week.p
      ? `<br>⚠ ${when}的 ${week.d} 只涵蓋 ${week.n} 檔${week.w ? `：${esc(week.w)}` : ''}。`
      : '');

  view.innerHTML = `
    ${holderLotsControls()}
    <section class="card">
      <h2>集保股權分散 <small>資料日 ${esc(cur.d)} · ${esc(baseText)}</small></h2>
      <div class="stat-grid">${stats
        .map((s) => `<div class="stat"><b class="${s.cls || ''}">${s.b}</b><span>${s.span}</span></div>`)
        .join('')}</div>
      <p class="note">大戶的門檻是選出來的：這一頁現在算的是<b>持股 ${state.holderLots} 張以上</b>
        （官方的第 ${LOT_LEVEL[state.holderLots]} 級以上）佔集保庫存數的比例。
        散戶那一頭固定是 100 張以下，不跟著門檻走 —— 兩邊都會動的話，
        比較的基準就變成兩件事在動，看不出到底是誰交給了誰。</p>
      <p class="note">${state.date} ${scopeLabel()}前 ${TOP} 名裡有 ${rows.length} 檔查得到集保資料${
        missing.length ? `，${missing.length} 檔查不到（${missing.slice(0, 5).map((s) => esc(s.code)).join('、')}${
          missing.length > 5 ? ' 等' : ''}）` : ''}${
        base ? `，其中 ${graded.length} 檔在 ${base.d} 那一份裡也查得到、算得出變化` : ''}。
        集保每週五結算一次，所以同一週的每個交易日看到的是同一份資料。
        ${partialNote(cur, '本期')}${partialNote(base, '基準')}</p>
      ${gapNote}
    </section>
    ${listCard('大戶加碼', `${spec.label}${lotsText()}的比例增加最多 · 取前 ${HOLDER_TOP}`,
      up.slice(0, HOLDER_TOP).map(holderRow),
      base ? `這個期間榜上沒有任何一檔的${lotsText()}比例上升` : '沒有基準可比')}
    ${listCard('大戶減碼', `${spec.label}${lotsText()}的比例減少最多 · 取前 ${HOLDER_TOP}`,
      down.slice(0, HOLDER_TOP).map(holderRow),
      base ? `這個期間榜上沒有任何一檔的${lotsText()}比例下降` : '沒有基準可比')}
    ${listCard('籌碼最集中', `${lotsText()}的比例最高 · 取前 ${HOLDER_TOP}`,
      concentrated.slice(0, HOLDER_TOP).map(holderRow))}
    ${listCard('股東人數減少最多', `${spec.label} · 取前 ${HOLDER_TOP}`,
      shrinking.slice(0, HOLDER_TOP).map(holderRow),
      base ? '這個期間榜上沒有任何一檔的股東人數減少' : '沒有基準可比')}
    <section class="card">
      <h2>這一頁在講什麼 <small>以及不能拿它講什麼</small></h2>
      <p class="note">${HOLDER_CAVEAT}</p>
      <p class="note">「大戶加碼」與「股東人數減少」講的是同一件事的兩面：股數沒有變，
        持有的人變少，就是有人把零股賣給了大戶。兩張榜重疊的那幾檔，是這個期間籌碼收得
        最乾淨的。反過來，股東人數暴增配上大戶比例下降，是散戶在接手 ——
        台積電從 2024 年初的 106 萬股東變成現在的 300 萬，就是這樣一路稀釋掉的。</p>
      <p class="note">換門檻看到的會是不同的故事：400 張以上還含著不少中實戶，
        1,000 張以上幾乎只剩法人、公司派與保管銀行。同一檔在 400 張那一層加碼、
        在 1,000 張那一層卻在減碼，代表籌碼是從最大的手上流到次大的手上。
        中間的數字（例如 500 張）官方沒有分，所以選單只給得出這六個。</p>
      <p class="note">資料來自集保結算所的
        <a class="linky" href="https://opendata.tdcc.com.tw/getOD.ashx?id=1-5" target="_blank" rel="noopener">股權分散表</a>
        （目前累積 ${weeks.length} 份，${esc(index.first)} 起）。那個網址只給最新一週、
        下一週就被蓋掉，所以歷史是本站自己累積與回補的：近一年逐週的那一段是從集保官網
        的個股查詢頁一檔一檔補來的（因此只涵蓋補抓當時榜上那一批），再往前的那幾份來自
        網頁典藏館、一年只有兩三份。資料日之間的間隔不等寬就是這麼來的。</p>
    </section>`;
}

/**
 * 單一個股的持股趨勢。三條比例線疊在一起才看得出「誰把股票交給了誰」——
 * 大戶比例往上、散戶比例往下，兩條線是同一件事的兩端。
 */
async function renderHolderStock(view, index, code) {
  const [series, meta] = await Promise.all([loadHolderStock(code), seriesFor(code)]);
  if (!series || !Array.isArray(series.d) || !series.d.length) {
    view.innerHTML = `<p class="hint">${esc(code)} 沒有集保資料。<br>
      只有進過本站排行的個股才有序列，下市或合併的代號在集保那份 CSV 裡也查不到。<br>
      <a class="linky" href="#/holders">← 回大戶清單</a></p>`;
    return;
  }

  const points = series.d.map((d, i) => ({ d, v: series.v[i] }));
  const last = points[points.length - 1];
  const baseAt = (spec) => {
    let best = null;
    let bestGap = Infinity;
    for (const p of points) {
      if (p.d >= last.d) break;
      const gap = daysBetween(p.d, last.d);
      if (gap < spec.min || gap > spec.max) continue;
      if (Math.abs(gap - spec.days) < bestGap) {
        best = p;
        bestGap = Math.abs(gap - spec.days);
      }
    }
    return best;
  };
  // 六個門檻共用同兩份基準，算一次就好
  const bases = HOLDER_SPANS.map((spec) => ({ spec, at: baseAt(spec) }));
  const baseFor = (value) => (bases.find((b) => b.spec.value === value) || {}).at || null;
  const deltaOver = (value, pick) => {
    const b = baseFor(value);
    return b ? pick(last.v) - pick(b.v) : null;
  };
  const dWeek = deltaOver('w1', bigAt);
  const dQuarter = deltaOver('q1', bigAt);

  const first = points[0];
  const spanPp = bigAt(last.v) - bigAt(first.v);
  const peoplePct = first.v[H_PEOPLE] ? (last.v[H_PEOPLE] / first.v[H_PEOPLE] - 1) * 100 : null;

  // 與清單頁同一個道理：門檻選在千張時，第二格改看 400 張，不要寫兩次同一個數字
  const alt = state.holderLots === 1000
    ? { level: LOT_LEVEL[400], label: '400 張以上' }
    : { level: TOP_LEVEL, label: '千張大戶' };

  const stats = [
    { b: pctText(bigAt(last.v)), span: lotsText() },
    { b: headsText(bigHeads(last.v)), span: `${lotsText()} 有幾戶`, cls: 'sm' },
    { b: pctText(cumAt(last.v, alt.level)), span: alt.label },
    { b: pctText(smallAt(last.v)), span: '散戶（100 張以下）' },
    { b: ppText(dWeek), span: `${lotsText()} 較前一週`, cls: trend(dWeek) },
    { b: peopleText(last.v[H_PEOPLE]), span: '股東人數', cls: 'sm' },
  ];

  // 整條梯子攤開來。門檻選單一次只看得到一層，但「哪一層在加、哪一層在減」
  // 要並排才看得出來 —— 最大的手在減碼、次大的在接，是換手不是出貨。
  const ladder = HOLDER_LOTS.map((opt) => {
    const pick = (row) => cumAt(row, LOT_LEVEL[opt.value]);
    const w1 = deltaOver('w1', pick);
    const q1 = deltaOver('q1', pick);
    const on = opt.value === state.holderLots;
    return `<div class="row row--ladder${on ? ' is-on' : ''}">
      <div class="ident">
        <span class="name">${esc(opt.label)}以上${on ? ' <em class="accent">目前</em>' : ''}</span>
        <span class="code">第 ${LOT_LEVEL[opt.value]} 級以上</span>
      </div>
      <div class="figures"><span class="value">${pctText(pick(last.v))}</span>
        <span class="price">${headsText(headsAt(last.v, LOT_LEVEL[opt.value]))}</span></div>
      <div class="figures"><span class="value"><em class="${trend(w1)}">${ppText(w1)}</em></span>
        <span class="price">較前一週</span></div>
      <div class="figures"><span class="value"><em class="${trend(q1)}">${ppText(q1)}</em></span>
        <span class="price">近一季</span></div>
    </div>`;
  }).join('');

  // 逐週明細：一列一個資料日，跟上一列比。日期軸本來就不等寬，所以每一列都標出
  // 距離上一列幾天 —— 隔了半年的那一列若不標，讀起來會像是「一週就變這麼多」。
  const weekly = points.slice().reverse().slice(0, HOLDER_ROWS).map((p, i, arr) => {
    const older = arr[i + 1] || null;
    const pp = older ? bigAt(p.v) - bigAt(older.v) : null;
    // 右邊那個 % 講的是「張數」的變化，不是「比例的相對變化」。兩個理由：
    // 一、比例的百分比放在比例旁邊，兩個 % 意思不同卻長得一樣，一定會被讀錯；
    // 二、比例的分母自己會變，減資之後「比例上升、張數下降」是常態，
    //     拿比例去算相對變化會說出跟事實相反的話。
    const held = lotsHeld(p.v, bigAt);
    const heldWas = older ? lotsHeld(older.v, bigAt) : null;
    const rel = heldWas ? (held / heldWas - 1) * 100 : null;
    const heads = bigHeads(p.v);
    const dh = older ? heads - bigHeads(older.v) : null;
    const gap = older ? daysBetween(older.d, p.d) : null;
    return `<div class="row row--ladder">
      <div class="ident">
        <span class="name">${esc(p.d)}</span>
        <span class="code">${gap === null ? '最早一筆' : `距上一列 ${gap} 天${gap > 14 ? ' ⚠' : ''}`}</span>
      </div>
      <div class="figures"><span class="value">${pctText(bigAt(p.v))}</span>
        <span class="price">${num(held, 0)} 張</span></div>
      <div class="figures"><span class="value"><em class="${trend(pp)}">${ppText(pp)}</em></span>
        <span class="price">張數 ${rel === null ? '—' : `<em class="${trend(rel)}">${signedPct(rel, 1)}</em>`}</span></div>
      <div class="figures"><span class="value">${headsText(heads)}</span>
        <span class="price">${dh === null ? '—' : `<em class="${trend(dh)}">${headsDelta(dh)} 戶</em>`}</span></div>
    </div>`;
  }).join('');

  view.innerHTML = `
    <div class="controls">${pills('holderlots', HOLDER_LOTS, state.holderLots)}</div>
    <section class="card">
      <h2>${esc(meta.name || code)} <small>${esc(code)} · 集保資料日 ${esc(last.d)}</small></h2>
      <div class="stat-grid">${stats
        .map((s) => `<div class="stat"><b class="${s.cls || ''}">${s.b}</b><span>${s.span}</span></div>`)
        .join('')}</div>
      <p class="note">集保庫存 ${num(last.v[H_LOTS], 0)} 張 · 共 ${points.length} 個資料日（${esc(first.d)} 起）。
        整段期間，${esc(lotsText())}的比例${spanPp === 0 ? '沒有變化'
          : tint(spanPp, `${spanPp > 0 ? '增加' : '減少'} ${Math.abs(spanPp).toFixed(2)}pp`)}、
        股東人數${peoplePct === null ? '無從比較'
          : tint(peoplePct, `${peoplePct > 0 ? '增加' : '減少'} ${Math.abs(peoplePct).toFixed(1)}%`)}。</p>
    </section>
    <section class="card">
      <h2>各門檻一次看 <small>佔集保庫存數 %</small></h2>
      ${ladder}
      <p class="note">每一列都是「這個張數以上」的累積比例與戶數，所以由上往下一定愈來愈小。
        看的是哪一層在動：最大的那一層在減、次大的那一層在增，是籌碼在大戶之間換手；
        六層一起往下掉才是真的往散戶流出去。湊不出基準的期間顯示「—」。</p>
    </section>
    <section class="card">
      <h2>逐週明細 <small>${esc(lotsText())} · 新的在上面</small></h2>
      ${weekly}
      ${points.length > HOLDER_ROWS
        ? `<p class="note">只列最近 ${HOLDER_ROWS} 個資料日，更早的 ${points.length - HOLDER_ROWS}
           個在上面的圖裡。</p>` : ''}
      <p class="note">變動一律跟<b>上一列</b>比，不是跟今天比。中間那一欄的兩個數字
        <b>單位不同、問題也不同</b>：<b>pp</b> 是「佔集保庫存的比例」差了幾個百分點，
        <b>張數 %</b> 是這一層手上的股票多了或少了幾成。</p>
      <p class="note">兩者常常一致，但<b>分母會變</b>：集保庫存因為減資、增資而改變時，
        比例上升與張數下降可以同時發生 —— 那時候只看 pp 會說出跟事實相反的話。
        張數是比例乘上集保庫存換算的，比例只留兩位小數，所以尾數有幾張的誤差，
        看的是量級不是精確值。</p>
      <p class="note">戶數那一欄是用來拆穿比例的：級距是門檻不是連續的尺，一個持有
        900 張的帳戶買到 1,100 張，整個部位會一次跳進千張那一層 —— 比例搬一大塊、
        戶數只多一個。比例大動而戶數沒動，多半就是跨門檻，不是有人從市場上大買。</p>
      <p class="note">資料日之間的間隔不等寬，隔超過 14 天的那幾列標了 ⚠ ——
        那是回補歷史留下的斷層，不能當成「一週的變化」讀。</p>
    </section>
    <section class="card">
      <h2>持股比例 <small>佔集保庫存數 %</small></h2>
      <div class="chart-box"><canvas id="c-holder"></canvas></div>
      <p class="note">${esc(lotsText())}已經把千張大戶算在裡面，所以那兩條線永遠上下夾著；
        中間 100 張到門檻之間的那一段不畫，它是三條線之外的餘數。
        ${points.length < 8 ? '目前的資料日還很少，看得出高低但看不出節奏。' : ''}</p>
    </section>
    <section class="card">
      <h2>股東人數 <small>集保帳戶數</small></h2>
      <div class="chart-box"><canvas id="c-holder-people"></canvas></div>
      <p class="note">股數不變的前提下，人數變少就是籌碼在集中、人數變多就是在分散。
        除權息、增資與股票分割會讓人數階梯式跳動，那不是籌碼流動。</p>
    </section>
    <section class="card">
      <h2>要注意的地方</h2>
      <p class="note">${HOLDER_CAVEAT}</p>
      <p class="note">橫軸是集保的資料日、不是交易日，而且<b>點距不等寬</b> ——
        近一年逐週的那一段是一週一點，再往前只剩網頁典藏館那幾份、一年兩三點。
        中間那幾條很長很直的線是因為那段期間沒有資料，不是那段期間沒有變化。</p>
    </section>
    <p class="hint"><a class="linky" href="#/holders">← 回大戶清單</a>
      <a class="linky" href="#/stock/${esc(code)}">看這一檔的排名與 K 線</a></p>`;

  try {
    const Chart = await loadChartJs();
    const labels = points.map((p) => p.d);
    drawLine(Chart, $('#c-holder'), labels, [
      { data: points.map((p) => bigAt(p.v)), color: HLINE.big, label: lotsText() },
      // 門檻已經選在千張時，第二條線會與第一條完全重疊，畫了只是把圖例佔掉
      ...(state.holderLots === 1000 ? [] : [
        { data: points.map((p) => cumAt(p.v, TOP_LEVEL)), color: HLINE.top, label: '千張大戶' },
      ]),
      { data: points.map((p) => smallAt(p.v)), color: HLINE.small, label: '散戶 100 張以下' },
    ], { suffix: ' %', emptyText: '無資料' });
    drawLine(Chart, $('#c-holder-people'), labels, [
      { data: points.map((p) => p.v[H_PEOPLE]), color: HLINE.people, label: '股東人數' },
    ], { suffix: ' 人', emptyText: '無資料' });
  } catch (err) {
    view.querySelectorAll('.chart-box').forEach((box) => {
      box.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
    });
  }
}

async function renderHolders(view, code) {
  let index;
  try {
    index = await loadHolderIndex();
  } catch (err) {
    view.innerHTML = `<p class="hint">還沒有集保資料（${esc(err.message)}）。<br>
      請先執行 <code>scripts/fetch_holders.py</code> 與 <code>scripts/build_holders.py</code>；
      要一次補上一段歷史再加跑 <code>scripts/backfill_holders.py</code>。</p>`;
    return;
  }
  if (!index.weeks || !index.weeks.length) {
    view.innerHTML = '<p class="hint">集保目錄裡沒有任何資料日，請重跑 scripts/build_holders.py。</p>';
    return;
  }
  if (code) await renderHolderStock(view, index, code);
  else await renderHolderList(view, index);
}

// --------------------------------------------------------------------------
// 分頁六：族群（資金流向）
// --------------------------------------------------------------------------
const SECTOR_SORTS = [
  { value: 'flow', label: '依資金增減' },
  { value: 'shift', label: '依佔比位移' },
  { value: 'value', label: '依成交值' },
];

// 億元。10 億以下留一位小數，否則小族群與小額的資金變化會全部顯示成「0 億」。
const okuText = (yuan) => {
  const oku = yuan / 1e8;
  return `${num(oku, Math.abs(oku) < 10 ? 1 : 0)} 億`;
};
const signedPct = (v, digits = 1) => (v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`);

/**
 * 成交值加權漲跌幅。成交值本身沒有方向（一買一賣才成交），
 * 所以「這一族的錢是把價格推上去還是砍下來」要靠漲跌幅補，
 * 而權重必須是成交值——族群的資金流向本來就由成交值大的那幾檔決定。
 */
function weightedChange(codes, pool) {
  let weight = 0;
  let sum = 0;
  for (const code of codes) {
    const s = pool.get(code);
    if (!s || s.changePct === null || s.changePct === undefined) continue;
    weight += s.value;
    sum += s.value * s.changePct;
  }
  return weight ? sum / weight : null;
}

/**
 * 替各族群算出與基準日相比的資金變化。兩個數字要一起看：
 *
 *   flow   成交值增減（元）——直覺的「錢變多還變少」，但大盤整體縮量時全部都會是負的
 *   shift  佔榜上成交值比重的變化（百分點）——把大盤的縮放抽掉，錢實際上從哪一族轉到哪一族
 *
 * 只出現在今天、基準日沒進榜的族群沒有比較基準，flow／shift 皆為 null，排序時沉到最後。
 */
function groupFlows(groups, baseGroups, pool, total, baseTotal) {
  return groups.map((g) => {
    const base = baseGroups.get(g.name);
    const share = total ? (g.value / total) * 100 : 0;
    return {
      ...g,
      share,
      chg: weightedChange(g.codes, pool),
      flow: base ? g.value - base.value : null,
      flowPct: base && base.value ? ((g.value - base.value) / base.value) * 100 : null,
      shift: base && baseTotal ? share - (base.value / baseTotal) * 100 : null,
      countDelta: base ? g.count - base.count : null,
    };
  });
}

/** 資金流向橫條：從中線往右是流入、往左是流出，長度對比當日最大流量。 */
function flowBar(flow, maxFlow) {
  if (flow === null || !maxFlow) return '<div class="flow-bar"></div>';
  const width = Math.min(50, (Math.abs(flow) / maxFlow) * 50);
  const side = flow >= 0 ? 'left:50%' : 'right:50%';
  return `<div class="flow-bar"><i class="${trend(flow)}" style="${side};width:${width.toFixed(1)}%"></i></div>`;
}

function sectorRow(g, maxFlow) {
  const flowText = g.flow === null
    ? '<span class="value flat">NEW</span>'
    : `<span class="value ${trend(g.flow)}">${g.flow > 0 ? '+' : ''}${okuText(g.flow)}</span>`;
  const shiftText = g.shift === null
    ? ''
    : ` · <em class="${trend(g.shift)}">${g.shift > 0 ? '+' : ''}${g.shift.toFixed(2)}pp</em>`;
  const countText = g.countDelta ? `${g.countDelta > 0 ? '+' : ''}${g.countDelta} 檔` : '檔';
  const identText = g.gone
    ? `整族退出前 ${TOP} 大${shiftText}`
    : `${okuText(g.value)} · 佔 ${num(g.share)}%${shiftText}`;
  const priceText = g.gone
    ? '已退榜'
    : `${g.flowPct === null ? '新進榜' : signedPct(g.flowPct)}
       · 加權 <em class="${trend(g.chg)}">${signedPct(g.chg, 2)}</em>`;

  const summary = `<div class="rank"><span class="no">${g.count}</span>
        <span class="delta ${trend(g.countDelta)}">${countText}</span></div>
      <div class="ident"><span class="name">${esc(g.name)}</span>
        <span class="code">${identText}</span></div>
      <div class="figures">${flowText}
        <span class="price">${priceText}</span></div>
      ${flowBar(g.flow, maxFlow)}`;

  // 整族退出榜外的沒有當日成分股可以展開，就畫成一般的列
  if (g.gone) return `<div class="row">${summary}</div>`;

  return `<details class="sector">
    <summary class="row">${summary}</summary>
    <div class="sector__body" data-sector="${esc(g.name)}"></div>
  </details>`;
}

/** 目前有效的分類軸。兩種並存，任一邊缺資料就退到另一邊；兩邊都沒有回傳 null。 */
function groupingMode() {
  if (!hasIndustry() && !hasThemes()) return null;
  if (state.grouping === 'theme') return hasThemes() ? 'theme' : 'industry';
  return hasIndustry() ? 'industry' : 'theme';
}

/** 族群頁與流向頁共用的一次計算：當日各族群，以及相對基準日的資金變化。 */
async function collectFlows(mode) {
  const baseDate = dateBack(state.baseline);
  const [today, base] = await Promise.all([loadDaily(state.date), loadDaily(baseDate)]);
  const topStocks = today.stocks.filter((s) => s.rank <= TOP);
  const baseStocks = base ? base.stocks.filter((s) => s.rank <= TOP) : [];
  const group = mode === 'theme' ? byTheme : bySector;
  const baseGroups = new Map(group(baseStocks).map((g) => [g.name, g]));
  // 題材族群一檔可屬多個族群，拿各族群加總當分母會把重複計算的部分算進去。
  // 分母一律取「榜上成交值總額」，每檔只算一次；官方產業模式下兩者本來就相等。
  const sumValue = (list) => list.reduce((n, s) => n + s.value, 0);
  const totalValue = sumValue(topStocks);
  const baseTotal = sumValue(baseStocks);
  const byCode = new Map(topStocks.map((s) => [s.code, s]));

  const groups = groupFlows(group(topStocks), baseGroups, byCode, totalValue, baseTotal);
  // 基準日在榜、今天整族退出榜外的也是資金流出，不能因為今天榜上沒有就當作沒發生。
  // 「未分類」不算：它從名單裡消失代表今天全部歸類到了，不是有錢流出去。
  const present = new Set(groups.map((g) => g.name));
  for (const b of baseGroups.values()) {
    if (present.has(b.name) || b.name === UNGROUPED_LABEL) continue;
    groups.push({
      name: b.name, count: 0, codes: [], value: 0, share: 0, chg: null, gone: true,
      flow: -b.value, flowPct: -100, shift: -(b.value / baseTotal) * 100, countDelta: -b.count,
    });
  }

  return {
    baseDate, base, topStocks, byCode, totalValue, baseTotal, groups,
    totalFlowPct: baseTotal ? ((totalValue - baseTotal) / baseTotal) * 100 : null,
    marketChg: weightedChange([...byCode.keys()], byCode),
  };
}

/** 兩頁共用的說明文字：分類軸的來源與名單缺口。 */
function groupingNote(mode, topCount, ungrouped) {
  const coverage = ungrouped
    ? `今日榜上 ${topCount} 檔中還有 ${ungrouped} 檔沒歸類。`
    : `今日榜上 ${topCount} 檔都已歸類。`;
  return mode === 'theme'
    ? `題材族群是人工維護的供應鏈視角（<code>data/themes.json</code>${state.themesUpdated ? `，維護於 ${esc(state.themesUpdated)}` : ''}），
       一檔可以同時屬於多個族群，所以各族群佔比加總會超過 100%。${coverage}`
    : '產業別採證交所的官方分類，跟著上市櫃公司基本資料自動更新，不會漏掉任何一檔；'
      + '但它與市場口中的題材族群對不起來時，切到「題材族群」看。分類取自最新一次抓取的結果，並回頭套用到歷史日期。';
}

/**
 * 族群頁的一句話。金額增減會被大盤整體的縮放帶著走，所以「錢從哪一族轉到哪一族」
 * 一律用抽掉縮放的佔比位移（pp）來挑，金額只是拿來標出規模。
 */
function sectorSay(mode, baseDate, totalFlowPct, marketChg, inflow, outflow, groups, totalValue) {
  const axis = mode === 'theme' ? '題材族群' : '官方產業';
  const real = groups.filter((g) => g.name !== UNGROUPED_LABEL);
  const shifted = real.filter((g) => g.shift !== null).slice().sort((a, b) => b.shift - a.shift);
  const sub = `榜上資金總量 · ${state.date}${baseDate ? ` vs ${baseDate}` : ''}`;
  const stats = [
    { b: okuText(totalValue), span: `前 ${TOP} 大成交值`, cls: 'sm' },
    { b: signedPct(totalFlowPct), span: '整體增減', cls: `sm ${trend(totalFlowPct)}` },
    { b: signedPct(marketChg, 2), span: '成交值加權漲跌', cls: `sm ${trend(marketChg)}` },
    { b: pair(inflow, outflow), span: '流入 / 流出族群', cls: 'sm' },
  ];
  const note = `整體增減是大盤的縮放，會讓所有族群一起變大或變小。
    要看「錢從哪一族轉到哪一族」，用抽掉大盤縮放的<b>佔比位移（pp）</b>。`;

  if (!baseDate || shifted.length < 2) {
    const biggest = real.reduce((a, b) => (b.value > a.value ? b : a), real[0]);
    return takeaway(`${state.date} 沒有可以比較的基準日，只看得出當下的分佈：榜上前 ${TOP} 大共
      ${okuText(totalValue)}，最大的一族是 <b>${esc(biggest.name)}</b>（${okuText(biggest.value)}、
      佔 ${num(biggest.share)}%）。`, sub, stats, note);
  }
  // 金額與位移各自照自己的正負上色，不共用一個顏色：大盤整體縮量的日子裡，
  // 一族可以是金額變少、佔比卻反而升高，兩個數字的方向本來就會不一樣。
  const figs = (g) => `（${tint(g.flow, `${g.flow > 0 ? '+' : ''}${okuText(g.flow)}`)}、位移
    ${tint(g.shift, `${g.shift > 0 ? '+' : ''}${g.shift.toFixed(2)}pp`)}）`;
  // 族群名跟著位移上色——這兩族是用位移挑出來的，顏色要對得上挑的那個標準
  const who = (g) => tint(g.shift, `<b>${esc(g.name)}</b>`);
  const inTop = shifted[0];
  const outTop = shifted[shifted.length - 1];
  return takeaway(
    `對比 ${baseDate}，榜上整體 ${tint(totalFlowPct, signedPct(totalFlowPct))}、成交值加權
     ${tint(marketChg, signedPct(marketChg, 2))}，${axis}裡 ${tint(1, `${inflow} 族流入`)}、
     ${tint(-1, `${outflow} 族流出`)}；抽掉大盤縮放之後，錢最明顯往 ${who(inTop)} 集中
     ${figs(inTop)}，從 ${who(outTop)} 撤出 ${figs(outTop)}。`,
    sub, stats, note);
}

async function renderSector(view) {
  const mode = groupingMode();
  if (!mode) {
    view.innerHTML = '<p class="hint">沒有分類資料，請先執行 scripts/fetch_industry.py。</p>';
    return;
  }

  const { baseDate, base, topStocks, byCode, totalValue, groups, totalFlowPct, marketChg }
    = await collectFlows(mode);

  const sorters = {
    flow: (a, b) => (b.flow ?? -Infinity) - (a.flow ?? -Infinity),
    shift: (a, b) => (b.shift ?? -Infinity) - (a.shift ?? -Infinity),
    value: (a, b) => b.value - a.value,
  };
  groups.sort((a, b) => {
    // 未分類是名單的缺口，不是族群，不管怎麼排都固定在最後
    if (a.name === UNGROUPED_LABEL) return 1;
    if (b.name === UNGROUPED_LABEL) return -1;
    return sorters[state.sectorSort](a, b);
  });
  const maxFlow = Math.max(...groups.map((g) => Math.abs(g.flow || 0)));

  const inflow = groups.filter((g) => g.flow > 0).length;
  const outflow = groups.filter((g) => g.flow < 0).length;

  // 名單的缺口要講出來，不然「未分類」看起來只是一個普通族群
  const ungrouped = groups.find((g) => g.name === UNGROUPED_LABEL)?.count || 0;
  const note = groupingNote(mode, topStocks.length, ungrouped);

  view.innerHTML = `
    <div class="controls">
      ${hasIndustry() && hasThemes() ? pills('grouping', GROUPINGS, mode) : ''}
      ${pills('baseline', BASELINES, state.baseline)}
    </div>
    ${sectorSay(mode, baseDate, totalFlowPct, marketChg, inflow, outflow, groups, totalValue)}
    <div class="controls">${pills('sectorsort', SECTOR_SORTS, state.sectorSort)}</div>
    <section class="card">
      <h2>${mode === 'theme' ? '題材族群' : '官方產業'}
        <small>${groups.filter((g) => !g.gone).length} 族群在榜${baseDate ? ` · 資金流向 vs ${baseDate}` : ''}</small></h2>
      ${groups.map((g) => sectorRow(g, maxFlow)).join('')}
      <p class="note">紅條向右是資金流入、綠條向左是流出，長度對比當日最大流量。
        成交值是買賣雙邊的總量、本身沒有方向，「加權」是成交值加權的漲跌幅，
        看的是這些錢把價格推上去還是砍下來。點一列可以展開該族群當日在榜的個股。${note}</p>
    </section>`;

  // 展開時才填內容，200 檔一次全渲染沒必要
  const baseRanks = rankMap(base);
  const found = new Map(groups.map((g) => [g.name, g]));
  const rowsOf = (codes) => codes
    .slice()
    .sort((a, b) => byCode.get(a).rank - byCode.get(b).rank)
    .map((c) => stockRow(byCode.get(c), baseRanks.get(c)))
    .join('');
  const bodyOf = (name) => {
    const g = found.get(name);
    if (!g) return '';
    if (!g.subs) return rowsOf(g.codes);
    if (g.subs.length < 2) return rowsOf(g.subs[0].codes);
    return g.subs.map((sub) =>
      `<p class="subhead">${esc(sub.name)}
        <small>${sub.codes.length} 檔 · ${fmtValue(sub.value)}</small></p>${rowsOf(sub.codes)}`).join('');
  };
  view.querySelectorAll('details.sector').forEach((el) => {
    el.addEventListener('toggle', () => {
      const box = $('.sector__body', el);
      if (el.open && !box.innerHTML) box.innerHTML = bodyOf(box.dataset.sector);
    });
  });
}

// --------------------------------------------------------------------------
// 分頁七：流向（把資金流向畫成圖）
//
// 族群頁是一張表，適合查數字；這一頁是兩張圖，適合一眼看出形狀：
//   資金地圖   面積＝今日成交值、顏色＝相對基準日的增減 → 錢在哪裡、往哪個方向動
//   量價四象限 橫軸＝成交值增減、縱軸＝加權漲跌       → 這些錢是買上去還是砍下來
// 兩張都用純 DOM／SVG 畫，不依賴 Chart.js：離線時也要看得到。
// --------------------------------------------------------------------------

/** squarified treemap（Bruls et al.）：回傳每塊的 x/y/w/h，單位與傳入的矩形相同。 */
function squarify(items, rect, out = []) {
  if (!items.length || rect.w <= 0 || rect.h <= 0) return out;
  const total = items.reduce((n, it) => n + it.value, 0);
  if (total <= 0) return out;

  const scale = (rect.w * rect.h) / total;
  const side = Math.min(rect.w, rect.h);
  // 一列裡最方正的那組長寬比；越接近 1 越好看
  const worst = (areas) => {
    const s = areas.reduce((a, b) => a + b, 0);
    return Math.max((side * side * Math.max(...areas)) / (s * s),
      (s * s) / (side * side * Math.min(...areas)));
  };

  const row = [];
  let best = Infinity;
  for (const it of items) {
    const ratio = worst([...row, it].map((r) => r.value * scale));
    if (row.length && ratio > best) break;      // 再加一塊只會更扁，這一列就到這裡
    row.push(it);
    best = ratio;
  }

  const rowArea = row.reduce((n, it) => n + it.value, 0) * scale;
  const rest = items.slice(row.length);
  if (rect.w >= rect.h) {                        // 短邊是高 -> 這一列直排在左側
    const w = Math.min(rect.w, rowArea / rect.h);
    let y = rect.y;
    for (const it of row) {
      const h = (it.value * scale) / w;
      out.push({ ...it, x: rect.x, y, w, h });
      y += h;
    }
    return squarify(rest, { x: rect.x + w, y: rect.y, w: rect.w - w, h: rect.h }, out);
  }
  const h = Math.min(rect.h, rowArea / rect.w);   // 短邊是寬 -> 這一列橫排在上方
  let x = rect.x;
  for (const it of row) {
    const w = (it.value * scale) / h;
    out.push({ ...it, x, y: rect.y, w, h });
    x += w;
  }
  return squarify(rest, { x: rect.x, y: rect.y + h, w: rect.w, h: rect.h - h }, out);
}

// 地圖以百分比定位，實際像素依螢幕而定。用手機寬度（約 360px × 這個比例）估一下
/**
 * 資金地圖。面積是今日成交值，顏色深淺是相對基準日的增減幅度。
 * 用增減「幅度」而不是「金額」上色：小族群翻倍也該看得出來，
 * 不然顏色會被半導體那種量體整片洗掉。
 *
 * 這裡只給一個空盒子，實際的塊要等量到盒子的長寬才畫得出來（paintTreemap）。
 */
function treemap(groups) {
  if (!groups.some((g) => g.value > 0)) return '<p class="hint">這一天沒有資料。</p>';
  return '<div class="treemap"></div>';
}

/**
 * 把塊畫進盒子裡。
 *
 * squarify 一定要在盒子「真實的長寬」裡算，不能在 100×100 的百分比空間裡算完再拉開：
 * 正方形裡排得漂漂亮亮的一組方塊，拉成 3:1 之後每一塊都會跟著橫向拉長三倍。
 * 手機的地圖接近正方形所以看不出來，桌機滿版就整片扁掉了——這是實際踩過的坑。
 * 算完再換算成百分比，之後盒子微幅縮放才不需要重畫。
 */
function paintTreemap(box, groups, w, h) {
  const items = groups.filter((g) => g.value > 0).sort((a, b) => b.value - a.value);
  const tiles = squarify(items, { x: 0, y: 0, w, h });
  box.innerHTML = tiles.map((t) => {
    const cls = t.flow === null ? 'flat' : trend(t.flow);
    // 增減幅度對到 0.12～0.68 的底色濃度；60% 以上一律最濃
    const ink = t.flowPct === null ? 0.1 : 0.12 + Math.min(1, Math.abs(t.flowPct) / 60) * 0.56;
    const amount = t.flow === null ? 'NEW' : `${t.flow > 0 ? '+' : ''}${okuText(t.flow)}`;
    const pc = (v, all) => `${((v / all) * 100).toFixed(3)}%`;
    return `<div class="tile ${cls}" style="left:${pc(t.x, w)};top:${pc(t.y, h)};
        width:${pc(t.w, w)};height:${pc(t.h, h)};--ink:${ink.toFixed(2)}"
        title="${esc(t.name)}｜${okuText(t.value)}｜${amount}">
      <b>${esc(t.name)}</b><span>${amount}</span>
    </div>`;
  }).join('');
  fitTiles(box);
}

/**
 * 塊太小就把字收起來，只留 title 的提示。
 *
 * 塊是用百分比定位的，但「放不放得下字」是絕對尺寸的問題，所以一定要等畫出來
 * 以後量真實的 px——照假設的螢幕寬度去估的話，寬螢幕上明明放得下的格子也會被
 * 判成放不下（本來就是這樣寫壞的）。量完只加 class，不重排版面。
 */
function fitTiles(root) {
  root.querySelectorAll('.tile').forEach((el) => {
    const { width, height } = el.getBoundingClientRect();
    const name = el.querySelector('b');
    const num = el.querySelector('span');

    // 名字被切成「軍工 · 航太…」還讀得懂，金額被切成「+120…」卻會被誤讀成別的數字，
    // 所以金額只有在最小字級也塞得下時才顯示，塞不下就整個不出現。
    const numEm = emWidth(num.textContent);
    const numSize = Math.min(NAME_MAX - 2, Math.floor((width - TILE_PAD) / numEm), Math.floor(height / 3.4));
    const showNum = numSize >= 9;
    el.classList.toggle('no-num', !showNum);

    const fit = fitName(width, height, emWidth(name.textContent), showNum);
    el.classList.toggle('no-text', fit.size < NAME_MIN);
    el.style.setProperty('--name-size', `${fit.size}px`);
    el.style.setProperty('--lines', fit.lines);
    el.style.setProperty('--num-size', `${Math.max(9, numSize)}px`);
  });
}

const TILE_PAD = 12;      // .tile 的左右內距 5px 加上外框 1px，兩邊共 12px
const NAME_MAX = 13;      // 再大就跟卡片標題搶戲了
const NAME_MIN = 8;       // 比這小就不如不顯示，讓 title 去講

/**
 * 粗估一串字佔幾個「字寬」。中日韓字元算一個，英數與半形符號約 0.55 個——
 * 「-244 億」全照中文字寬算會比實際寬一倍，窄格子上的金額就會被誤判成放不下。
 */
function emWidth(text) {
  let em = 0;
  for (const ch of text) em += /[　-〿㐀-鿿＀-￯]/.test(ch) ? 1 : 0.55;
  return em || 1;
}

/**
 * 找塞得下的最大字級，以及那個字級需要折幾行。
 *
 * 同一個名字折一行、兩行、三行，能用的字級差很多，哪一種最好完全看塊的形狀：
 * 「文化創意業」在 43x38 的塊裡擠一行只能用 9px 還會被切，折兩行可以用 10px；
 * 「電器電纜」在 25x47 這種高瘦的塊裡，一個字一行直著排反而讀得到。
 *
 * 由大到小試，行數一定要用「一行塞得下幾個字」回推——直接拿寬度除以字數會算出
 * 小數個字，然後 CSS 實際折出來的行數比算的多，多出來的那行就被 line-clamp 切掉。
 */
function fitName(width, height, em, showNum) {
  const usableW = width - TILE_PAD;
  const usableH = height - (showNum ? 13 : 0) - 4;      // 扣掉金額那行與上下內距
  for (let size = NAME_MAX; size >= NAME_MIN; size--) {
    const perLine = Math.floor(usableW / size);         // 一行放得下幾個字
    if (perLine < 1) continue;
    const lines = Math.ceil(em / perLine);
    if (lines <= 4 && lines * size * 1.2 <= usableH) return { size, lines };
  }
  return { size: NAME_MIN - 1, lines: 1 };              // 連最小字級都塞不下
}

/**
 * 盯著兩張圖的盒子，尺寸一變就照新的長寬重畫。
 *
 * 地圖的排版、四象限的字級與泡泡都是拿盒子的真實長寬算出來的，所以不能只在
 * 第一次畫的時候算：手機轉向、視窗拉寬、側邊欄收合都會換一個長寬比，得整張重畫。
 * 用 ResizeObserver 而不是 window 的 resize，因為盒子變大變小不一定是視窗造成的，
 * 而且 observe() 一掛上就會先送一次。
 */
let chartObserver = null;

function watchFlowCharts(view, groups) {
  if (chartObserver) chartObserver.disconnect();     // 上一次 render 的觀察對象已經不在了
  const charts = [
    [$('.treemap', view), (box, w, h) => paintTreemap(box, groups, w, h)],
    [$('.quad-box', view), (box, w, h) => {
      const svg = quadrant(groups, w, h);
      // 畫不出來時只剩一行提示，這時候別讓盒子還撐著半個螢幕高的空白
      box.classList.toggle('empty', svg[0] !== '<' || svg[1] !== 's');
      box.innerHTML = svg;
    }],
  ].filter(([box]) => box);
  if (!charts.length) return;

  const last = new Map();
  const paint = () => charts.forEach(([box, draw]) => {
    const { width, height } = box.getBoundingClientRect();
    const size = `${Math.round(width)}x${Math.round(height)}`;
    if (!width || !height || size === last.get(box)) return;   // 沒變就不重畫，也擋掉自己觸發自己
    last.set(box, size);
    draw(box, width, height);
  });

  // 尺寸有時候會分兩步到位（媒體查詢換了長寬比、手機轉向的中間狀態），
  // 只認第一次量到的就會定在中間那個尺寸上。下一幀再確認一次，沒變就是空操作。
  const settle = () => {
    paint();
    if (window.requestAnimationFrame) requestAnimationFrame(paint);
  };

  // 先自己畫一次：背景分頁不會跑 ResizeObserver（連 rAF 都不跑），
  // 但 getBoundingClientRect() 照樣算得出來，切回來時才不會是一片空白。
  settle();
  if (!window.ResizeObserver) return;
  chartObserver = new ResizeObserver(settle);
  charts.forEach(([box]) => chartObserver.observe(box));
}

/*
 * 四象限的畫布就是盒子的真實像素，1 單位＝1px：字級寫 11 畫出來就是 11px。
 *
 * 原本是固定 360×300 的 viewBox 交給 CSS 等比拉大，桌機上字、泡泡、瞄準框
 * 會一起脹成 1.7 倍，所以只好限寬 620px 擺在正中間，右邊一整片螢幕空著。
 * 改成 1:1 之後，多出來的寬度全變成散開的空間：泡泡不再擠成一坨，
 * 標得出名字的族群也跟著變多——那正是這張圖最想給的東西。
 */
const QUAD_BASE = { w: 360, h: 300 };   // 手機的基準畫布，字級與泡泡都以它當 1 倍
const NAMED_ALWAYS = 6;   // 前幾大的族群一定要有名字，就算得把字壓在泡泡上

/**
 * 畫布多大，字、留白、泡泡就該多大——但三者放大的速度不一樣。
 *
 * 字幾乎不動（10→14 就到頂，桌機的字再大會變成海報），留白跟著字走
 * （它存在的理由就是放得下刻度），泡泡照面積開根號放大：泡泡是用面積在講話，
 * 畫布大了還維持手機的尺寸，滿版的桌機看起來會像沒有資料。
 */
function quadGeom(w, h) {
  // 用面積開根號當「畫布有多大」，不能用寬或高：桌機的圖又寬又扁，
  // 拿高度算會判成小畫布，拿寬度算又會在 800px 的平板上就直接頂到最大。
  const side = Math.sqrt(w * h) / Math.sqrt(QUAD_BASE.w * QUAD_BASE.h);
  const name = Math.min(14, Math.max(10, Math.round(10 + (side - 1) * 2)));   // 每大半個手機加 1px
  const small = Math.round(name * 0.85 * 10) / 10;
  return {
    w, h, name, small,
    u: name / 10,                       // 瞄準框、箭頭、間距這類裝飾尺寸的縮放
    dot: Math.min(2.4, Math.max(1, side)),
    l: Math.round(small * 3.6),         // 左邊留給縱軸刻度
    r: Math.round(small * 1.7),
    t: Math.round(small * 1.7),
    b: Math.round(small * 3.5),         // 底下兩行：橫軸刻度與軸名
  };
}

/**
 * 座標軸上限。取第 85 百分位而不是最大值：一兩檔冷門族群成交值翻三倍是常有的事，
 * 拿它當上限會把其餘二十幾族全擠在中間一坨。超出範圍的點貼在邊緣，數字仍在 tooltip 裡。
 * 另給一個下限，免得沒什麼波動的日子被放大成雜訊。
 */
function axisMax(values, floor) {
  const sorted = values.map((v) => Math.abs(v)).sort((a, b) => a - b);
  const p85 = sorted[Math.min(sorted.length - 1, Math.floor(0.85 * sorted.length))];
  return Math.max(floor, p85) * 1.15;
}

/**
 * 一段文字實際佔掉的方框。y 是 baseline，字往上長，往下只留一點給標點的收尾；
 * 兩側各留 1px，免得兩個標籤剛好切齊時看起來黏在一起。
 */
function labelBox(x, y, text, anchor, size) {
  const w = emWidth(text) * size;
  const left = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
  return { x1: left - 1, x2: left + w + 1, y1: y - size * 0.8, y2: y + size * 0.25 };
}

/**
 * 量價四象限。橫軸是成交值增減（量），縱軸是成交值加權漲跌（價），
 * 泡泡大小是成交值，顏色是佔比位移——四個維度都是同一天的同一批數字。
 * w、h 是盒子量出來的真實像素，由 watchFlowCharts() 餵進來。
 */
function quadrant(groups, w, h) {
  const pts = groups.filter((g) => g.flowPct !== null && g.chg !== null && g.value > 0);
  if (pts.length < 2) return '<p class="hint">可比較的族群太少，畫不出四象限。</p>';

  const Q = quadGeom(w, h);
  const maxX = axisMax(pts.map((p) => p.flowPct), 25);
  const maxY = axisMax(pts.map((p) => p.chg), 2);
  const maxV = Math.max(...pts.map((p) => p.value));
  const innerW = Q.w - Q.l - Q.r;
  const innerH = Q.h - Q.t - Q.b;
  const clamp = (v, max) => Math.max(-1, Math.min(1, v / max)) * 0.9;   // 0.9：貼邊的泡泡不要被切一半
  const px = (v) => Q.l + ((clamp(v, maxX) + 1) / 2) * innerW;
  const py = (v) => Q.t + ((1 - clamp(v, maxY)) / 2) * innerH;
  const cx = px(0);
  const cy = py(0);

  // 四角的字往內縮，把最外圈讓給瞄準框
  const inset = 16 * Q.u;
  const corners = [
    { x: Q.w - Q.r - inset, y: Q.t + Q.small * 1.65, anchor: 'end', text: '量增價漲 · 資金進駐' },
    { x: Q.l + inset, y: Q.t + Q.small * 1.65, anchor: 'start', text: '量縮價漲 · 惜售' },
    { x: Q.w - Q.r - inset, y: Q.h - Q.b - Q.small, anchor: 'end', text: '量增價跌 · 出貨' },
    { x: Q.l + inset, y: Q.h - Q.b - Q.small, anchor: 'start', text: '量縮價跌 · 棄守' },
  ];

  const marks = pts.slice().sort((a, b) => b.value - a.value).map((p) => ({
    p, x: px(p.flowPct), y: py(p.chg), r: (3 + Math.sqrt(p.value / maxV) * 13) * Q.dot,
  }));

  /**
   * 標名字。不限幾個，塞得下就標——原本只標前六大，右半邊一整片空地就這樣空著，
   * 而離群的小族群正是最想知道名字的那種。上、下、右、左四個位置依序試，
   * 條件是不壓到別人的字、不壓到任何泡泡，四個都不行就不標：名字疊在一起等於兩個都讀不到。
   * 例外是前 NAMED_ALWAYS 大的族群，它們擠在一坨裡永遠找不到乾淨的位置，
   * 但少了名字整張圖就沒有錨點，所以放寬成「只要不壓到別人的字」，靠字的白邊讀出來。
   */
  const placed = corners.map((c) => labelBox(c.x, c.y, c.text, c.anchor, Q.small));
  const clearOfText = (box) => box.x1 >= Q.l + 2 && box.x2 <= Q.w - Q.r - 2
    && box.y1 >= Q.t + 2 && box.y2 <= Q.h - Q.b - 2
    && !placed.some((q) => box.x1 < q.x2 && box.x2 > q.x1 && box.y1 < q.y2 && box.y2 > q.y1);
  const clearOfDots = (box) => !marks.some((m) => {
    const nx = Math.max(box.x1, Math.min(m.x, box.x2));     // 矩形上離圓心最近的點
    const ny = Math.max(box.y1, Math.min(m.y, box.y2));
    return (nx - m.x) ** 2 + (ny - m.y) ** 2 < m.r * m.r;
  });

  const nameOf = (m, i) => {
    const gap = m.r + 4 * Q.u;
    const candidates = [
      { x: m.x, y: m.y - gap, anchor: 'middle' },
      { x: m.x, y: m.y + gap + Q.name * 0.8, anchor: 'middle' },
      { x: m.x + gap, y: m.y + Q.name * 0.35, anchor: 'start' },
      { x: m.x - gap, y: m.y + Q.name * 0.35, anchor: 'end' },
    ];
    const boxes = candidates.map((c) => ({ c, box: labelBox(c.x, c.y, m.p.name, c.anchor, Q.name) }));
    const pick = boxes.find((b) => clearOfText(b.box) && clearOfDots(b.box))
      || (i < NAMED_ALWAYS ? boxes.find((b) => clearOfText(b.box)) : null);
    if (!pick) return '';
    placed.push(pick.box);
    return `<text class="q-name" x="${pick.c.x.toFixed(1)}" y="${pick.c.y.toFixed(1)}"
           text-anchor="${pick.c.anchor}">${esc(m.p.name)}</text>`;
  };

  /*
   * 一顆泡泡畫三層：主體、外面一圈虛線瞄準環、中心一個實心點。
   * 環與點只給大顆的——小泡泡本來就只有幾個 px，再加東西就變成一團髒點。
   * 中心點還有個實用的好處：一堆泡泡疊在一起時，圓心在哪一眼看得出來。
   */
  const dots = marks.map((m, i) => {
    const p = m.p;
    const cls = p.shift === null ? 'flat' : trend(p.shift);
    const shiftText = p.shift === null ? '—' : `${p.shift > 0 ? '+' : ''}${p.shift.toFixed(2)}pp`;
    const c = `cx="${m.x.toFixed(1)}" cy="${m.y.toFixed(1)}"`;
    const ring = m.r >= 7 * Q.dot ? `<circle class="q-ring" ${c} r="${(m.r + 2.8 * Q.u).toFixed(1)}"/>` : '';
    const pip = m.r >= 6 * Q.dot ? `<circle class="q-pip" ${c} r="${(1.15 * Q.u).toFixed(2)}"/>` : '';
    return `<g class="q-dot ${cls}" style="--d:${(i * 26).toFixed(0)}ms">`
      + `<title>${esc(p.name)}｜成交值 ${signedPct(p.flowPct)}｜`
      + `加權 ${signedPct(p.chg, 2)}｜佔比 ${shiftText}</title>`
      + `${ring}<circle class="q-body" ${c} r="${m.r.toFixed(1)}"/>${pip}${nameOf(m, i)}</g>`;
  }).join('');

  // 網格切八等分，正中間那條剛好落在零軸上，所以格線本身就是「離零多遠」的刻度。
  const gx = innerW / 8;
  const gy = innerH / 8;

  // 四角的瞄準框。往內縮避開圓角，兩支腳各 9px（跟著畫布縮放），指向框內。
  const arm = 9 * Q.u;
  const bracket = (x, y, sx, sy) => `<path class="q-hud" d="M${(x + sx * arm).toFixed(1)} ${y.toFixed(1)}`
    + ` H${x.toFixed(1)} V${(y + sy * arm).toFixed(1)}"/>`;
  const bx0 = Q.l + 4 * Q.u;
  const bx1 = Q.w - Q.r - 4 * Q.u;
  const by0 = Q.t + 4 * Q.u;
  const by1 = Q.h - Q.b - 4 * Q.u;
  const ah = 2.6 * Q.u;         // 箭頭的半高，也是原點圈的半徑

  // 兩個角落的暈色：右上是資金進駐、左下是棄守，讓人不必讀完角落的字也知道哪邊是哪邊。
  // 淡到只剩暗示的程度——泡泡的紅綠是另一件事（佔比位移），不能讓底色搶了它的話。
  return `<svg class="quad" viewBox="0 0 ${Q.w.toFixed(1)} ${Q.h.toFixed(1)}"
    style="--q-fs:${Q.name}px;--q-fs-s:${Q.small}px" role="img" aria-label="量價四象限散佈圖">
    <defs>
      <clipPath id="q-clip"><rect x="${Q.l}" y="${Q.t}" width="${innerW}" height="${innerH}" rx="8"/></clipPath>
      <linearGradient id="q-panel" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" class="q-panel-a"/><stop offset="1" class="q-panel-b"/>
      </linearGradient>
      <pattern id="q-mesh" x="${Q.l}" y="${Q.t}" width="${gx.toFixed(2)}" height="${gy.toFixed(2)}"
               patternUnits="userSpaceOnUse">
        <path class="q-mesh-line" d="M${gx.toFixed(2)} 0 H0 V${gy.toFixed(2)}"/>
      </pattern>
      <radialGradient id="q-zone-up" cx="1" cy="0" r="1">
        <stop offset="0" class="q-stop-up"/><stop offset="1" class="q-stop-up q-stop-out"/>
      </radialGradient>
      <radialGradient id="q-zone-down" cx="0" cy="1" r="1">
        <stop offset="0" class="q-stop-down"/><stop offset="1" class="q-stop-down q-stop-out"/>
      </radialGradient>
    </defs>
    <rect class="q-plot" x="${Q.l}" y="${Q.t}" width="${innerW}" height="${innerH}" rx="8"
          fill="url(#q-panel)"/>
    <g clip-path="url(#q-clip)">
      <rect x="${Q.l}" y="${Q.t}" width="${innerW}" height="${innerH}" fill="url(#q-mesh)"/>
      <rect class="q-zone up" x="${cx}" y="${Q.t}" width="${Q.w - Q.r - cx}" height="${cy - Q.t}"/>
      <rect class="q-zone down" x="${Q.l}" y="${cy}" width="${cx - Q.l}" height="${Q.h - Q.b - cy}"/>
    </g>
    ${bracket(bx0, by0, 1, 1)}${bracket(bx1, by0, -1, 1)}
    ${bracket(bx0, by1, 1, -1)}${bracket(bx1, by1, -1, -1)}
    ${corners.map((c) => `<text class="q-corner" x="${c.x.toFixed(1)}" y="${c.y.toFixed(1)}" text-anchor="${c.anchor}">${c.text}</text>`).join('')}
    <line class="q-axis" x1="${Q.l}" y1="${cy}" x2="${Q.w - Q.r}" y2="${cy}"/>
    <line class="q-axis" x1="${cx}" y1="${Q.t}" x2="${cx}" y2="${Q.h - Q.b}"/>
    <path class="q-arrow" d="M${Q.w - Q.r - ah * 1.7} ${cy - ah} L${Q.w - Q.r} ${cy} L${Q.w - Q.r - ah * 1.7} ${cy + ah} Z"/>
    <path class="q-arrow" d="M${cx - ah} ${Q.t + ah * 1.7} L${cx} ${Q.t} L${cx + ah} ${Q.t + ah * 1.7} Z"/>
    <circle class="q-origin" cx="${cx}" cy="${cy}" r="${ah.toFixed(1)}"/>
    ${dots}
    <text class="q-tick" x="${Q.l - Q.small * 0.5}" y="${cy + Q.small * 0.35}" text-anchor="end">0</text>
    <text class="q-tick" x="${Q.w - Q.r}" y="${Q.h - Q.b + Q.small * 1.4}" text-anchor="end">成交值 +${maxX.toFixed(0)}%</text>
    <text class="q-tick" x="${Q.l}" y="${Q.h - Q.b + Q.small * 1.4}" text-anchor="start">−${maxX.toFixed(0)}%</text>
    <text class="q-tick" x="${Q.l - Q.small * 0.5}" y="${Q.t + Q.small}" text-anchor="end">+${maxY.toFixed(1)}%</text>
    <text class="q-tick" x="${Q.l - Q.small * 0.5}" y="${Q.h - Q.b}" text-anchor="end">−${maxY.toFixed(1)}%</text>
    <text class="q-tick q-axis-title" x="${Q.w / 2}" y="${Q.h - Q.small * 0.45}" text-anchor="middle">橫軸：成交值增減　縱軸：成交值加權漲跌</text>
  </svg>`;
}

/** 這一族落在量價四象限的哪一角：成交值增減看橫軸、加權漲跌看縱軸。 */
function quadText(g) {
  if (g.flowPct === null || g.chg === null) return '';
  return `${g.flowPct >= 0 ? '量增' : '量縮'}${g.chg >= 0 ? '價漲' : '價跌'}`;
}

/**
 * 流向頁的一句話。兩張圖各講一半——地圖講錢在哪裡、四象限講這些錢是買上去還是
 * 砍下來——這一句的工作就是把兩半接起來：最大的一族是誰，動得最多的那兩族
 * 各自落在哪一個象限。
 */
function flowSay(groups, top, bottom, totalFlowPct, marketChg, baseDate) {
  const real = groups.filter((g) => g.name !== UNGROUPED_LABEL && g.value > 0);
  const biggest = real.length ? real.reduce((a, b) => (b.value > a.value ? b : a)) : null;
  const corner = (g) => (quadText(g) ? `（${quadText(g)}）` : '');
  const stats = [
    { b: signedPct(totalFlowPct), span: '榜上整體增減', cls: `sm ${trend(totalFlowPct)}` },
    { b: signedPct(marketChg, 2), span: '成交值加權漲跌', cls: `sm ${trend(marketChg)}` },
    { b: esc(top.name), cls: `sm ${trend(top.flow)}`,
      span: `${top.flow > 0 ? '流入最多 +' : '減少最少 '}${okuText(top.flow)}` },
    { b: esc(bottom.name), cls: `sm ${trend(bottom.flow)}`,
      span: `${bottom.flow < 0 ? '流出最多 ' : '增加最少 +'}${okuText(bottom.flow)}` },
  ];
  return takeaway(
    `對比 ${baseDate}，榜上整體 ${tint(totalFlowPct, signedPct(totalFlowPct))}、
     成交值加權 ${tint(marketChg, signedPct(marketChg, 2))}；${biggest
      ? `地圖上最大的一族是 <b>${esc(biggest.name)}</b>，一族就佔榜上 ${num(biggest.share)}%；` : ''}
     ${top.flow > 0 ? '資金流入最多的' : '資金減少最少的'}是 <b>${esc(top.name)}</b>${corner(top)}，
     ${bottom.flow < 0 ? '流出最多的' : '增加最少的'}是 <b>${esc(bottom.name)}</b>${corner(bottom)}。`,
    `${state.date} 前 ${TOP} 大`, stats);
}

async function renderFlow(view) {
  const mode = groupingMode();
  if (!mode) {
    view.innerHTML = '<p class="hint">沒有分類資料，請先執行 scripts/fetch_industry.py。</p>';
    return;
  }

  const { baseDate, topStocks, totalValue, groups, totalFlowPct, marketChg }
    = await collectFlows(mode);
  if (!baseDate) {
    view.innerHTML = '<p class="hint">這是最早的一天，沒有可以比較的基準日。</p>';
    return;
  }

  // 只有比得出增減的才排得出「流入／流出最多」；新進榜的沒有基準，不參與
  const ranked = groups.filter((g) => g.flow !== null).sort((a, b) => b.flow - a.flow);
  const top = ranked[0];
  const bottom = ranked[ranked.length - 1];
  const gone = groups.filter((g) => g.gone);
  const fresh = groups.filter((g) => g.flow === null);
  const ungrouped = groups.find((g) => g.name === UNGROUPED_LABEL)?.count || 0;

  view.innerHTML = `
    <div class="controls">
      ${hasIndustry() && hasThemes() ? pills('grouping', GROUPINGS, mode) : ''}
      ${pills('baseline', BASELINES, state.baseline)}
    </div>
    ${flowSay(groups, top, bottom, totalFlowPct, marketChg, baseDate)}
    <section class="card">
      <h2>資金地圖 <small>${state.date} vs ${baseDate} · 面積＝成交值，顏色＝資金增減</small></h2>
      <div class="map-box">${treemap(groups)}</div>
      <p class="note">整體 ${signedPct(totalFlowPct)}（${okuText(totalValue)}）。
        紅＝資金流入、綠＝流出，顏色越濃代表增減幅度越大——用幅度不用金額上色，
        小族群翻倍才不會被大族群的量體洗掉。整族退出前 ${TOP} 大的族群面積是 0，地圖上看不到，
        ${gone.length ? `今天有 ${gone.map((g) => esc(g.name)).join('、')}。` : '今天沒有。'}
        ${mode === 'theme' ? '題材族群一檔可屬多個族群，重疊的部分兩邊都算，所以地圖總面積會大於榜上總額——比的是彼此的相對大小，不是切分同一塊餅。' : ''}</p>
    </section>
    <section class="card">
      <h2>量價四象限 <small>泡泡大小＝成交值，顏色＝佔比位移</small></h2>
      <div class="map-box"><div class="quad-box"></div></div>
      <p class="note">右邊是量增、上面是價漲。右上角是量價齊揚的資金進駐，右下角是爆量下殺的出貨，
        兩者的成交值都在變大，方向卻相反——這就是為什麼光看成交值不能當成「買盤」。
        泡泡的紅綠是佔榜上比重的位移，紅色代表錢確實往這一族集中。
        座標軸取第 85 百分位當上限，超出範圍的族群貼在邊緣（真實數字在長按／滑過的提示裡）。
        ${fresh.length ? `新進榜的 ${fresh.map((g) => esc(g.name)).join('、')}沒有比較基準，不在圖上。` : ''}</p>
      <p class="note">${groupingNote(mode, topStocks.length, ungrouped)}
        要看每一族的細項與成分股，切到「族群」分頁。</p>
    </section>
`;

  watchFlowCharts(view, groups);
}

// --------------------------------------------------------------------------
// 分頁五：大盤（成交值走勢與資金集中度）
// --------------------------------------------------------------------------
const SPANS = [
  { value: 60, label: '60 日' },
  { value: 120, label: '120 日' },
  { value: 9999, label: '全部' },
];

/** a[i] / b[i] 的百分比；b 為 0 時給 null，圖上會斷線而不是畫成 0。 */
function ratioSeries(a, b) {
  return a.map((v, i) => (b[i] ? Math.round((v / b[i]) * 1000) / 10 : null));
}

function signed(pct) {
  if (pct === null) return '—';
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

/**
 * 大盤頁的一句話。今天的集中度單看一個百分比沒有意義，要跟這段期間的平均比，
 * 才知道錢是比平常更集中在少數幾檔，還是散到更多股票上去。
 */
function marketSay(labels, shares, shareNow, top10Now, value, dod) {
  // 樣本太少時平均值幾乎就是今天自己，拿來對照沒有意義，寧可不講這一句
  const known = shares.filter((v) => v !== null);
  const avg = known.length >= 5 ? known.reduce((a, b) => a + b, 0) / known.length : null;
  const gap = avg === null || shareNow === null ? null : shareNow - avg;
  const stats = [
    { b: num(value, 0), span: `${scopeLabel()}成交值（億）` },
    { b: signed(dod), span: '對比前一日', cls: trend(dod) },
    { b: `${num(shareNow)}%`, span: `前 ${TOP} 大佔比` },
    ...(gap === null ? [] : [{
      b: `${gap > 0 ? '+' : ''}${num(gap)}pp`,
      span: `集中度對比 ${labels.length} 日均`,
      cls: trend(gap),
    }]),
  ];
  const note = `成交值是本站追蹤範圍（普通股與 ETF，已排除權證等商品）的合計，
    與交易所公布的市場總成交值會有小幅差異。`;
  const mood = gap === null
    ? ''
    : Math.abs(gap) < 0.5
      ? `跟近 ${labels.length} 個交易日的平均 ${num(avg)}% 差不多，集中度沒什麼變`
      : gap > 0
        ? `比近 ${labels.length} 個交易日的平均 ${num(avg)}% 高 ${num(gap)} 個百分點，錢比平常更集中在少數幾檔`
        : `比近 ${labels.length} 個交易日的平均 ${num(avg)}% 低 ${num(-gap)} 個百分點，錢比平常更擴散`;
  return takeaway(
    `${state.date} ${esc(scopeLabel())}成交值 <b>${num(value, 0)} 億</b>，對比前一日
     ${tint(dod, signed(dod))}；前 ${TOP} 大佔 ${num(shareNow)}%、前 10 大佔 ${num(top10Now)}%${
      mood ? `，${mood}` : ''}。`,
    `${state.date} 市場概況 · ${scopeLabel()}`, stats, note);
}

async function renderMarket(view) {
  const idx = state.index;
  const ser = idx.scopes && scopeSeries();
  if (!ser) {
    view.innerHTML = '<p class="hint">index.json 格式是舊的，請重新執行 scripts/build_history.py。</p>';
    return;
  }

  const at = idx.dates.indexOf(state.date);          // 目前選定日在全序列中的位置
  const from = Math.max(0, at + 1 - state.span);
  const labels = idx.dates.slice(from, at + 1);
  const cut = (arr) => arr.slice(from, at + 1);

  const market = cut(ser.marketValues);
  const top200 = cut(ser.top200Values);
  const top10 = cut(ser.top10Values);

  const dod = at > 0 && ser.marketValues[at - 1]
    ? ((ser.marketValues[at] - ser.marketValues[at - 1]) / ser.marketValues[at - 1]) * 100
    : null;
  const share = (v) => (ser.marketValues[at] ? (v / ser.marketValues[at]) * 100 : null);

  view.innerHTML = `
    <div class="controls">${pills('span', SPANS, state.span)}</div>
    ${marketSay(labels, ratioSeries(top200, market), share(ser.top200Values[at]),
      share(ser.top10Values[at]), ser.marketValues[at], dod)}
    <section class="card">
      <h2>成交值走勢 <small>億元</small></h2>
      <div class="chart-box"><canvas id="c-market"></canvas></div>
    </section>
    <section class="card">
      <h2>資金集中度 <small>前 N 大佔大盤成交值的比重</small></h2>
      <div class="chart-box"><canvas id="c-share"></canvas></div>
      <p class="note">往上代表錢集中到少數幾檔，往下代表資金擴散到更多股票。</p>
    </section>`;

  try {
    const Chart = await loadChartJs();
    drawLine(Chart, $('#c-market'), labels, [
      { data: market, color: LINE.market, label: scopeLabel() },
      { data: top200, color: LINE.top200, label: '前 200 大' },
    ], { emptyText: '無資料' });
    drawLine(Chart, $('#c-share'), labels, [
      { data: ratioSeries(top200, market), color: LINE.top200, label: '前 200 大' },
      { data: ratioSeries(top10, market), color: LINE.top10, label: '前 10 大' },
    ], { suffix: '%', emptyText: '無資料' });
  } catch (err) {
    document.querySelectorAll('.chart-box').forEach((box) => {
      box.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
    });
  }
}

// --------------------------------------------------------------------------
// 分頁：報價
//
// 追蹤上游產品的公開報價（記憶體、面板、太陽能、鋰電池材料）、原物料成本
// （銅、金、銀、鈀、鋁、原油）與大環境（費半、美元台幣），資料由
// scripts/fetch_quotes.py 抓、scripts/build_quotes.py 算成 data/quotes/。
//
// 三件必須寫在畫面上、不能只寫在註解裡的事：
//   1. 被動元件與功率元件沒有可自動抓的公開成品報價 —— 這一頁給的是它們的上游
//      原料價（銅、銀、鈀、多晶矽），kind 是 cost 不是 price，兩者不能混為一談。
//   2. 報價的點距不等寬：現貨一天一點、合約一個月一點。那是報價自己的節奏，
//      不是資料缺漏，所以每張表都標自己的更新頻率與報價日。
//   3. 族群成交值只算「當天排進成交值前 300 名」的成分股，不是整族的全貌。
//
// 報價與族群要並排看的理由：報價是因，股價與成交值是果，但兩者不會同步——
// 報價漲了資金沒進來，或資金先進來報價才動，都是這一頁想讓人看見的落差。
// --------------------------------------------------------------------------

// value 是 index.json 裡 chg 的鍵；days 是族群成交值要往回推幾個交易日。
// 報價用日曆日算（報價不是每個交易日都動），族群用交易日算，兩者對不齊是必然的，
// 所以畫面上要把「近一月」與「20 個交易日前」兩種說法都寫出來。
const QUOTE_SPANS = [
  { value: 'prev', label: '較前次', days: 1, days_label: '前一個交易日' },
  { value: 'w1', label: '近一週', days: 5, days_label: '5 個交易日前' },
  { value: 'm1', label: '近一月', days: 20, days_label: '20 個交易日前' },
  { value: 'm3', label: '近三月', days: 60, days_label: '60 個交易日前' },
  { value: 'y1', label: '近一年', days: 240, days_label: '240 個交易日前' },
];

const QUOTE_CHART_SPANS = [
  { value: 90, label: '90 天' },
  { value: 365, label: '一年' },
  { value: 0, label: '全部' },
];

// kind 決定這條數字能不能被當成「這一族產品的報價」來讀。
const QUOTE_KINDS = {
  price: { label: '成品報價', tag: '' },
  cost: { label: '成本指標', tag: '成本' },
  index: { label: '指數／匯率', tag: '大環境' },
};

const CUR_NAMES = { USD: '美元', RMB: '人民幣', USX: '美分', TWD: '台幣', EUR: '歐元', JPY: '日圓' };

// 報價與族群成交值要疊在同一張圖上，兩條線的顏色不能跟排名／大盤那組撞。
const QLINE = { quote: '#f79009', theme: '#2f6fed' };

const SPARK_MAX = 60;          // 迷你走勢最多畫幾個點，再多在 68px 寬裡也看不出來

/** 統計格的標籤塞不下整個品項名時切短。切掉的地方要留刪節號，不然看起來像原本就叫那個名字。 */
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function loadQuoteIndex() {
  // 報價的更新頻率與交易日無關（合約價半個月才動一次），一律抓最新的目錄，
  // 序列檔則是內容幾乎不變的大檔，照常吃快取。
  if (!state.quotes) state.quotes = getJSON(`${DATA}/quotes/index.json`, { cache: 'reload' });
  return state.quotes;
}

function loadQuoteSeries(cat) {
  if (!state.quoteSeries.has(cat)) {
    state.quoteSeries.set(cat, getJSON(`${DATA}/quotes/series/${cat}.json`).catch(() => null));
  }
  return state.quoteSeries.get(cat);
}

/** 報價的位數要跟著級距走：0.33 元的電池片與 4,405 元的黃金不能用同一種格式。 */
function quoteNum(v) {
  if (v === null || v === undefined) return '—';
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 10 ? 2 : 3;
  return v.toLocaleString('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 幣別與單位合成一句。單位裡已經寫了幣別（「美元／顆」）就不要再重複一次。 */
function quoteUnit(item) {
  const cur = CUR_NAMES[item.cur] || item.cur || '';
  if (!item.unit) return cur;
  if (!cur || item.unit.includes(cur)) return item.unit;
  return `${cur} ${item.unit}`;
}

const quoteSpanSpec = () =>
  QUOTE_SPANS.find((s) => s.value === state.quoteSpan) || QUOTE_SPANS[2];

/** 某個期間的漲跌幅；那個期間湊不出基準（序列還太短）就回 null。 */
function quoteChg(item, key = state.quoteSpan) {
  const v = item.chg ? item.chg[key] : undefined;
  return v === undefined || v === null ? null : v;
}

/**
 * 迷你走勢。只有兩個點以上才畫得出線，一個點的品項留白 ——
 * 畫一條平的假線會讓人以為那個報價這段時間沒有動過。
 */
function sparkline(values) {
  const w = 68;
  const h = 24;
  const pts = values.length > SPARK_MAX ? values.slice(-SPARK_MAX) : values;
  if (pts.length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"></svg>`;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const line = pts
    .map((v, i) => {
      const x = 1 + (i / (pts.length - 1)) * (w - 2);
      const y = h - 1 - ((v - min) / span) * (h - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return `<svg class="spark ${trend(pts[pts.length - 1] - pts[0])}" viewBox="0 0 ${w} ${h}"
    preserveAspectRatio="none" aria-hidden="true"><polyline points="${line}"/></svg>`;
}

function quoteRow(item, values, { withTable = true } = {}) {
  const chg = quoteChg(item);
  const kind = QUOTE_KINDS[item.kind] || QUOTE_KINDS.price;
  const sub = [withTable ? item.table : '', quoteUnit(item), kind.tag].filter(Boolean).join(' · ');
  return `<a class="row row--quote" href="#/quote/${encodeURIComponent(item.id)}">
    <div class="ident">
      <span class="name">${esc(item.name)}</span>
      <span class="code">${esc(sub)}</span>
    </div>
    ${sparkline(values)}
    <div class="figures">
      <span class="value">${quoteNum(item.last.v)}</span>
      <span class="price"><em class="${trend(chg)}">${signedPct(chg, 2)}</em> ${esc(quoteSpanSpec().label)}</span>
    </div>
  </a>`;
}

/**
 * 這一頁的一句話。挑的是「這個期間誰動得最多」——報價的意義在變化，
 * 不在絕對值（0.33 人民幣的電池片與 4,405 美元的黃金比大小毫無意義）。
 */
function quoteSay(items, movers, latest) {
  const spec = quoteSpanSpec();
  const graded = items.filter((i) => quoteChg(i) !== null);
  const up = graded.filter((i) => quoteChg(i) > 0).length;
  const down = graded.filter((i) => quoteChg(i) < 0).length;
  const top = movers.up[0] || null;
  const bottom = movers.down[0] || null;
  const costs = items.filter((i) => i.kind !== 'price').length;

  const stats = [
    { b: pair(up, down), span: `${esc(spec.label)}漲／跌（項）` },
    ...(top ? [{ b: signedPct(quoteChg(top), 1), span: esc(clip(top.name, 18)), cls: 'up' }] : []),
    ...(bottom ? [{ b: signedPct(quoteChg(bottom), 1), span: esc(clip(bottom.name, 18)), cls: 'down' }] : []),
    { b: `${items.length - costs} / ${items.length}`, span: '成品報價／全部品項' },
  ];

  const sentence = graded.length
    ? `以 ${esc(spec.label)}計，${items.length} 個追蹤品項裡有 ${graded.length} 項算得出變化，
       ${tint(1, `${up} 項在漲`)}、${tint(-1, `${down} 項在跌`)}${
        top ? `；漲最多的是 <b>${esc(top.name)}</b> ${tint(quoteChg(top), signedPct(quoteChg(top), 2))}` : ''}${
        bottom ? `，跌最多的是 <b>${esc(bottom.name)}</b> ${tint(quoteChg(bottom), signedPct(quoteChg(bottom), 2))}` : ''}。`
    : `${items.length} 個追蹤品項都還算不出 ${esc(spec.label)}的變化 ——
       TrendForce 的免費頁只給現在那一筆，歷史要靠每天累積（或先跑
       <code>scripts/backfill_quotes.py</code> 從網頁典藏館補一段）。`;

  const note = `被動元件（MLCC／晶片電阻）與功率元件（MOSFET／IGBT／SiC）沒有可自動抓的
    公開成品報價，這一頁能給的是它們的上游原料價：銅、銀、鈀與多晶矽，標成「成本」的那些。
    原料漲不等於成品漲得動 —— 漲價能不能轉嫁出去是另一件事，這一頁不回答那個問題。`;

  return takeaway(sentence, `最新報價日 ${latest}`, stats, note);
}

function quoteMovers(items) {
  const graded = items.filter((i) => quoteChg(i) !== null);
  const sorted = graded.slice().sort((a, b) => quoteChg(b) - quoteChg(a));
  return {
    up: sorted.filter((i) => quoteChg(i) > 0),
    down: sorted.filter((i) => quoteChg(i) < 0).reverse(),
  };
}

/**
 * 報價 × 族群。把每個大族群的「報價變化」與「這一族在台股的資金與價格反應」擺在一起。
 *
 * 報價取中位數而不是平均：同一族裡 DDR5 與 DDR3 的漲幅可以差一個數量級，
 * 平均會被單一品項帶著跑，中位數講的是「這一族大多數品項在做什麼」。
 *
 * 族群成交值取當天排進前 300 名的成分股合計 —— 名單外的個股本站沒有資料，
 * 所以這個數字是「這一族在榜上的部分」，不是整族的全貌。
 */
async function quoteThemeRows(items, spec) {
  if (!hasThemes()) return null;

  const buckets = new Map();
  for (const item of items) {
    for (const pair of item.themes || []) {
      const [group, sub] = pair;
      let bucket = buckets.get(group);
      if (!bucket) buckets.set(group, (bucket = { subs: new Set(), items: [] }));
      bucket.subs.add(sub);
      bucket.items.push(item);
    }
  }
  if (!buckets.size) return null;

  const baseDate = dateBack(spec.days);
  const [today, base] = await Promise.all([loadDaily(state.date), loadDaily(baseDate)]);
  const poolOf = (payload) =>
    new Map(payload ? payload.stocks.filter((s) => s.rank <= KEPT).map((s) => [s.code, s]) : []);
  const pool = poolOf(today);
  const basePool = poolOf(base);

  const rows = [];
  for (const [group, bucket] of buckets) {
    const codes = new Set();
    for (const sub of bucket.subs) for (const code of themeCodes(group, sub)) codes.add(code);
    const onBoard = [...codes].filter((c) => pool.has(c));
    const value = onBoard.reduce((n, c) => n + pool.get(c).value, 0);
    const baseOn = [...codes].filter((c) => basePool.has(c));
    const baseValue = baseOn.reduce((n, c) => n + basePool.get(c).value, 0);
    const moves = bucket.items
      .map((i) => quoteChg(i))
      .filter((v) => v !== null)
      .sort((a, b) => a - b);
    rows.push({
      group,
      quotes: bucket.items.length,
      graded: moves.length,
      mid: moves.length ? moves[(moves.length - 1) >> 1] : null,
      kinds: new Set(bucket.items.map((i) => i.kind)),
      value,
      // 金額增減而不是百分比：基準日沒進榜的成分股讓分母變得很小，
      // 百分比會被「進榜」本身放大成 +4700%，那不是資金真的變成 48 倍。
      flow: baseOn.length ? value - baseValue : null,
      chg: weightedChange(onBoard, pool),
      onBoard: onBoard.length,
      baseOn: baseOn.length,
      codes: codes.size,
    });
  }

  rows.sort((a, b) => {
    if (a.mid === null) return 1;
    if (b.mid === null) return -1;
    return Math.abs(b.mid) - Math.abs(a.mid);
  });
  return { rows, baseDate };
}

function quoteThemeCard(pack, spec) {
  if (!pack || !pack.rows.length) return '';
  const rows = pack.rows.map((r) => {
    const onlyCost = !r.kinds.has('price');
    return `<div class="row row--theme">
      <div class="ident">
        <span class="name">${esc(r.group)}</span>
        <span class="code">${r.quotes} 個品項${onlyCost ? '（只有成本指標）' : ''}
          · 榜上 ${r.onBoard}／${r.codes} 檔${r.baseOn === r.onBoard ? '' : `（基準日 ${r.baseOn} 檔）`}</span>
      </div>
      <div class="figures">
        <span class="value"><em class="${trend(r.mid)}">${signedPct(r.mid, 2)}</em></span>
        <span class="price">報價中位數</span>
      </div>
      <div class="figures">
        <span class="value"><em class="${trend(r.flow)}">${
          r.flow === null ? '—' : `${r.flow > 0 ? '+' : '-'}${okuText(Math.abs(r.flow))}`}</em></span>
        <span class="price">成交值 ${okuText(r.value)}</span>
      </div>
      <div class="figures">
        <span class="value"><em class="${trend(r.chg)}">${signedPct(r.chg, 2)}</em></span>
        <span class="price">加權漲跌</span>
      </div>
    </div>`;
  });
  return `<section class="card">
    <h2>報價 × 族群 <small>${esc(spec.label)}</small></h2>
    ${rows.join('')}
    <p class="note">左邊是報價（${esc(spec.label)}，取該族群所有品項的中位數），
      右邊三格是這一族在台股的反應：對比 ${esc(pack.baseDate || '—')}（${esc(spec.days_label)}）的
      成交值增減、${state.date} 的成交值，以及成交值加權漲跌幅。
      增減用金額不用百分比：成交值只含當天排進前 300 名的成分股，基準日在榜的檔數
      不一樣時（括號裡標出來的那些），百分比會被「進榜」本身放大成幾千 %。
      報價與成交值的期間也對不齊 —— 報價按日曆日算、成交值按交易日算，
      而報價本身不是每個交易日都會更新。</p>
  </section>`;
}

async function renderQuoteList(view, index) {
  const spec = quoteSpanSpec();
  const catPills = [
    { value: 'all', label: '全部' },
    ...index.cats.map((c) => ({ value: c.key, label: c.name })),
  ];
  const known = new Set(index.cats.map((c) => c.key));
  if (state.quoteCat !== 'all' && !known.has(state.quoteCat)) state.quoteCat = 'all';
  const inCat = state.quoteCat === 'all'
    ? index.items
    : index.items.filter((i) => i.cat === state.quoteCat);
  // stale 是「已經不在最新那張表上」的品項（見 build_quotes.py 的 mark_stale）。
  // 回補歷史一定會撈到一批停止報價的舊規格，混在清單裡看起來就像今天的數字。
  const picked = inCat.filter((i) => !i.stale);
  const retired = inCat.filter((i) => i.stale);

  // 迷你走勢要序列，序列一個品類一個檔；篩掉的品類就不必抓
  const cats = [...new Set(picked.map((i) => i.cat))];
  const loaded = await Promise.all(cats.map((c) => loadQuoteSeries(c)));
  const seriesByCat = new Map(cats.map((c, i) => [c, loaded[i]]));
  const valuesOf = (item) => {
    const series = seriesByCat.get(item.cat);
    if (!series || !series.items[item.id]) return [];
    return series.items[item.id].map((p) => p[1]);
  };

  const movers = quoteMovers(picked);
  const themePack = await quoteThemeRows(picked, spec);

  // 一張表一張卡：同一張表的所有品項共用報價日與更新頻率，寫在卡片標題上就好
  const byTable = new Map();
  for (const item of picked) {
    const key = `${item.cat}|${item.table}`;
    if (!byTable.has(key)) byTable.set(key, []);
    byTable.get(key).push(item);
  }

  const catName = (key) => (index.cats.find((c) => c.key === key) || {}).name || key;
  const tableCards = [...byTable.entries()].map(([key, group]) => {
    const [cat, table] = key.split('|');
    const asof = group.reduce((a, b) => (b.last.d > a ? b.last.d : a), group[0].last.d);
    const rows = group
      .slice()
      .sort((a, b) => (quoteChg(b) ?? -Infinity) - (quoteChg(a) ?? -Infinity))
      .map((item) => quoteRow(item, valuesOf(item), { withTable: false }));
    // 金屬與指數的「表」就是品類本身（一個品類一張卡），不要印成「金屬原料 · 金屬原料」
    const title = table === catName(cat) ? table : `${catName(cat)} · ${table}`;
    return listCard(title,
      `報價日 ${asof} · ${group[0].freq}更新 · ${group.length} 項`, rows);
  });

  const moverRows = (list, n = 6) => list.slice(0, n).map((i) => quoteRow(i, valuesOf(i)));

  view.innerHTML = `
    <div class="controls">${pills('quotecat', catPills, state.quoteCat)}</div>
    <div class="controls">${pills('quotespan', QUOTE_SPANS, state.quoteSpan)}</div>
    ${quoteSay(picked, movers, index.latest)}
    ${quoteThemeCard(themePack, spec)}
    ${listCard('漲最多', `${spec.label} · 取前 6 項`, moverRows(movers.up), '這個期間沒有品項在漲')}
    ${listCard('跌最多', `${spec.label} · 取前 6 項`, moverRows(movers.down), '這個期間沒有品項在跌')}
    ${tableCards.join('')}
    ${retired.length ? `<section class="card">
      <h2>已停止報價 <small>${retired.length} 個品項</small></h2>
      ${retired.slice().sort((a, b) => (a.last.d < b.last.d ? 1 : -1))
        .map((item) => quoteRow(item, valuesOf(item))).join('')}
      <p class="note">這些品項在最新的表上已經找不到（規格換代或下架），最後一筆報價
        停在各自標的日期。序列還留著，點進去看得到當時的走勢，但它們不列入上面的漲跌
        統計 —— 停更的數字混進「今天在漲的有幾項」就沒有意義了。</p>
    </section>` : ''}
    <section class="card">
      <h2>資料來源 <small>都是可公開瀏覽的頁面</small></h2>
      ${index.cats.map((c) => `<div class="row row--quote">
        <div class="ident">
          <span class="name">${esc(c.name)}</span>
          <span class="code">${esc(c.source)} · ${c.n} 項${
            c.retired ? `（另 ${c.retired} 項已停更）` : ''} · 最新 ${esc(c.latest)}</span>
        </div>
        <div class="figures"><span class="price">${esc((QUOTE_KINDS[c.kind] || {}).label || '')}</span></div>
      </div>`).join('')}
      <p class="note">記憶體、面板、太陽能與鋰電池材料取自 TrendForce 的免費價格頁；
        金屬、能源與指數取自 Yahoo Finance 的日線。免費頁只顯示最新一筆，
        所以歷史是本站自己每天累積的，起點就是開始追蹤的那一天。
        目錄更新於 ${esc((index.updated || '').slice(0, 16).replace('T', ' '))}。</p>
    </section>`;
}

/**
 * 單一品項。上面是報價自己的走勢，下面把它與對應族群的成交值疊在一起。
 *
 * 兩條線都換算成「以區間第一天為 100」的指數才疊得起來：一邊是美元／顆，
 * 一邊是億元，共用一個縱軸只會讓其中一條變成貼著軸的直線。
 */
async function renderQuoteItem(view, index, rawId) {
  const id = decodeURIComponent(rawId);
  const item = (index.items || []).find((i) => i.id === id);
  if (!item) {
    view.innerHTML = `<p class="hint">找不到這個報價品項。<br><a class="linky" href="#/quote">回報價清單</a></p>`;
    return;
  }

  const series = await loadQuoteSeries(item.cat);
  const raw = series && series.items[id] ? series.items[id] : [];
  const all = raw.map(([i, v]) => ({ d: series.dates[i], v }));
  const span = state.quoteChart;
  const floor = span && all.length
    ? new Date(new Date(all[all.length - 1].d).getTime() - span * 86400000).toISOString().slice(0, 10)
    : '';
  const points = floor ? all.filter((p) => p.d >= floor) : all;

  const values = points.map((p) => p.v);
  const high = values.length ? Math.max(...values) : null;
  const low = values.length ? Math.min(...values) : null;
  const kind = QUOTE_KINDS[item.kind] || QUOTE_KINDS.price;
  const cat = (index.cats || []).find((c) => c.key === item.cat) || {};

  const stats = [
    { b: quoteNum(item.last.v), span: `最新（${esc(item.last.d)}）` },
    { b: signedPct(quoteChg(item, 'prev'), 2), span: '較前次', cls: trend(quoteChg(item, 'prev')) },
    { b: signedPct(quoteChg(item, 'm1'), 2), span: '近一月', cls: trend(quoteChg(item, 'm1')) },
    { b: signedPct(quoteChg(item, 'y1'), 2), span: '近一年', cls: trend(quoteChg(item, 'y1')) },
  ];

  const themeText = (item.themes || []).map(([g, s]) => `${g}／${s}`).join('、');

  view.innerHTML = `
    <section class="card">
      <h2>${esc(item.name)} <small>${esc(cat.name || item.cat)} · ${esc(item.table)}</small></h2>
      <div class="stat-grid">${stats
        .map((s) => `<div class="stat"><b class="${s.cls || ''}">${s.b}</b><span>${s.span}</span></div>`)
        .join('')}</div>
      <p class="note">單位 ${esc(quoteUnit(item))} · ${esc(item.freq)}更新 ·
        ${item.n} 個報價日（${esc(item.first)} 起）· ${esc(kind.label)}
        ${item.why ? `<br>${esc(item.why)}。` : ''}
        ${themeText ? `<br>對應族群：${esc(themeText)}` : ''}</p>
    </section>
    <div class="controls">${pills('quotechart', QUOTE_CHART_SPANS, state.quoteChart)}</div>
    <section class="card">
      <h2>報價走勢 <small>${esc(quoteUnit(item))}</small></h2>
      <div class="chart-box"><canvas id="c-quote"></canvas></div>
      <p class="note">${points.length >= 2
        ? `區間高 ${quoteNum(high)}、低 ${quoteNum(low)}，目前在區間的 ${
            high === low ? '—' : `${(((item.last.v - low) / (high - low)) * 100).toFixed(0)}%`} 位置。
           點距不等寬：${esc(item.freq)}更新的報價就是${esc(item.freq)}一個點。`
        : '只有一個報價日，畫不出走勢。TrendForce 的免費頁只給最新一筆，歷史要靠每天累積。'}</p>
    </section>
    <section class="card" id="quote-vs">
      <h2>報價 × 族群成交值 <small>以區間首日為 100</small></h2>
      <div class="chart-box"><canvas id="c-quote-vs"></canvas></div>
      <p class="note">兩條線的單位不同（一邊是報價、一邊是億元），所以都換算成
        以區間第一天為 100 的指數。報價在下一次更新之前維持不變（畫成水平段），
        族群成交值只含當天排進前 300 名的成分股，沒進榜的日子斷線。</p>
    </section>
    <p class="hint"><a class="linky" href="#/quote">← 回報價清單</a>
      ${cat.url ? `<a class="linky" href="${esc(cat.url)}" target="_blank" rel="noopener">來源頁</a>` : ''}</p>`;

  let Chart;
  try {
    Chart = await loadChartJs();
  } catch (err) {
    view.querySelectorAll('.chart-box').forEach((box) => {
      box.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
    });
    return;
  }

  drawLine(Chart, $('#c-quote'), points.map((p) => p.d), [
    { data: values, color: QLINE.quote, label: item.name },
  ], { emptyText: '無報價' });

  await drawQuoteVsTheme(Chart, item, points);
}

/** 把報價與族群成交值疊在交易日軸上。族群對不起來時整張卡收起來，不要留一張空圖。 */
async function drawQuoteVsTheme(Chart, item, points) {
  const box = $('#quote-vs');
  if (!box) return;
  const all = item.themes || [];
  if (!all.length || !hasThemes() || points.length < 2) {
    box.hidden = true;
    return;
  }
  // 一個報價可以對應到好幾個族群（白銀既是 MLCC 端電極也是太陽能銀漿），
  // 但圖上只畫一條線 —— 那就只能是第一個大族群，而且加總的範圍要跟圖例上寫的一致。
  const primary = all[0][0];
  const themes = all.filter(([group]) => group === primary);
  const others = [...new Set(all.map(([group]) => group))].filter((g) => g !== primary);

  const dates = state.index.dates;
  const from = points[0].d;
  const axis = dates.filter((d) => d >= from && d <= state.date);
  if (axis.length < 2) {
    box.hidden = true;
    return;
  }

  const totals = await themeTotalsOnAxis(themes, axis);
  if (!totals || !totals.some((v) => v !== null)) {
    box.hidden = true;
    return;
  }

  const quoteLine = indexTo100(stepOnto(axis, points.map((p) => p.d), points.map((p) => p.v)));
  drawLine(Chart, $('#c-quote-vs'), axis, [
    { data: quoteLine, color: QLINE.quote, label: `${item.name}（報價）` },
    { data: indexTo100(totals), color: QLINE.theme, label: `${primary} 成交值` },
  ], { emptyText: '無資料' });

  if (others.length) {
    const note = box.querySelector('.note');
    if (note) {
      note.insertAdjacentHTML('beforeend',
        `<br>這個報價也對應到 ${esc(others.join('、'))}，圖上只畫第一個（${esc(primary)}）。`);
    }
  }
}

/** 該族群（含所有對應子族群）在指定交易日軸上的成交值合計，單位億元。 */
async function themeTotalsOnAxis(themes, axis) {
  const codes = new Set();
  for (const [group, sub] of themes) for (const code of themeCodes(group, sub)) codes.add(code);
  if (!codes.size) return null;

  const want = new Set(axis);
  const totals = new Map();
  const years = [...new Set(axis.map((d) => d.slice(0, 4)))].sort();
  for (const year of years) {
    const hist = await loadHistory(year);
    for (const code of codes) {
      const entry = hist.stocks[code];
      if (!entry) continue;
      for (const [i, , value] of entry.p) {
        const date = hist.dates[i];
        if (want.has(date)) totals.set(date, (totals.get(date) || 0) + value);
      }
    }
  }
  return axis.map((d) => (totals.has(d) ? Math.round(totals.get(d) * 10) / 10 : null));
}

/**
 * 把稀疏的報價鋪到交易日軸上：每一天取「當天或之前最後一筆」。
 * 合約價一個月才動一次，不鋪的話一年只有 12 個點、跟成交值那條完全對不起來。
 */
function stepOnto(axis, days, values) {
  const out = [];
  let at = -1;
  for (const date of axis) {
    while (at + 1 < days.length && days[at + 1] <= date) at += 1;
    out.push(at >= 0 ? values[at] : null);
  }
  return out;
}

/** 換算成「以第一個有值的點為 100」的指數，兩種單位才疊得起來。 */
function indexTo100(arr) {
  const first = arr.find((v) => v !== null && v !== undefined);
  if (!first) return arr.map(() => null);
  return arr.map((v) => (v === null || v === undefined ? null : Math.round((v / first) * 1000) / 10));
}

async function renderQuote(view, id) {
  let index;
  try {
    index = await loadQuoteIndex();
  } catch (err) {
    state.quotes = null;      // 讓下一次進來還會再試一次，不要記住這次的失敗
    view.innerHTML = `<p class="hint">還沒有報價資料（${esc(err.message)}）。<br>
      請先執行 <code>scripts/fetch_quotes.py</code> 與 <code>scripts/build_quotes.py</code>。</p>`;
    return;
  }
  if (!index || !Array.isArray(index.items) || !index.items.length) {
    view.innerHTML = '<p class="hint">報價目錄是空的，請重新執行 scripts/build_quotes.py。</p>';
    return;
  }
  if (id) await renderQuoteItem(view, index, id);
  else await renderQuoteList(view, index);
}

// --------------------------------------------------------------------------
// 分頁四：任兩日對照
// --------------------------------------------------------------------------
async function renderCompare(view, params) {
  const dates = state.index.dates;
  const dateB = params.get('b') || state.date;
  const dateA = params.get('a') || dateBack(20, dateB) || dates[0];
  const options = (selected) =>
    dates.slice().reverse().map((d) => `<option value="${d}" ${d === selected ? 'selected' : ''}>${d}</option>`).join('');

  view.innerHTML = `
    <div class="controls">
      <select id="cmp-a" aria-label="基準日">${options(dateA)}</select>
      <select id="cmp-b" aria-label="比較日">${options(dateB)}</select>
    </div>
    <div id="cmp-body"><p class="hint">載入中…</p></div>`;

  const go = () => {
    location.hash = `#/compare?a=${$('#cmp-a').value}&b=${$('#cmp-b').value}`;
  };
  $('#cmp-a').addEventListener('change', go);
  $('#cmp-b').addEventListener('change', go);

  if (dateA === dateB) {
    $('#cmp-body').innerHTML = '<p class="hint">請選擇兩個不同的日期。</p>';
    return;
  }
  const [a, b] = await Promise.all([loadDaily(dateA), loadDaily(dateB)]);
  const [older, newer] = dateA < dateB ? [a, b] : [b, a];
  $('#cmp-body').innerHTML = diffSections(newer, older, older.date, newer.date);
}

// --------------------------------------------------------------------------
// 外框：日期選單、分頁、路由
// --------------------------------------------------------------------------
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  return { view: parts[0] || 'rank', arg: parts[1] || null, params: new URLSearchParams(qs || '') };
}

function paintChrome() {
  const idx = state.index;
  const select = $('#date-select');
  select.innerHTML = idx.dates.slice().reverse().map((d) => `<option value="${d}">${d}</option>`).join('');
  select.value = state.date;

  // 走到序列兩端就把按鈕鎖起來，免得按了沒反應讓人以為壞掉
  const at = idx.dates.indexOf(state.date);
  $('#date-prev').disabled = at <= 0;
  $('#date-next').disabled = at < 0 || at >= idx.dates.length - 1;

  $('#scope-select').value = state.scope;

  const i = idx.dates.indexOf(state.date);
  const ser = scopeSeries();
  const market = ser ? ser.marketValues[i] : null;
  $('#meta').textContent =
    `${scopeLabel()}成交值 ${num(market, 0)} 億 · 共 ${idx.dates.length} 個交易日（${idx.dates[0]} 起）`
    + ` · 更新 ${idx.updated.slice(0, 16).replace('T', ' ')}`;

  // 排程停擺時畫面看起來一切正常，使用者會以為看到的是當天的盤，所以要明講。
  const stale = daysSinceTaipei(idx.latest);
  const banner = $('#stale');
  banner.hidden = stale < STALE_DAYS;
  banner.textContent = banner.hidden ? '' : `⚠ 最新資料只到 ${idx.latest}，已 ${stale} 天沒有更新`;
}

async function render() {
  const route = parseHash();
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === route.view));
  destroyCharts();
  const view = $('#view');
  // 流向頁那兩張圖看的是面積，寬螢幕不跟其他分頁一樣限在 720px
  view.classList.toggle('wide', route.view === 'flow');
  view.innerHTML = '<p class="hint">載入中…</p>';

  try {
    // 某個範圍在某一天沒有資料時，直接講清楚，不要讓它變成一則 404 載入失敗
    if (!hasScopeData(state.date)) {
      view.innerHTML = `<p class="hint">${scopeLabel()}在 ${state.date} 沒有資料。<br>請改選其他日期或範圍。</p>`;
      paintChrome();
      return;
    }
    if (route.view === 'market') await renderMarket(view);
    else if (route.view === 'sector') await renderSector(view);
    else if (route.view === 'flow') await renderFlow(view);
    else if (route.view === 'streak') await renderStreak(view);
    else if (route.view === 'moves') await renderMoves(view);
    else if (route.view === 'burst') await renderBurst(view);
    else if (route.view === 'ma') await renderMa(view);
    else if (route.view === 'macd') await renderMacd(view);
    else if (route.view === 'holders') await renderHolders(view, route.arg);
    else if (route.view === 'quote') await renderQuote(view, route.arg);
    else if (route.view === 'stock') await renderStock(view, route.arg);
    else if (route.view === 'compare') await renderCompare(view, route.params);
    else await renderRank(view);
    paintChrome();
  } catch (err) {
    view.innerHTML = failBox(`載入失敗：${err.message}`,
      `前端版本 ${APP_VERSION}。若清除快取後仍然一樣，就不是快取的問題。`);
  }
}

/** 沿著交易日序列前後各挪一天（step 為 -1 或 +1），到頭了就不動 */
function shiftDate(step) {
  const dates = state.index.dates;
  const at = dates.indexOf(state.date);
  if (at < 0) return;
  const next = dates[at + step];
  if (!next) return;
  state.date = next;
  render();
}

function bindGlobalControls() {
  $('#date-select').addEventListener('change', (e) => {
    state.date = e.target.value;
    render();
  });

  $('#date-prev').addEventListener('click', () => shiftDate(-1));
  $('#date-next').addEventListener('click', () => shiftDate(1));

  $('#scope-select').addEventListener('change', (e) => {
    state.scope = e.target.value;
    try {
      localStorage.setItem(SCOPE_KEY, state.scope);
    } catch (err) {
      /* 記不住就算了，不影響這次瀏覽 */
    }
    render();
  });

  // pill 按鈕以事件委派處理，畫面重繪後不必重新綁定
  $('#view').addEventListener('click', (e) => {
    const pill = e.target.closest('.pill');
    if (!pill) return;
    if (pill.dataset.baseline) state.baseline = Number(pill.dataset.baseline);
    if (pill.dataset.span) state.span = Number(pill.dataset.span);
    if (pill.dataset.streak) state.streakDays = Number(pill.dataset.streak);
    if (pill.dataset.burstlots) state.burstLots = Number(pill.dataset.burstlots);
    if (pill.dataset.bursthigh) state.burstHigh = Number(pill.dataset.bursthigh);
    if (pill.dataset.burstred) state.burstRed = pill.dataset.burstred;
    if (pill.dataset.maline) state.maWindow = Number(pill.dataset.maline);
    if (pill.dataset.madays) state.maDays = Number(pill.dataset.madays);
    if (pill.dataset.maside) state.maSide = pill.dataset.maside;
    if (pill.dataset.mastack) state.maStack = pill.dataset.mastack;
    if (pill.dataset.mazone) state.maZone = pill.dataset.mazone;
    if (pill.dataset.macdside) state.macdSide = pill.dataset.macdside;
    if (pill.dataset.macdwhen) state.macdWhen = pill.dataset.macdwhen;
    if (pill.dataset.macdstack) state.macdStack = pill.dataset.macdstack;
    if (pill.dataset.sectorsort) state.sectorSort = pill.dataset.sectorsort;
    if (pill.dataset.holderlots) {
      state.holderLots = Number(pill.dataset.holderlots);
      try {
        localStorage.setItem(HOLDER_LOTS_KEY, String(state.holderLots));
      } catch (err) {
        /* 記不住就算了，下次回到預設的 400 張 */
      }
    }
    if (pill.dataset.holderspan) state.holderSpan = pill.dataset.holderspan;
    if (pill.dataset.quotecat) state.quoteCat = pill.dataset.quotecat;
    if (pill.dataset.quotespan) state.quoteSpan = pill.dataset.quotespan;
    if (pill.dataset.quotechart) state.quoteChart = Number(pill.dataset.quotechart);
    if (pill.dataset.grouping) {
      state.grouping = pill.dataset.grouping;
      try {
        localStorage.setItem(GROUPING_KEY, state.grouping);
      } catch (err) {
        /* 記不住就算了，下次回到預設的官方產業 */
      }
    }
    if (pill.dataset.watch) toggleWatch(pill.dataset.watch);
    render();
  });

  window.addEventListener('hashchange', render);
}

async function start() {
  try {
    // index.json 一定要繞過快取：它決定有哪些交易日，讀到舊的就永遠看不到新資料。
    // daily/ 與 history/ 的內容幾乎不變，維持正常快取即可（每天的新資料是新的網址）。
    state.index = await getJSON(`${DATA}/index.json`, { cache: 'reload' });
  } catch (err) {
    $('#view').innerHTML = `<p class="hint">找不到資料檔（${esc(err.message)}）。<br>請先執行 scripts/fetch_daily.py 與 scripts/build_history.py。</p>`;
    return;
  }

  // index.json 讀得到、卻不是這一版看得懂的格式，代表跑的是被快取住的舊 app.js。
  // 先自己清一次快取重載；真的還是壞的才把按鈕交給使用者。
  const idx = state.index;
  const usable = idx && Array.isArray(idx.dates) && idx.dates.length && idx.scopes && idx.scopes.all;
  if (!usable) {
    if (autoHealOnce()) return;
    $('#view').innerHTML = failBox(
      'data/index.json 的格式與目前的前端對不起來。',
      `前端版本 ${APP_VERSION}。多半是瀏覽器留著舊版程式檔；若是本機環境，請重跑 scripts/build_history.py。`);
    return;
  }
  // 產業別與題材族群都是選配：抓不到就當作沒有那一種分類，不影響其他分頁。
  try {
    const ind = await getJSON(`${DATA}/industry.json`);
    state.industry = ind.map || {};
  } catch (err) {
    state.industry = {};
  }
  try {
    const th = await getJSON(`${DATA}/themes.json`);
    state.themes = Array.isArray(th.groups) ? th.groups : [];
    state.themesUpdated = th._updated || '';
  } catch (err) {
    state.themes = [];
  }

  state.watch = loadWatch();
  try {
    // 除了在選單裡，還要這份 index.json 真的有這個範圍——舊版留下來的設定不該讓整頁掛掉
    const saved = localStorage.getItem(SCOPE_KEY);
    if (SCOPES.some((s) => s.value === saved) && state.index.scopes[saved]) state.scope = saved;
    const grouping = localStorage.getItem(GROUPING_KEY);
    if (GROUPINGS.some((g) => g.value === grouping)) state.grouping = grouping;
    const lots = Number(localStorage.getItem(HOLDER_LOTS_KEY));
    if (HOLDER_LOTS.some((o) => o.value === lots)) state.holderLots = lots;
  } catch (err) {
    /* 讀不到就用預設的「全部」與「官方產業」 */
  }

  $('#scope-select').innerHTML =
    SCOPES.map((s) => `<option value="${s.value}">${s.label}</option>`).join('');

  state.date = state.index.latest;
  bindGlobalControls();
  await render();

  if ('serviceWorker' in navigator) {
    // updateViaCache: 'none'：sw.js 自己絕不能從 HTTP 快取拿，否則換了版也發現不了
    const had = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // 新版 SW 用 skipWaiting + claim 直接接手，這一頁的外殼卻還是舊的，重載一次拿新版。
      // 第一次安裝就接手是正常的，不用重載。
      if (!had || reloading) return;
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  }
}

start();
