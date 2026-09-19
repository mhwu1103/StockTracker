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
  usLink: [],          // 題材族群 -> 連動美股（us_link.json，抓不到時為空陣列）
  usUpdated: '',       // us_link.json 的維護日期
  usBench: [],         // 大盤層級的美股參考（TSM ADR、費半…），不屬於任何一族
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
  instiMin: 0.5,       // 「法人」分頁的同買／同賣門檻（億），INSTI_MINS 的 value
  instiLeg: 'fo',      // 「買超」分頁看哪一邊法人（INSTI_LEGS 的 value），sum 是三邊相加
  instiWin: 'd',       // 「買超」分頁看哪一個期間（INSTI_WINS 的 value），d 是當日
  instiSort: 'oku',    // 「買超」分頁排序：oku 依金額／force 依力道（只有當日有力道）
  // 「雷達」分頁的八組條件。空字串＝不限；min 是 fo/tr/de 三條共用的金額門檻
  radar: { fo: '', tr: '', de: '', against: '', force: '', run: '', sum20: '', min: '0.5' },
  runDays: 3,          // 「連買」分頁的連續天數門檻，RUN_DAYS 的 value
  runOku: 0,           // 「連買」分頁的累計金額門檻（億），0 是不限
  insti: null,         // Promise<insti/index.json>，進到法人頁才載
  instiDay: new Map(), // 交易日 -> Promise<insti/daily/{日期}.json>
  instiChg: new Map(), // 交易日 -> Promise<insti/chg/{日期}.json>
  instiSum: new Map(), // 交易日 -> Promise<insti/sum/{日期}.json>
  instiBase: new Map(),// 交易日 -> Promise<insti/base/{日期}.json|null>
  instiStock: new Map(),// 代號 -> Promise<insti/stock/{代號}.json|null>
  instiRun: new Map(), // 交易日 -> Promise<insti/streak/{日期}.json>
  holders: null,       // Promise<holders/index.json>，進到大戶頁才載
  holderWeek: new Map(),// 集保資料日 -> Promise<holders/weekly/{日期}.json>
  holderStock: new Map(),// 代號 -> Promise<holders/stock/{代號}.json|null>
  quoteCat: 'all',     // 「報價」分頁的品類篩選；'all' 代表全部
  quoteSpan: 'm1',     // 「報價」分頁看哪一個期間的變化（QUOTE_SPANS 的 value）
  quoteChart: 365,     // 「報價」個別品項的圖表要顯示幾天；0 代表全部
  quotes: null,        // Promise<quotes/index.json>，進到報價頁才載
  quoteSeries: new Map(),// 品類 -> Promise<quotes/series/{cat}.json|null>
  entry: null,         // Promise<entry.json>，進到「後續」頁才載
  period: 'w',         // 「週月」分頁看週還是月（PERIODS 的 value）
  daily: new Map(),    // date -> Promise<payload>
  history: new Map(),  // year -> Promise<payload>
  kline: new Map(),    // market/code/month -> Promise<payload|null>
  charts: [],
  csv: null,           // 目前畫面上那一份帶得走的資料（匯出鈕用）
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

/**
 * 連動美股（us_link.json）。與 themes.json 是兩份各自維護的檔案，靠**族群名稱**接起來：
 * 名字對不上就當作沒有對照，寧可少一行也不要在族群頁上掛掉。
 *
 * 強度只有三級，寫成星號是為了讓一眼掃得過去；意思寫在 title 裡，滑過去才看得到：
 *   ★★★ 同一條供應鏈——客戶的財報或資本支出直接決定訂單
 *   ★★☆ 景氣或報價同步——同一個循環，中間隔著報價與匯率
 *   ★☆☆ 題材情緒連動——跳空之後常收斂，不宜追價
 */
const US_STARS = { 3: '★★★', 2: '★★☆', 1: '★☆☆' };
const US_MEANS = {
  3: '同一條供應鏈：客戶的財報或資本支出直接決定訂單',
  2: '景氣或報價同步：同一個循環，中間隔著報價與匯率',
  1: '題材情緒連動：跳空之後常收斂，不宜追價',
};

const hasUsLink = () => state.usLink.length > 0;

/** 某個族群（或其中一個子族群）的連動美股；查不到回空陣列。 */
function usLinkOf(groupName, subName) {
  const group = state.usLink.find((g) => g.name === groupName);
  if (!group) return [];
  if (!subName) return group.us || [];
  return (group.subs || []).find((s) => s.name === subName)?.us || [];
}

/** 該族群為什麼跟著美股動——一句話，只有大族群有。 */
const usWhyOf = (groupName) => state.usLink.find((g) => g.name === groupName)?.why || '';

/** 子族群列到與大族群一模一樣的美股時，那一行是多餘的（記憶體整族就是同一批）。 */
const sameUs = (a, b) => a.length === b.length && a.every((u, i) => u.t === b[i].t);

/** 一行連動美股。list 空的就回空字串，讓呼叫端不必先判斷。 */
function usLine(list, why = '') {
  if (!list.length) return '';
  // 標籤裡不能有換行縮排：那會在代號前面留一個空白，靠左的邊距就對不齊
  const tags = list.map((u) => `<span class="ustag" title="${esc(US_MEANS[u.s] || '')}"`
    + `><b>${esc(u.t)}</b>${esc(u.n)}<em>${US_STARS[u.s] || ''}</em></span>`).join('');
  return `<p class="uslink">${tags}${why ? `<span class="uslink__why">${esc(why)}</span>` : ''}</p>`;
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

function stockRow(stock, base, tag) {
  const prev = base ? base.rank : null;
  const pct = stock.changePct;
  const pctText = pct === null || pct === undefined ? '' : `<em class="${trend(pct)}">${pct > 0 ? '+' : ''}${pct.toFixed(2)}%</em>`;
  const streak = streakLabel(stock, true);
  return `<a class="row" href="#/stock/${stock.code}">
    <div class="rank"><span class="no">${stock.rank}</span>${deltaBadge(stock.rank, prev)}</div>
    <div class="ident"><span class="name">${state.watch.has(stock.code) ? '<span class="star">★</span>' : ''}${esc(stock.name)}</span>
      <span class="code">${stock.code}${stock.m ? ` · ${esc(MARKET_TAGS[stock.m])}` : ''}${hasIndustry() ? ` · ${esc(industryOf(stock.code))}` : ''}</span>
      ${streak ? `<span class="streak">${streak}</span>` : ''}${instiTagChip(tag)}</div>
    <div class="figures"><span class="value">${fmtValue(stock.value)}</span>
      <span class="price">${stock.close === null ? '' : num(stock.close, 2)} ${pctText}</span></div>
  </a>`;
}

/* --------------------------------------------------------------------------
 * 桌面版的清單：同一批資料攤成多欄
 *
 * 手機一列是「名次｜名稱｜數字」三格，代號、產業、連續天數靠換行擠進第二格。寬螢幕
 * 照搬這個形狀，只是把同樣三格扯開到 1160px，中間一大片空白——而清單在寬螢幕上真正
 * 該換的東西是**欄**：每一段自己一欄，兩百列才能上下對齊比較。
 *
 * 外資與投信那兩欄不需要多抓任何資料：排行頁本來就載了法人的每日檔（43 KB，與法人頁
 * 共用快取），只是以前把它縮成一個「土洋同買」的徽章。桌面有欄位可以放數字，就別只
 * 給形容詞。
 *
 * **不用 <table>**：一列必須是 <a>。ctrl／中鍵開新分頁在桌面上比手機重要得多，而
 * <table> 裡放連結就得整列委派 JS 導覽，那會把「在新分頁開啟」一起弄丟。CSS grid
 * 給得起欄位對齊，不需要 table。
 *
 * 欄寬只寫在 --cols 一處，表頭與每一列共用同一個值，不可能對不起來。
 * -------------------------------------------------------------------------- */

/**
 * 斷點與 style.css 的桌面層是同一個 1024px。
 * 兩邊一錯開就是「版面已經換了、內容還是手機版」，所以 .github/workflows/check.yml
 * 有一步在對這個字串。
 */
const WIDE_MQ = '(min-width: 1024px)';
const wide = window.matchMedia(WIDE_MQ);

/** 一格數字：沒有值時給破折號，不要留白（留白看起來像壞掉）。 */
const cellNum = (v, digits = 2) => (v === null || v === undefined ? '—' : num(v, digits));

/** 一欄：表頭的字、欄寬（進 grid-template-columns）、對齊用的 class、一格的內容。 */
const col = (label, w, cls, cell) => ({ label, w, cls, cell });

/**
 * 欄寬表。
 *
 * 一律寫成 `minmax(讀得懂的最小值, 好看的寬度)` 而不是一個定值：視窗剛好 1024px 時，
 * 扣掉 216px 的側欄與左右留白，內容窗格只剩 760px 左右，欄寬全寫死的話欄數多的那幾頁
 * 會被 .card 的 overflow 裁掉右邊——**最後一欄整欄不見，而畫面看起來沒有壞**。
 *
 * 下限集中在這裡而不是散在各頁，是因為下限要按**內容的實際寬度**定，而同一種內容
 * （一個億元金額、一個日期）在哪一頁都一樣寬。文字欄的下限可以很小（省略號會接手），
 * 數字欄不行 —— 數字截一半會被讀成另一個數字，下限就是那個數字本身的寬度。
 */
const W = {
  seq: '3rem',                      // 「#」：這一張榜裡的第幾名
  rank: '4.4rem',                   // 名次 ＋ 升降徽章
  back: 'minmax(3rem, 4.6rem)',     // 接在最後當參考的成交值名次
  name: 'minmax(6rem, 1.4fr)',
  title: 'minmax(7rem, 1.6fr)',     // 報價的品項名，比股票名長得多
  ind: 'minmax(3.5rem, 0.8fr)',
  text: 'minmax(4rem, 0.9fr)',      // 來源表、單位這種截得掉的字
  kind: 'minmax(3.6rem, 5rem)',
  oku: 'minmax(3.6rem, 6rem)',      // 「+169 億」
  lots: 'minmax(4.8rem, 6.6rem)',   // 「+32,233 張」
  val: 'minmax(4.4rem, 6.6rem)',    // 「1,140 億」
  price: 'minmax(3.9rem, 5.2rem)',  // 「4,710.00」
  pct: 'minmax(3.6rem, 5rem)',      // 「+10.00%」
  pp: 'minmax(4.2rem, 5.8rem)',     // 「-22.90pp」
  share: 'minmax(3.8rem, 5.6rem)',  // 「47.4%」：表頭「佔成交值」比內容還長
  force: 'minmax(2.8rem, 4.8rem)',  // 「5.3 倍」
  days: 'minmax(3.8rem, 5.4rem)',   // 「18/22 天」
  date: 'minmax(5rem, 6.4rem)',     // 「2026-09-18」
  note: 'minmax(4.4rem, 6.8rem)',   // 「今天剛站上」這種一句話的狀態
  heads: 'minmax(4.6rem, 6.4rem)',  // 「1,042 戶」「100.3 萬人」
  chips: 'minmax(7rem, 9rem)',      // 四條均線的標記
  chipsMacd: 'minmax(8.4rem, 10.5rem)',
  spark: '68px',
};

/**
 * 第二層斷點。只在 JS 裡，CSS 沒有對應的一層，所以不像 1024 那樣有兩邊同步的問題。
 *
 * 1024–1280 這一段的內容窗格只有 700–950px，欄數最多的那幾頁（雷達十二欄、大戶與
 * 連買十一欄）塞不下。塞不下的後果不是擠成一團，是 .card 的 overflow 把最右邊那幾欄
 * **整欄裁掉**，而畫面看起來還是好好的 —— 跟斷點對不上那個坑是同一種：看不出來。
 *
 * 所以標了 optional() 的欄在這一段不出。標的是**上下文欄**（產業、佔成交值這種幫忙
 * 理解的），不是這一頁篩選與排序看的那幾欄 —— 後者砍掉，讀者就沒辦法核對「這幾檔
 * 憑什麼在這裡」，那才是清單真正在回答的問題。
 */
const ROOMY_MQ = '(min-width: 1280px)';
const roomy = window.matchMedia(ROOMY_MQ);

/** 標一欄「窄桌面時可以不出」。 */
const optional = (c) => ({ ...c, opt: true });

/** 名稱格：★、名稱，代號與市場接在後面用小字。全站的清單共用同一個形狀。 */
const wideName = (code, name, market) =>
  `${state.watch.has(code) ? '<span class="star">★</span>' : ''}${esc(name)}`
  + `<i>${code}${market ? ` · ${esc(MARKET_TAGS[market] || market)}` : ''}</i>`;

/** 漲跌% 格。 */
const widePct = (pct) => (pct === null || pct === undefined ? '—'
  : `<em class="${trend(pct)}">${pct > 0 ? '+' : ''}${pct.toFixed(2)}%</em>`);

/** 帶紅綠的億元格。 */
const wideOku = (v) => (v === null || v === undefined ? '—'
  : `<em class="${trend(v)}">${signedOku(v)}</em>`);

/** 力道格。法人的三張榜共用。 */
const wideForce = (force) => (force === null || force === undefined ? '—'
  : `${num(force, force < 10 ? 1 : 0)} 倍`);

/** 這一批在當日成交值裡佔多少。買賣超的金額不套一個分母就沒有大小可言。 */
const wideShare = (oku, stock) => (stock && stock.value
  ? `${num((Math.abs(oku) * 1e8 / stock.value) * 100, 1)}%` : '—');

/**
 * 產業欄。沒有產業對照就整欄不要出，所以呼叫端都包在 hasIndustry() 裡。
 * drop 為真時窄桌面也不出 —— 欄數已經爆掉的那幾頁才這樣標，見 optional()。
 */
const colIndustry = (codeOf, drop = false) => {
  const c = col('產業', W.ind, 'w-ind', (it) => esc(industryOf(codeOf(it))));
  return drop ? optional(c) : c;
};

/** 序號欄：這一張榜裡的第幾名，跟成交值名次是兩件事。 */
const colSeq = col('#', W.seq, 'w-rank', (it, i) => i + 1);

const WIDE_COLS = {
  rank: { label: '名次', w: W.rank, cls: 'w-rank',
    cell: (it) => `<b>${it.s.rank}</b>${deltaBadge(it.s.rank, it.base ? it.base.rank : null)}` },

  name: { label: '名稱', w: W.name, cls: 'w-name',
    cell: (it) => `${state.watch.has(it.s.code) ? '<span class="star">★</span>' : ''}`
      + `${esc(it.s.name)}<i>${it.s.code}${it.s.m ? ` · ${esc(MARKET_TAGS[it.s.m])}` : ''}</i>` },

  industry: { label: '產業', w: W.ind, cls: 'w-ind',
    cell: (it) => esc(industryOf(it.s.code)) },

  value: { label: '成交值', w: W.val, cls: 'w-num w-val',
    cell: (it) => fmtValue(it.s.value) },

  close: { label: '收盤', w: W.price, cls: 'w-num',
    cell: (it) => cellNum(it.s.close) },

  chg: { label: '漲跌%', w: W.pct, cls: 'w-num',
    cell: (it) => (it.s.changePct === null || it.s.changePct === undefined ? '—'
      : `<em class="${trend(it.s.changePct)}">${it.s.changePct > 0 ? '+' : ''}${it.s.changePct.toFixed(2)}%</em>`) },

  fo: { label: '外資', w: W.oku, cls: 'w-num',
    cell: (it) => (it.insti ? `<em class="${trend(it.insti.fo)}">${signedOku(it.insti.fo)}</em>` : '—') },

  tr: { label: '投信', w: W.oku, cls: 'w-num',
    cell: (it) => (it.insti ? `<em class="${trend(it.insti.tr)}">${signedOku(it.insti.tr)}</em>` : '—') },

  streak: { label: '連續進榜', w: W.note, cls: 'w-num w-streak',
    cell: (it) => (streakLabel(it.s) || '—') },
};

/**
 * 哪幾欄要出現，由這批資料自己決定：沒有產業對照就不要空一欄，沒帶法人資料的頁面
 * （站穩、異動、族群）也不該畫兩欄破折號。
 */
function wideColumns(items) {
  const cols = [WIDE_COLS.rank, WIDE_COLS.name];
  if (hasIndustry()) cols.push(WIDE_COLS.industry);
  cols.push(WIDE_COLS.value, WIDE_COLS.close, WIDE_COLS.chg);
  if (items.some((it) => it.insti)) cols.push(WIDE_COLS.fo, WIDE_COLS.tr);
  if (items.some((it) => it.s && it.s.streak)) cols.push(WIDE_COLS.streak);
  return cols;
}

/**
 * 表頭 + 每一列。欄寬只寫在 --cols 一處，表頭與列吃同一個值，不可能對不起來。
 * href 決定一列連到哪裡——一列必須是 <a>，理由見上面那段。
 */
function wideTable(items, cols, href) {
  const tpl = cols.map((c) => c.w).join(' ');
  const head = `<div class="thead">${cols
    .map((c) => `<span class="${c.cls}">${esc(c.label)}</span>`).join('')}</div>`;
  const rows = items.map((it, i) => `<a class="row row--wide" href="${href(it, i)}">${cols
    .map((c) => `<span class="${c.cls}">${c.cell(it, i)}</span>`).join('')}</a>`).join('');
  return `<div class="wide-table" style="--cols:${tpl}">${head}${rows}</div>`;
}

/**
 * 一份清單的 HTML。桌面給多欄表格、手機給原本那種列——手機那條路徑一個位元組都沒
 * 動，寬螢幕的新版面不該有機會影響每天在用的那一個。
 *
 * mobile(it, i) 畫手機的一列；desktop(items) 回 { cols, href }，只有寬螢幕才會被
 * 呼叫。它拿得到**整批**而不是一個一個問，因為「要不要出這一欄」是整批的問題：
 * 沒有產業對照就不該空一欄，這一批都沒有力道就不該畫一整欄破折號。
 *
 * 全站的清單都從這裡出去。頁面自己寫的那些列樣板留著當手機版，桌面的欄位另外宣告
 * ——同一份資料換一個形狀，不是兩份資料。
 */
function listOf(items, mobile, desktop) {
  if (!wide.matches) return items.map(mobile).join('');
  const { cols, href } = desktop(items);
  return wideTable(items, cols.filter((c) => roomy.matches || !c.opt), href);
}

/**
 * 一份股票清單的 HTML。items 是 [{ s, base, tag, insti }]：s 必要，其餘看該頁有沒有
 * 那份資料。
 */
function stockList(items) {
  const rows = items.filter((it) => it.s);
  return listOf(rows,
    (it) => stockRow(it.s, it.base, it.tag),
    (list) => ({ cols: wideColumns(list), href: (it) => `#/stock/${it.s.code}` }));
}

function listCard(title, subtitle, rows, emptyText = '無') {
  // rows 可以是畫好的 HTML（stockList 給的）或一陣列的列。桌面版的表格是一整塊
  // （表頭 + 兩百列），拆不回陣列，所以這裡兩種都收。
  const body = typeof rows === 'string' ? rows : (rows.length ? rows.join('') : '');
  return `<section class="card">
    <h2>${esc(title)} ${subtitle ? `<small>${esc(subtitle)}</small>` : ''}</h2>
    ${body || `<p class="hint">${esc(emptyText)}</p>`}
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
// 只有這幾個分頁有：排行（合計與集中度不在畫面上）、大盤（今天對比期間平均）、
// 族群（改用佔比位移挑，跟預設排序看到的不同）、流向（把兩張抽象的圖翻成人話）、
// 報價（把上游報價翻成「哪一族的成本在漲」）、後續（數字本身看不出「這等於沒有
// 預測力」，而那正是那一頁最該先講的一句）。
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
  // 法人資料是順便載的：它涵蓋的交易日比排行短，抓不到就是沒有徽章，整頁照常。
  // 43 KB 換榜上直接看得到「土洋同買／對作」，而且它與法人頁共用同一份快取。
  const [today, base, instiDay] = await Promise.all([
    loadDaily(state.date), loadDaily(baseDate),
    loadInstiDay(state.date).catch(() => null)]);
  const baseMap = rankMap(base);
  const tags = instiTagMap(instiDay, state.instiMin);
  const amounts = instiAmountMap(instiDay);
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

  const tools = exportBar();
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
    ${tools}
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
    const rows = stockList(picked.map((s) => ({
      s, base: baseMap.get(s.code), tag: tags.get(s.code), insti: amounts.get(s.code),
    })));

    const watchNote = state.sector === '!WATCH'
      ? `<p class="note">自選清單：<code id="watch-codes">${[...state.watch].sort().join(',')}</code>
          <button class="linky" id="copy-watch">複製</button><br>
          自選股只存在這台裝置的瀏覽器。要讓 Telegram 也只推這幾檔，把上面這串設成 <code>WATCHLIST</code> secret
          —— 推播會帶上每一檔的<b>籌碼動靜</b>（土洋同買／對作、外資連買天數、力道、逆勢），
          而且<b>檔數沒有上限</b>。</p>`
      : '';
    setExport(`排行_${state.scope}_${state.date}.csv`,
      ['名次', '代號', '名稱', '市場', '產業', '成交值(億)', '收盤', '漲跌%', '連續進榜天數'],
      picked.map((s) => [s.rank, s.code, s.name, MARKET_TAGS[s.m] || '',
        hasIndustry() ? industryOf(s.code) : '',
        (s.value / 1e8).toFixed(2), s.close, s.changePct, s.streak || '']));
    $('#rank-list').innerHTML =
      (picked.length ? rows : '<p class="hint">找不到符合的股票</p>') + watchNote;
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

  const rows = (list) => stockList(list.map((s) => ({ s, base: baseMap.get(s.code) })));

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
  const rows = (list) => stockList(list.map((s) => ({ s, base: d.basMap.get(s.code) })));
  // 掉出榜這一張的名次是**基準日**的名次（今天已經不在榜上了）。手機版把這件事寫在
  // 右下角那行小字上，桌面版寫在卡片標題與副標上，欄名就不必再說一次。
  const leftRows = listOf(d.left,
    (s) => `<a class="row" href="#/stock/${s.code}">
      <div class="rank"><span class="no">${s.rank}</span><span class="delta down">OUT</span></div>
      <div class="ident"><span class="name">${esc(s.name)}</span><span class="code">${s.code}</span></div>
      <div class="figures"><span class="value">${fmtValue(s.value)}</span><span class="price">${esc(labelA)} 名次</span></div>
    </a>`,
    () => ({
      href: (s) => `#/stock/${s.code}`,
      cols: [
        col('名次', W.rank, 'w-rank', (s) => `<b>${s.rank}</b>`),
        col('名稱', W.name, 'w-name', (s) => wideName(s.code, s.name, s.m)),
        ...(hasIndustry() ? [colIndustry((s) => s.code)] : []),
        col('成交值', W.val, 'w-num w-val', (s) => fmtValue(s.value)),
      ],
    }));

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
// 分頁：後續（新進榜之後通常怎麼走）
//
// 全站其他頁都在講「今天發生了什麼」，這一頁講的是「歷史上這件事之後通常怎麼樣」。
// 資料是 scripts/build_entry.py 算好的分布，前端只負責排版。
//
// ## 這一頁最重要的一句話是「沒有預測力」
//
// 全部新進榜的 +1 日中位數是 0.00%、上漲比例 49% —— 擲硬幣。把這個結論擺在最上面，
// 是因為「成交值衝進前 200」在坊間很容易被讀成利多，而資料不支持那個讀法。
//
// 一頁統計如果只列數字不講結論，讀者會自己挑一個想看的數字當結論；
// 而這一頁最容易被挑走的就是「站穩 5 天以上那一組後來漲很多」。
//
// ## 「站穩幾天」那一組有兩個坑，都要講死
//
// 1. **事後才知道。** 進榜當天你不知道它會不會站穩五天，所以這個分組不能拿來決策。
// 2. **+1 日那一格還有循環性。** 「站穩五天」有一部分就是因為它這五天一直漲、
//    成交值一直大 —— 用被測期間內發生的事去分組，再去測那一段的報酬，會自己證明自己。
//
// 這兩件事不寫出來的話，那一格 +4.33% 會被當成一個可以照做的發現。
//
// ## 中位數，不是平均
//
// +20 日的平均是 +4.90%、中位數只有 +0.91% —— 右偏，少數大漲的把平均整個拉高。
// 所以表格一律給中位數與四分位，平均只在說明裡當對照出現一次。
// --------------------------------------------------------------------------
function loadEntry() {
  if (!state.entry) state.entry = getJSON(`${DATA}/entry.json`, { cache: 'reload' });
  return state.entry;
}

/** 一格：中位數、四分位、上漲比例與樣本數。樣本不足的那一格留白而不是給數字。 */
const entryCell = (cell) => (cell
  ? `<td><b class="${trend(cell.med)}">${cell.med > 0 ? '+' : ''}${cell.med.toFixed(2)}%</b>
      <span>${cell.p25 > 0 ? '+' : ''}${cell.p25.toFixed(1)} ~ ${cell.p75 > 0 ? '+' : ''}${cell.p75.toFixed(1)}</span>
      <span>漲 ${cell.pos.toFixed(0)}% · ${cell.n} 筆</span></td>`
  : '<td><b class="flat">—</b><span>樣本不足</span></td>');

const entryTable = (group, horizons) => `<div class="tbl-wrap"><table class="tbl">
  <thead><tr><th>${esc(group.label)}</th>${horizons
    .map((h) => `<th>+${h} 日</th>`).join('')}</tr></thead>
  <tbody>${group.rows.map((row) => `<tr><th>${esc(row.label)}</th>${horizons
    .map((h) => entryCell(row.h[String(h)])).join('')}</tr>`).join('')}</tbody>
</table></div>`;

async function renderEntry(view) {
  let data;
  try {
    data = await loadEntry();
  } catch (err) {
    view.innerHTML = `<p class="hint">還沒有進榜後表現的統計（${esc(err.message)}）。<br>
      請執行 <code>scripts/build_entry.py</code>（它由 <code>docs/data/history/</code>
      與 <code>docs/data/close/</code> 算出來，不用重抓）。</p>`;
    return;
  }

  const hs = data.horizons;
  const all = data.groups[0].rows[0].h;
  const stat = (h) => {
    const cell = all[String(h)];
    return cell
      ? { b: `${cell.med > 0 ? '+' : ''}${cell.med.toFixed(2)}%`, cls: trend(cell.med),
        span: `+${h} 日中位數 · 漲 ${cell.pos.toFixed(0)}%` }
      : { b: '—', cls: 'flat', span: `+${h} 日` };
  };

  view.innerHTML = `
    <section class="card takeaway">
      <h2>一句話 <small>${esc(data.first)} ~ ${esc(data.last)}．${data.n} 次進榜</small></h2>
      <p class="lede">進榜<b>本身</b>看不出後續 —— 全部新進榜的隔日中位數是
        ${all['1'] ? `${all['1'].med > 0 ? '+' : ''}${all['1'].med.toFixed(2)}%、上漲比例 ${all['1'].pos.toFixed(0)}%` : '—'}，
        和擲硬幣沒有分別。</p>
      <div class="stat-grid">${hs.map((h) => {
    const s = stat(h);
    return `<div class="stat"><b class="${s.cls}">${s.b}</b><span>${s.span}</span></div>`;
  }).join('')}</div>
      <p class="note">「新進榜」＝成交值名次進入前 ${data.top}，而<b>前一個交易日不在前 ${data.top}</b>。
        成交值衝上來是一件關於<b>量</b>的事，這一頁問的是它之後跟<b>價</b>有沒有關係。</p>
    </section>
    ${data.groups.slice(1).map((g) => `<section class="card">
      <h2>${esc(g.label)} <small>中位數 · 四分位 · 上漲比例</small></h2>
      ${entryTable(g, hs)}
      ${g.key === 'stay' ? `<p class="note"><b>⚠️ 這一組不能拿來做決策。</b>「站穩幾天」是
        <b>事後</b>才知道的 —— 進榜當天你不知道它會不會站穩五天。而且「+1 日」那一格還有
        循環性：一檔能站穩五天，有一部分原因就是它這五天一直漲、成交值一直大；
        用被測期間內發生的事去分組，再去測那一段的報酬，等於自己證明自己。
        這一組講的是「事後回頭看，那一群長什麼樣」，不是「看到什麼就該做什麼」。</p>` : ''}
      ${g.key === 'rank' ? `<p class="note">進榜名次越前面樣本越少 —— 能一進榜就直接衝到前 50 名的
        本來就罕見（${g.rows[0].n} 筆）。少於 ${data.min} 筆的那一格留白，不給數字：
        十幾筆的中位數只是噪音。</p>` : ''}
    </section>`).join('')}
    <section class="card">
      <h2>這一頁在講什麼 <small>以及不能拿它講什麼</small></h2>
      <p class="note"><b>這是歷史統計描述，不是訊號，也不是投資建議。</b>它回答的是
        「過去這一群後來怎麼走」，沒有回答「為什麼」，更沒有回答「下一次會怎樣」。</p>
      <p class="note">表格給的是<b>中位數與四分位</b>，不是平均。+20 日的平均是 +4.9%、
        中位數只有 ${all['20'] ? `${all['20'].med.toFixed(2)}%` : '—'} —— 分布右偏，
        少數大漲的把平均整個拉高。中位數才是「典型的那一檔」，而四分位那一行才看得出
        <b>範圍有多寬</b>：+20 日的四分位是
        ${all['20'] ? `${all['20'].p25.toFixed(1)}% ~ +${all['20'].p75.toFixed(1)}%` : '—'}，
        中間那一半就橫跨了二十幾個百分點。</p>
      <p class="note"><b>價格沒有還原權值。</b>收盤價就是收盤價，除權息當天的跳空算進報酬裡。
        台股的除權息集中在 7~8 月，而這份統計的價格區間（${esc(data.first)} ~ ${esc(data.last)}）
        正好涵蓋那一段 —— 所以這個偏差是<b>系統性偏負</b>的。中位數比平均耐得住一些，
        但擋不住整群同時除息。</p>
      <p class="note">名次序列從 ${esc(state.index.dates[0])} 就有（${state.index.dates.length} 個交易日、
        全期間 16,647 次進榜），但<b>全市場收盤價是後來才開始存的</b>，只有
        ${esc(data.first)} 起的 ${data.days} 天。一檔「一日行情」的股票隔天就掉出前 ${KEPT} 名，
        每日檔從此沒有它的價，所以價格一定要讀 <code>docs/data/close/</code> ——
        那份的起點就是這份統計的起點，${data.n} 筆是這樣來的。</p>
      <p class="note">這一頁<b>不吃頂部的日期與範圍選單</b>：它是整段歷史的彙總，不是某一天的
        快照。市場的差別在上面「依市場」那張表裡。</p>
    </section>`;
}

// --------------------------------------------------------------------------
// 分頁：週月（週與月的累計維度）
//
// 全站其他頁的維度都是「日」：今天誰在榜上、今天誰買最多。但「這一週誰最熱」
// 與「這個月誰天天在榜上」是另一種問題 —— 一檔爆量一天就掉下去的，跟一檔連著
// 二十天都排在中段的，在日維度上看起來沒差多少，累計起來差很多。
//
// 三張榜各自回答一個問題：
//   累計成交值   這一段期間，錢最集中在哪幾檔
//   進榜天數     誰是常客（而不是只來了一天）
//   期間新進榜   這一段期間才第一次擠進前 TOP 的是誰
//
// ## 資料是 history/，不是 daily/
//
// 週與月要把一整段期間的每一天加起來，而 daily/ 是一天一個檔（一天 66 KB，
// 一個月要抓二十幾個）。history/{範圍}/{年}.json 是現成的轉置表（個股 -> 每一天的
// 名次與成交值），一整年一個檔，個股頁本來就在用它、也已經有快取。
//
// ## 一個一定要講的邊界：history 只留前 300 名
//
// `p` 裡只有「那一天排進前 KEPT 名」的日子。所以這裡的「累計成交值」嚴格說是
// **「排進前 300 名的那幾天的成交值總和」**，不是這一檔那一段期間的全部成交值。
// 對榜上那幾檔來說差別很小（排不進前 300 的日子本來就沒多少量），但它是個真的
// 邊界，畫面上要寫出來 —— 不然「累計成交值」四個字會被讀成一個它不是的東西。
// --------------------------------------------------------------------------
const PERIODS = [
  { value: 'w', label: '本週' },
  { value: 'm', label: '本月' },
];
const PERIOD_KEY = 'stocktracker.period';
const PERIOD_TOP = 50;       // 累計成交值榜取前幾名
const PERIOD_SIDE = 20;      // 另外兩張榜取前幾名

/** 選定日期所屬的那一週（週一到週日）或那一個月，回傳 [起, 迄] 兩個日期字串。 */
function periodRange(date, mode) {
  if (mode === 'm') return [`${date.slice(0, 7)}-01`, `${date.slice(0, 7)}-31`];
  // 週一為起點。getUTCDay() 的週日是 0，換算成「距離上一個週一幾天」
  const day = new Date(`${date}T00:00:00Z`);
  const back = (day.getUTCDay() + 6) % 7;
  const monday = new Date(day.getTime() - back * 86400000);
  const sunday = new Date(monday.getTime() + 6 * 86400000);
  return [monday.toISOString().slice(0, 10), sunday.toISOString().slice(0, 10)];
}

/**
 * 把一段期間的每一天加起來 -> [{code, name, value, days, top, first}]。
 *
 * value 是累計成交值（億）、days 是這段期間有進前 KEPT 名的天數、
 * top 是進前 TOP 名的天數、first 是這段期間第一次進前 TOP 的日期（沒有就 null）。
 */
function periodRows(years, dates, before) {
  const acc = new Map();
  for (const payload of years) {
    const offsets = payload.dates;
    for (const [code, record] of Object.entries(payload.stocks)) {
      for (const [offset, rank, value] of record.p) {
        const date = offsets[offset];
        if (!dates.has(date)) continue;
        let row = acc.get(code);
        if (!row) {
          row = { code, name: record.name, value: 0, days: 0, top: 0, first: null };
          acc.set(code, row);
        }
        row.name = record.name;
        row.value += value;
        row.days += 1;
        if (rank <= TOP) {
          row.top += 1;
          // 期間新進榜：這一天在前 TOP、而前一個交易日不在
          if (!row.first && !before.has(`${code}@${date}`)) row.first = date;
        }
      }
    }
  }
  return [...acc.values()];
}

function periodRow(entry, seq, extra) {
  return `<a class="row" href="#/stock/${entry.code}">
    <div class="rank"><span class="no">${seq}</span></div>
    <div class="ident">
      <span class="name">${state.watch.has(entry.code) ? '<span class="star">★</span>' : ''}${esc(entry.name)}</span>
      <span class="code">${entry.code}${hasIndustry() ? ` · ${esc(industryOf(entry.code))}` : ''}</span>
    </div>
    <div class="figures">
      <span class="value">${fmtOku(entry.value)}</span>
      <span class="price">${extra}</span>
    </div>
  </a>`;
}

/**
 * 三張榜共用的清單。手機沿用 periodRow 那一行 extra（每張榜各自關心的數字），桌面
 * 把它拆成欄——三張榜的欄位一樣，因為 extra 講的那幾個數字每一列本來就都帶著。
 * days 是這段期間的交易日數，只有「進前 TOP 幾天」那一欄的分母要用到。
 */
const periodList = (entries, days, extra) => listOf(entries,
  (r, i) => periodRow(r, i + 1, extra(r)),
  () => ({
    href: (r) => `#/stock/${r.code}`,
    cols: [
      colSeq,
      col('名稱', W.name, 'w-name', (r) => wideName(r.code, r.name)),
      ...(hasIndustry() ? [colIndustry((r) => r.code)] : []),
      col('累計成交值', W.val, 'w-num w-val', (r) => fmtOku(r.value)),
      col('平均一天', W.val, 'w-num', (r) => fmtOku(r.value / r.days)),
      col(`進前 ${KEPT}`, W.days, 'w-num', (r) => `${r.days} 天`),
      col(`進前 ${TOP}`, W.days, 'w-num', (r) => `${r.top}/${days} 天`),
      col('期間首次進榜', W.date, 'w-num w-streak', (r) => r.first || '—'),
    ],
  }));

async function renderPeriod(view) {
  const mode = state.period;
  const [from, to] = periodRange(state.date, mode);
  const inRange = state.index.dates.filter((d) => d >= from && d <= to);
  const label = mode === 'm' ? `${state.date.slice(0, 7)} 整月` : `${from} ~ ${to} 這一週`;

  const controls = `<div class="controls">${pills('period', PERIODS, mode)}</div>`;
  if (!inRange.length) {
    view.innerHTML = `${controls}<p class="hint">${esc(label)}沒有任何交易日。</p>`;
    return;
  }

  // 一段期間可能跨年（跨年的那一週），所以把涉及的年份都載進來
  const years = [...new Set(inRange.map((d) => d.slice(0, 4)))];
  const loaded = await Promise.all(years.map((y) => loadHistory(y, state.scope)));

  // 判斷「期間新進榜」要知道前一個交易日在不在榜上，而那一天可能在期間之外
  const at = state.index.dates.indexOf(inRange[0]);
  const prevDate = at > 0 ? state.index.dates[at - 1] : null;
  const before = new Set();
  for (const payload of loaded) {
    for (const [code, record] of Object.entries(payload.stocks)) {
      for (const [offset, rank] of record.p) {
        const date = payload.dates[offset];
        if (rank > TOP) continue;
        // key 是「這一檔在 date 的下一個交易日算不算已經在榜上」
        const next = state.index.dates[state.index.dates.indexOf(date) + 1];
        if (next) before.add(`${code}@${next}`);
      }
    }
  }

  const dateSet = new Set(inRange);
  const rows = periodRows(loaded, dateSet, before);
  const byValue = [...rows].sort((a, b) => b.value - a.value);
  const byDays = [...rows].filter((r) => r.top)
    .sort((a, b) => b.top - a.top || b.value - a.value);
  const rookies = rows.filter((r) => r.first).sort((a, b) => a.first.localeCompare(b.first)
    || b.value - a.value);

  const total = byValue.reduce((sum, r) => sum + r.value, 0);
  setExport(`週月_${mode}_${state.scope}_${from}_${to}.csv`,
    ['代號', '名稱', '產業', '累計成交值(億)', '進前300天數', `進前${TOP}天數`, '期間首次進榜'],
    byValue.map((r) => [r.code, r.name, hasIndustry() ? industryOf(r.code) : '',
      r.value.toFixed(2), r.days, r.top, r.first || '']));

  view.innerHTML = `
    ${controls}
    ${exportBar()}
    <section class="card">
      <h2>${mode === 'm' ? '本月' : '本週'}累計 <small>${esc(label)} · ${inRange.length} 個交易日 · ${esc(scopeLabel())}</small></h2>
      <div class="stat-grid">
        <div class="stat"><b>${inRange.length}</b><span>交易日</span></div>
        <div class="stat"><b>${fmtOku(total)}</b><span>榜上累計成交值</span></div>
        <div class="stat"><b>${rows.length}</b><span>期間出現過的股票</span></div>
        <div class="stat"><b>${byDays.filter((r) => r.top === inRange.length).length}</b><span>天天在前 ${TOP}</span></div>
        <div class="stat"><b>${rookies.length}</b><span>期間新進榜</span></div>
        <div class="stat"><b class="sm">${esc(from)} ~ ${esc(to)}</b><span>期間</span></div>
      </div>
      <p class="note">期間由頂部的<b>日期選單</b>決定：選哪一天，就看那一天所屬的
        ${mode === 'm' ? '整個月' : '那一週（週一到週日）'}。最後一段期間通常還沒走完
        —— 上面的交易日數就是實際算進去的天數。</p>
      <p class="note"><b>「累計成交值」是「排進前 ${KEPT} 名的那幾天的成交值總和」</b>，不是這一檔
        期間內的全部成交值。本站的歷史序列只留每天前 ${KEPT} 名，排不進去的日子沒有紀錄。
        對榜上這幾檔來說差別很小（排不進前 ${KEPT} 名的日子本來就沒多少量），
        但它是個真的邊界。</p>
    </section>
    ${listCard(`${mode === 'm' ? '本月' : '本週'}累計成交值`, `取前 ${PERIOD_TOP} · 括號是進前 ${KEPT} 名的天數`,
      periodList(byValue.slice(0, PERIOD_TOP), inRange.length,
        (r) => `${r.days} 天 · 平均 ${fmtOku(r.value / r.days)}`),
      '這段期間沒有任何資料')}
    ${listCard(`進前 ${TOP} 名天數最多`, `取前 ${PERIOD_SIDE} · 同天數比累計成交值`,
      periodList(byDays.slice(0, PERIOD_SIDE), inRange.length,
        (r) => `${r.top}/${inRange.length} 天在前 ${TOP}`),
      `這段期間沒有任何一檔進過前 ${TOP}`)}
    ${listCard('期間新進榜', `第一次擠進前 ${TOP} 的那一天 · 取前 ${PERIOD_SIDE}`,
      periodList(rookies.slice(0, PERIOD_SIDE), inRange.length,
        (r) => `${r.first} 首次 · 之後 ${r.top} 天在榜`),
      `這段期間沒有任何一檔是新進榜（都是原本就在榜上的）`)}
    <section class="card">
      <h2>這一頁在講什麼 <small>以及不能拿它講什麼</small></h2>
      <p class="note">全站其他頁的維度都是「日」。一檔爆量一天就掉下去的，跟一檔連著二十天
        都排在中段的，在日維度上看起來沒差多少，<b>累計起來差很多</b> —— 這一頁就是為了
        把那個差別顯出來。「累計成交值」看錢集中在哪，「進榜天數」看誰是常客。</p>
      <p class="note">資料是 <code>docs/data/history/</code> 的轉置表（個股 → 每一天的名次與
        成交值），一整年一個檔，個股頁本來就在用、已經有快取。不用每日檔是因為一個月要
        抓二十幾個。</p>
      <p class="note">成交值大不等於漲。這三張榜講的都是<b>量</b>，不是價 ——
        量能集中的那幾檔裡，漲的跌的都有。要看價，去個股頁或「後續」頁。</p>
    </section>`;
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

/**
 * 爆量清單。開盤價是後來才加的欄位，加欄位之前抓的日子沒有——整批都沒有的時候
 * 就不要出那一欄（一整欄破折號只是佔位置）。
 */
const burstList = (stocks, baseMap) => listOf(stocks,
  (s) => burstRow(s, baseMap.get(s.code)),
  (list) => ({
    href: (s) => `#/stock/${s.code}`,
    cols: [
      col('名次', W.rank, 'w-rank',
        (s) => `<b>${s.rank}</b>${deltaBadge(s.rank, (baseMap.get(s.code) || {}).rank)}`),
      col('名稱', W.name, 'w-name', (s) => wideName(s.code, s.name, s.m)),
      ...(hasIndustry() ? [colIndustry((s) => s.code)] : []),
      col('成交量', W.lots, 'w-num w-val', (s) => `${num(lots(s.volume), 0)} 張`),
      col('量能', W.note, 'w-num w-streak', (s) => volHighLabel(volHigh(s))),
      ...(list.some((s) => s.open !== null && s.open !== undefined)
        ? [col('開盤', W.price, 'w-num', (s) => cellNum(s.open))] : []),
      col('收盤', W.price, 'w-num', (s) => cellNum(s.close)),
      col('漲跌%', W.pct, 'w-num', (s) => widePct(s.changePct)),
    ],
  }));

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
      burstList(hits, baseMap),
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
 * 均線清單。手機把「狀態、四線標記」疊在名稱底下，桌面各給一欄——四線標記本來就是
 * 一排並列的記號，擠在名稱下面那行反而看不出它是一個獨立的維度。
 */
const maList = (stocks, baseMap, win) => listOf(stocks,
  (s) => maRow(s, baseMap.get(s.code), win),
  () => ({
    href: (s) => `#/stock/${s.code}`,
    cols: [
      col('名次', W.rank, 'w-rank',
        (s) => `<b>${s.rank}</b>${deltaBadge(s.rank, (baseMap.get(s.code) || {}).rank)}`),
      col('名稱', W.name, 'w-name', (s) => wideName(s.code, s.name, s.m)),
      ...(hasIndustry() ? [colIndustry((s) => s.code, true)] : []),
      col('收盤', W.price, 'w-num', (s) => cellNum(s.close)),
      col('漲跌%', W.pct, 'w-num', (s) => widePct(s.changePct)),
      col(`${win} 日線`, W.price, 'w-num', (s) => cellNum(maPrice(s, win))),
      col('乖離', W.pct, 'w-num', (s) => {
        const line = maPrice(s, win);
        const bias = line ? (s.close / line - 1) * 100 : null;
        return bias === null ? '—' : `<em class="${trend(bias)}">${signed(bias)}</em>`;
      }),
      col('狀態', W.note, 'w-num w-streak', (s) => maRunLabel(maRun(s, win))),
      col('均線與 MACD', W.chipsMacd, 'w-chips',
        (s) => `${maChips(s)}${macdChip(s)}`),
    ],
  }));

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
      maList(hits, baseMap, win),
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

/**
 * MACD 清單。「近 N 日」看的是已經交叉的那幾檔，右邊該給 DIF／DEA；「明天／後天」
 * 看的是還沒交叉的，右邊該給臨界價與還要走幾 %。手機版把兩者塞進同一行小字，桌面
 * 直接換欄——同一批資料裡不會兩種混在一起，所以看整批的第一筆就決定得了。
 */
const macdList = (stocks, baseMap, side, when) => listOf(stocks,
  (s) => macdRow(s, baseMap.get(s.code), side, when),
  (list) => ({
    href: (s) => `#/stock/${s.code}`,
    cols: [
      col('名次', W.rank, 'w-rank',
        (s) => `<b>${s.rank}</b>${deltaBadge(s.rank, (baseMap.get(s.code) || {}).rank)}`),
      col('名稱', W.name, 'w-name', (s) => wideName(s.code, s.name, s.m)),
      ...(hasIndustry() ? [colIndustry((s) => s.code)] : []),
      col('收盤', W.price, 'w-num', (s) => cellNum(s.close)),
      col('漲跌%', W.pct, 'w-num', (s) => widePct(s.changePct)),
      col('狀態', W.note, 'w-num w-streak', (s) => macdStateLabel(s, side)),
      ...(list.some((s) => s.outlook) ? [
        col(`${when === 'd1' ? '明天' : '後天'}臨界`, W.price, 'w-num',
          (s) => (s.outlook ? cellNum(s.outlook.target) : '—')),
        col('還要走', W.pct, 'w-num',
          (s) => (s.outlook ? `<em class="${trend(s.outlook.need)}">${signed(s.outlook.need)}</em>` : '—')),
      ] : [
        col('DIF', W.pct, 'w-num',
          (s) => { const m = macdOf(s); return m ? cellNum(macdDif(m)) : '—'; }),
        col('DEA', W.pct, 'w-num',
          (s) => { const m = macdOf(s); return m ? cellNum(m.dea) : '—'; }),
      ]),
      col('均線', W.chips, 'w-chips', (s) => maChips(s)),
    ],
  }));

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
      macdList(hits, baseMap, side, when),
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
/**
 * K 線。level 給了就在圖上疊一條水平線（目前用來畫法人的買均／賣均）。
 * 水平線用一個「每一格都同值」的 line dataset 畫，不必為了一條線多載一個外掛。
 */
function drawCandles(Chart, canvas, series, offset = 0, level = null) {
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
        ...(level ? [{
          type: 'line',
          label: level.label,
          data: labels.map(() => level.value),
          borderColor: level.color,
          borderWidth: 1.2,
          borderDash: [5, 4],
          pointRadius: 0,
          order: 1,
        }] : []),
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
    const hits = top
      .filter((s) => !key || s.code.toLowerCase().includes(key) || s.name.toLowerCase().includes(key))
      .slice(0, 60);
    $('#pick').innerHTML = stockList(hits.map((s) => ({ s })))
      || '<p class="hint">找不到符合的股票</p>';
  };
  paint();
  $('#q2').addEventListener('input', (e) => paint(e.target.value));
}

// --------------------------------------------------------------------------
// 個股的法人歷史
//
// 買超頁看的是「這一天全市場誰買最多」，個股頁要的是反過來的「這一檔過去幾週
// 法人怎麼進出」。資料是後端轉置好的 insti/stock/{代號}.json（一檔一個檔）——
// 前端自己抓幾十天的每日檔來轉的話，一天 43 KB、抓 60 天是 2.6 MB，
// 而使用者要的只有其中一檔。
//
// 日期是**稀疏**的：三邊的估算金額都不到 0.05 億的那幾天不進每日檔，這裡也就沒有。
// 缺的那幾天代表「那天法人動的是零頭」，不是「沒有資料」，所以畫成 0 是對的
// —— 但要在說明裡講出來，不然看起來像斷訊。
// --------------------------------------------------------------------------
// 每一天存的四個值，順序即 scripts/institutions.py 的 STOCK_FIELDS。
const S_FO = 0;
const S_TR = 1;
const S_DE = 2;
const S_CLOSE = 3;

// 三邊在圖上的顏色。與買超頁的 chip 沒有共用色票（那裡靠紅綠表示買賣方向），
// 這裡三條並排，要的是彼此分得開。
const INSTI_COLORS = { fo: '#2f6fed', tr: '#7b61ff', de: '#e8912d' };

function loadInstiStock(code) {
  if (!state.instiStock.has(code)) {
    // 這一檔從來沒沾到過法人的買賣（或整份資料還沒轉置）就是 404，不是錯誤
    state.instiStock.set(code, getJSON(`${DATA}/insti/stock/${code}.json`).catch(() => null));
  }
  return state.instiStock.get(code);
}

/**
 * 序列檔 -> [{date, fo, tr, de, close}]（金額已換成億），只留 state.date 當天以前的。
 * 個股頁的日期選單可以往回翻，翻到哪一天就只該看到那一天為止的資料。
 */
function instiStockRows(payload, upTo) {
  if (!payload || !payload.d) return [];
  const out = [];
  payload.d.forEach((date, i) => {
    if (date > upTo) return;
    const row = payload.v[i];
    const close = row[S_CLOSE];
    out.push({
      date,
      close,
      fo: (row[S_FO] * close) / 1e8,
      tr: (row[S_TR] * close) / 1e8,
      de: (row[S_DE] * close) / 1e8,
      lots: { fo: row[S_FO], tr: row[S_TR], de: row[S_DE] },
    });
  });
  return out;
}

/**
 * 最後 win 個有資料的交易日裡，「與淨額同方向那幾天」的股數加權收盤均價。
 *
 * 與後端 avg_prices() 必須是同一個定義，不然個股頁與買超頁會給出兩個不一樣的
 * 數字。**不能**用「累計金額 ÷ 累計股數」——淨額是相減的結果，拿它當分母會算出
 * 負的價格（見 institutions.py 的說明）。
 */
function instiAvgPrice(rows, key, win) {
  const tail = rows.slice(-win);
  const net = tail.reduce((sum, r) => sum + r.lots[key], 0);
  if (!net) return null;
  const want = net > 0 ? 1 : -1;
  let amount = 0;
  let shares = 0;
  for (const r of tail) {
    const lots = r.lots[key];
    if (lots && Math.sign(lots) === want) {
      amount += lots * r.close;
      shares += lots;
    }
  }
  return shares ? amount / shares : null;
}

/** 堆疊長條圖。三邊疊在一起，零軸上下各自是買超與賣超。 */
function drawStack(Chart, canvas, labels, series, suffix = '') {
  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: series.map((s) => ({
        label: s.label,
        data: s.data,
        backgroundColor: s.color,
        borderWidth: 0,
        categoryPercentage: 1,
        barPercentage: 0.85,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: (c) => `${c.dataset.label}：${c.parsed.y > 0 ? '+' : ''}${num(c.parsed.y, 2)}${suffix}`,
          },
        },
      },
      scales: {
        x: { stacked: true, ticks: { maxTicksLimit: 5, font: { size: 10 } }, grid: { display: false } },
        y: {
          stacked: true,
          ticks: { font: { size: 10 } },
          grid: { color: 'rgba(128,128,128,.18)' },
        },
      },
    },
  });
  state.charts.push(chart);
}

async function renderStock(view, code) {
  if (!code) return renderStockPicker(view);

  const [{ name, byDate }, todayPayload, instiSeries] = await Promise.all([
    seriesFor(code), loadDaily(state.date), loadInstiStock(code)]);
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

  // 法人：只留這一段期間、而且不晚於選定日期的那幾天
  const instiAll = instiStockRows(instiSeries, state.date);
  const insti = instiAll.filter((r) => r.date >= labels[0]);
  const legSum = (key) => insti.reduce((sum, r) => sum + r[key], 0);
  const instiTotals = { fo: legSum('fo'), tr: legSum('tr'), de: legSum('de') };
  const instiNet = instiTotals.fo + instiTotals.tr + instiTotals.de;
  // 買均用「最後 20 個有資料的交易日」，與買超頁的近 20 日那一欄同一個定義。
  // 它不受上面的期間 pill 影響 —— 20 日就是 20 日，跟著畫面縮放會變成另一個數字。
  const avgWin = 20;
  const avgPrice = instiAvgPrice(instiAll, 'fo', avgWin);
  const avgTail = instiAll.slice(-avgWin);
  const avgNet = avgTail.reduce((sum, r) => sum + r.lots.fo, 0);
  // 湊不滿 20 天的要標出來。少算幾天的均價看起來跟滿 20 天的一模一樣，
  // 而資料起點附近（本站法人資料才開始沒多久）大部分個股都湊不滿。
  const avgShort = avgTail.length < avgWin;
  const avgLabel = `外資 ${avgWin}${avgShort ? '−' : ''} 日${avgNet > 0 ? '買均' : '賣均'}`;
  // 選定那一天的土洋標記（門檻沿用法人頁那一組 pill，選過的會記住）
  const instiToday = instiAll.find((r) => r.date === state.date);
  const instiTag = instiToday ? instiTagOf(instiToday.fo, instiToday.tr, state.instiMin) : null;
  const avgDaysText = avgShort
    ? `這一檔只有 ${avgTail.length} 天有法人資料，所以是那 ${avgTail.length} 天的`
    : `最近 ${avgWin} 個有法人資料的交易日裡，`;

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
           價格沒有還原權值，除權息當天的跳空是真的跳空，不是資料錯。</p>
           ${avgPrice === null ? '' : `<p class="note">那條虛線是<b>${esc(avgLabel)}</b>
           ${num(avgPrice, 2)}：${avgDaysText}外資
           ${avgNet > 0 ? '買進' : '賣出'}的那幾天的股數加權收盤均價。
           <b>它不是外資的成本</b> —— 官方的個股資料只有股數，這裡的價一律是收盤價，
           真正的成交均價在盤中。它也不隨上面的期間選單改變，20 日就是 20 日。</p>`}`
        : `<p class="hint">這一段期間沒有四價資料。K 線的資料${klineStart ? `自 ${klineStart} 起` : '尚未產生'}，
           較早的日子只有成交值排行。</p>`}
    </section>
    <section class="card">
      <h2>三大法人買賣超 <small>${insti.length
        ? `近 ${labels.length} 個交易日裡有 ${insti.length} 天` : '無資料'}</small>
        ${instiTagChip(instiTag)}</h2>
      ${instiTag ? `<p class="note">${esc(state.date)} 這一天是
        <b>${esc(INSTI_TAGS[instiTag].label)}</b>：${esc(INSTI_TAGS[instiTag].say)}，
        兩邊各自都達 ${state.instiMin} 億（門檻在「法人」頁可以改）。</p>` : ''}
      ${insti.length ? `
      <div class="stat-grid">
        <div class="stat"><b class="${trend(instiTotals.fo)}">${signedOku(instiTotals.fo)}</b><span>外資區間累計</span></div>
        <div class="stat"><b class="${trend(instiTotals.tr)}">${signedOku(instiTotals.tr)}</b><span>投信區間累計</span></div>
        <div class="stat"><b class="${trend(instiTotals.de)}">${signedOku(instiTotals.de)}</b><span>自營區間累計</span></div>
        <div class="stat"><b class="${trend(instiNet)}">${signedOku(instiNet)}</b><span>三大法人合計</span></div>
        <div class="stat"><b>${avgPrice === null ? '—' : num(avgPrice, 2)}</b><span>${esc(avgLabel)}</span></div>
        <div class="stat"><b>${pair(insti.filter((r) => r.fo > 0).length, insti.filter((r) => r.fo < 0).length)}</b><span>外資買 / 賣 天數</span></div>
      </div>
      <div class="chart-box"><canvas id="c-insti"></canvas></div>
      <p class="note">紅綠是買賣方向、三種顏色是三邊法人，零軸上下分開堆疊。
        金額是<b>估算</b>的：官方的個股資料只有股數，這裡一律是「買賣超股數 ×
        當日收盤價」。</p>
      <p class="note">圖上只有<b>那幾天</b>：三邊的估算金額都不到 0.05 億的日子不會進本站的
        法人資料檔，所以近 ${labels.length} 個交易日裡只有 ${insti.length} 天在圖上。
        缺的那幾天不是沒有資料，是那天法人動的是零頭。</p>`
      : `<p class="hint">這一檔在本站的法人資料期間內沒有明顯的三大法人買賣
        （三邊的估算金額都不到 0.05 億的日子不會收）。<br>
        法人資料涵蓋 ${esc((state.index.instiFirst) || '較短的一段期間')}，比成交值排行短。</p>`}
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
    if (drawn) {
      drawCandles(Chart, $('#c-kline'), series, klineFrom,
        avgPrice === null ? null : { value: avgPrice, label: avgLabel, color: INSTI_COLORS.fo });
    }
    if (insti.length) {
      drawStack(Chart, $('#c-insti'), insti.map((r) => r.date), [
        { label: '外資', data: insti.map((r) => Number(r.fo.toFixed(2))), color: INSTI_COLORS.fo },
        { label: '投信', data: insti.map((r) => Number(r.tr.toFixed(2))), color: INSTI_COLORS.tr },
        { label: '自營', data: insti.map((r) => Number(r.de.toFixed(2))), color: INSTI_COLORS.de },
      ], ' 億');
    }
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

/**
 * 大戶清單。手機一列擠著三段 chip（千張／散戶／股東）加右邊三行數字，桌面一段一欄
 * ——這一頁的四張榜排序依據各不相同（大戶比例、戶數、股東人數），欄位攤開才看得出
 * 「這一張是依哪一個數字排的」。
 */
const holderList = (entries) => listOf(entries, holderRow, () => ({
  href: (e) => `#/holders/${e.stock.code}`,
  cols: [
    col('名次', W.rank, 'w-rank', (e) => `<b>${e.stock.rank}</b>`),
    col('名稱', W.name, 'w-name',
      (e) => wideName(e.stock.code, e.stock.name, e.stock.m)),
    ...(hasIndustry() ? [colIndustry((e) => e.stock.code, true)] : []),
    col(`${state.holderLots} 張以上`, W.pp, 'w-num w-val',
      (e) => pctText(bigAt(e.cur))),
    col('變化', W.pp, 'w-num', (e) => {
      const d = holderDelta(e, bigAt);
      return d === null ? '—' : `<em class="${trend(d)}">${ppText(d)}</em>`;
    }),
    col('大戶戶數', W.heads, 'w-num', (e) => headsText(bigHeads(e.cur))),
    col('戶數變化', W.pp, 'w-num', (e) => {
      const d = holderDelta(e, bigHeads);
      return d === null ? '—' : `<em class="${trend(d)}">${headsDelta(d)}</em>`;
    }),
    col('散戶', W.pct, 'w-num', (e) => pctText(smallAt(e.cur))),
    col('股東人數', W.heads, 'w-num', (e) => peopleText(e.cur[H_PEOPLE])),
    col('人數變化', W.pp, 'w-num', (e) => {
      const d = peopleChange(e);
      return d === null ? '—' : `<em class="${trend(d)}">${signedPct(d, 1)}</em>`;
    }),
  ],
}));

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
      holderList(up.slice(0, HOLDER_TOP)),
      base ? `這個期間榜上沒有任何一檔的${lotsText()}比例上升` : '沒有基準可比')}
    ${listCard('大戶減碼', `${spec.label}${lotsText()}的比例減少最多 · 取前 ${HOLDER_TOP}`,
      holderList(down.slice(0, HOLDER_TOP)),
      base ? `這個期間榜上沒有任何一檔的${lotsText()}比例下降` : '沒有基準可比')}
    ${listCard('籌碼最集中', `${lotsText()}的比例最高 · 取前 ${HOLDER_TOP}`,
      holderList(concentrated.slice(0, HOLDER_TOP)))}
    ${listCard('股東人數減少最多', `${spec.label} · 取前 ${HOLDER_TOP}`,
      holderList(shrinking.slice(0, HOLDER_TOP)),
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
// 分頁：法人（三大法人買賣超）
//
// 這一頁只問一件事：**外資與投信有沒有站在同一邊**。
//
// 兩者的錢性質不同，所以「同買」才有意思。外資動的是全球資金的配置，一天幾百億、
// 常常是被動的（ETF 調整成分、指數換股、避險部位），對個別公司的看法不見得在裡面。
// 投信動的是國內主動型基金，一檔幾千萬到幾億，經理人得對每一筆負責，通常也真的
// 跑過公司。兩邊的理由本來各自獨立，同一天在同一檔上同向，才代表兩種完全不同的
// 決策流程指到了同一個地方。
//
// 反過來，只有一邊在動的很常見也很難解讀：外資買超十億可能只是某檔 ETF 在建倉，
// 投信賣超三億可能只是基金在應付贖回。所以單邊的買超排行不在這一頁，而在隔壁的
// 「買超」頁 —— 那張榜前幾名幾乎天天是同一批權值股，要讓它有資訊，得配上
// 「逆勢」那一刀（買超而收黑），所以它自成一頁，見 renderInstiRank()。
//
// 三件事一定要先講清楚，不然這一頁很容易被讀成「跟著買就對了」：
//   1. **金額是估算的。** 官方的個股資料從頭到尾只有股數，金額＝股數 × 收盤價。
//      門檻邊緣的個股會因為這幾個百分點進出榜。表頭的全市場合計才是官方金額。
//   2. **買超不等於看多。** 外資的買超裡混著避險、借券還券與指數調整；投信在季底
//      與年底有作帳的動機。淨額只說了「這些帳戶今天淨買進」，沒說為什麼。
//   3. **淨額看不出成本。** 同樣買超一億，開盤搶進與收盤前掛低接的處境完全不同，
//      日報表只有一個淨數字，分不出來。
// --------------------------------------------------------------------------
// 「同買／同賣」的門檻：兩邊各自都要達到這個金額。0.5 億是市場上最常用的說法，
// 也差不多是「投信一檔基金認真布局」的量級；小型股上 3 億幾乎不會出現。
const INSTI_MINS = [
  { value: 0.3, label: '0.3 億' },
  { value: 0.5, label: '0.5 億' },
  { value: 1, label: '1 億' },
  { value: 3, label: '3 億' },
];
const INSTI_MIN_KEY = 'stocktracker.instimin';

// 每一檔存的五個值，順序即 scripts/institutions.py 的 FIELDS，兩邊必須一致。
const I_NAME = 0;      // 簡稱
const I_FO = 1;        // 外資買賣超股數（外陸資 + 外資自營商）
const I_TR = 2;        // 投信買賣超股數
const I_DE = 3;        // 自營商買賣超股數（自行買賣 + 避險）
const I_CLOSE = 4;     // 當日收盤價，金額由這裡乘出來

const INSTI_TOP = 30;  // 每張榜最多列幾檔

function loadInstiIndex() {
  // 目錄決定「哪幾天有法人資料」，讀到舊的就永遠看不到今天的，一律抓最新的；
  // 每日檔是「同一個網址內容不再變」的檔案，照常吃快取。
  if (!state.insti) state.insti = getJSON(`${DATA}/insti/index.json`, { cache: 'reload' });
  return state.insti;
}

function loadInstiDay(date) {
  if (!state.instiDay.has(date)) {
    state.instiDay.set(date, getJSON(`${DATA}/insti/daily/${date}.json`));
  }
  return state.instiDay.get(date);
}

/**
 * 億元。個股的估算金額從 0.3 億到幾百億都有，位數固定會讓一頭看不出差別、
 * 另一頭塞滿沒有意義的小數，所以按量級給位數。
 */
const signedOku = (oku) => {
  if (oku === null || oku === undefined) return '—';
  const size = Math.abs(oku);
  return `${oku > 0 ? '+' : ''}${num(oku, size < 10 ? 2 : size < 100 ? 1 : 0)} 億`;
};

/** 買賣超張數。零股在法人的日報表裡是常態，但幾百股在畫面上沒有意義，取整到張。 */
const signedLots = (shares) =>
  `${shares > 0 ? '+' : ''}${num(shares / 1000, 0)} 張`;

/** 每日檔攤平成一排：{代號, 市場, 簡稱, 收盤, 三邊的股數與估算金額}。 */
function instiRows(payload) {
  const out = [];
  for (const market of Object.keys(payload.stocks || {})) {
    for (const [code, row] of Object.entries(payload.stocks[market] || {})) {
      const close = row[I_CLOSE];
      out.push({
        code,
        market,
        name: row[I_NAME],
        close,
        lots: { fo: row[I_FO], tr: row[I_TR], de: row[I_DE] },
        fo: (row[I_FO] * close) / 1e8,
        tr: (row[I_TR] * close) / 1e8,
        de: (row[I_DE] * close) / 1e8,
      });
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// 具名籌碼異動：土洋同買與土洋對作
//
// 「土」是投信（國內主動型基金）、「洋」是外資，市場上的說法。法人頁原本只挑
// **同買／同賣**，這裡補上另一半：**對作** —— 一邊買、另一邊賣。
//
// 同買有意思的理由是「兩種完全不同的決策流程指到了同一個地方」。對作有意思的理由
// 是同一句話的反面：**兩種流程這次指到了相反的方向**。誰對誰錯事後才知道，
// 但它標示的是「這一檔現在有分歧」，那本身就是資訊 —— 而且它是同買的補集裡
// 唯一講得出內容的那一塊（只有一邊在動的那些，看不出任何東西）。
//
// 門檻與同買共用一個規則：**兩邊各自**都要達到，不是合計。對作這邊尤其必要 ——
// 外資買超十億配上投信賣超三百萬，那不是對作，那是外資在買而投信沒動。
//
// ⚠️ 徽章離「訊號」只有一步。全站不提供買賣訊號，所以這裡的文案一律是**描述**
// （「外資買、投信賣」）而不是**判斷**（「注意進場」「留意賣壓」）。這條線在徽章上
// 特別容易越過，因為徽章天生看起來就像提醒。
// --------------------------------------------------------------------------
const INSTI_TAGS = {
  both: { label: '土洋同買', cls: 'up', say: '外資與投信都買超' },
  bothSell: { label: '土洋同賣', cls: 'down', say: '外資與投信都賣超' },
  foBuy: { label: '對作·外資買', cls: 'up', say: '外資買超、投信賣超' },
  foSell: { label: '對作·外資賣', cls: 'down', say: '外資賣超、投信買超' },
};

/**
 * 一檔在某個門檻下的籌碼異動標記。兩邊各自都要達到門檻，沒有就回 null。
 * fo 與 tr 是估算金額（億），正買超負賣超。
 */
function instiTagOf(fo, tr, min) {
  if (fo >= min && tr >= min) return 'both';
  if (fo <= -min && tr <= -min) return 'bothSell';
  if (fo >= min && tr <= -min) return 'foBuy';
  if (fo <= -min && tr >= min) return 'foSell';
  return null;
}

/**
 * 一天的法人檔 -> {代號: 標記}。排行榜的徽章用這一份。
 * payload 是 null（那一天還沒有法人資料）就回空的 Map，整頁照常、只是沒有徽章。
 */
function instiTagMap(payload, min) {
  const out = new Map();
  if (!payload) return out;
  for (const row of instiRows(payload)) {
    const tag = instiTagOf(row.fo, row.tr, min);
    if (tag) out.set(row.code, tag);
  }
  return out;
}

/**
 * 代號 -> { fo, tr }（億元，正買超負賣超）。徽章只講得出「同買／對作」，桌面版的
 * 表格有欄位可以放數字，就把原始金額也帶出來——同一份已經載好的資料，不多抓東西。
 */
function instiAmountMap(payload) {
  const out = new Map();
  if (!payload) return out;
  for (const row of instiRows(payload)) out.set(row.code, { fo: row.fo, tr: row.tr });
  return out;
}

/** 徽章。放在列上的那一個小標，沿用 .streak 的視覺語言。 */
const instiTagChip = (tag) =>
  (tag ? `<span class="streak ${INSTI_TAGS[tag].cls}">${INSTI_TAGS[tag].label}</span>` : '');

/**
 * 對作的排序：依**較小的那一邊**。
 *
 * 同買榜依合計排序，但對作的合計接近零（兩邊互相抵消），拿它排序等於隨機。
 * 真正決定「這場對作有多實在」的是較小的那一邊 —— 外資買 50 億配投信賣 0.5 億，
 * 與外資買 5 億配投信賣 5 億，後者才是真的兩邊都下了重手。
 */
const instiAgainst = (rows, side, min) =>
  rows
    .filter((r) => (side === 'foBuy'
      ? r.fo >= min && r.tr <= -min
      : r.fo <= -min && r.tr >= min))
    .sort((a, b) => Math.min(Math.abs(b.fo), Math.abs(b.tr))
      - Math.min(Math.abs(a.fo), Math.abs(a.tr)));

/** 外資與投信同向、而且兩邊各自都達到門檻。'buy' 是同買、'sell' 是同賣。 */
const instiTogether = (rows, side, min) =>
  rows
    .filter((r) => (side === 'buy'
      ? r.fo >= min && r.tr >= min
      : r.fo <= -min && r.tr <= -min))
    .sort((a, b) => (side === 'buy' ? (b.fo + b.tr) - (a.fo + a.tr) : (a.fo + a.tr) - (b.fo + b.tr)));

function instiRow(entry, seq, ranked) {
  const stock = ranked.get(entry.code);
  const sum = entry.fo + entry.tr;
  const pct = stock && stock.changePct !== null && stock.changePct !== undefined
    ? ` <em class="${trend(stock.changePct)}">${stock.changePct > 0 ? '+' : ''}${stock.changePct.toFixed(2)}%</em>`
    : '';
  // 同一個門檻套在大小型股上意義完全不同，所以把「這筆合計佔了當天成交值多少」
  // 擺在金額底下。成交值只有前 300 名有（daily 就留到那裡），其餘的留白。
  const share = stock && stock.value
    ? `佔成交值 ${num((Math.abs(sum) * 1e8 / stock.value) * 100, 1)}%`
    : '—';
  return `<a class="row" href="#/stock/${entry.code}">
    <div class="rank"><span class="no">${seq}</span>
      <span class="delta flat">${stock ? `名次 ${stock.rank}` : `${KEPT} 名外`}</span></div>
    <div class="ident">
      <span class="name">${state.watch.has(entry.code) ? '<span class="star">★</span>' : ''}${esc(entry.name)}</span>
      <span class="code">${entry.code} · ${esc(MARKET_TAGS[entry.market])}${
        hasIndustry() ? ` · ${esc(industryOf(entry.code))}` : ''}</span>
      <span class="chips">${instiChips(entry)}</span>
    </div>
    <div class="figures">
      <span class="value ${trend(sum)}">${signedOku(sum)}</span>
      <span class="price">${share}</span>
      <span class="price">${num(entry.close, 2)}${pct}</span>
    </div>
  </a>`;
}

/**
 * 法人清單。這一頁問的是「外資與投信站在同一邊嗎」，所以桌面把兩邊各給一欄，合計
 * 與佔成交值接在後面——手機版那三個 chip 就是這幾個數字，只是排成一行小字。
 * 自營商不出欄：同買與對作這兩張榜的條件裡沒有它。
 */
const instiList = (entries, ranked) => listOf(entries,
  (r, i) => instiRow(r, i + 1, ranked),
  () => ({
    href: (r) => `#/stock/${r.code}`,
    cols: [
      colSeq,
      col('名稱', W.name, 'w-name', (r) => wideName(r.code, r.name, r.market)),
      ...(hasIndustry() ? [colIndustry((r) => r.code)] : []),
      col('外資', W.oku, 'w-num', (r) => wideOku(r.fo)),
      col('投信', W.oku, 'w-num', (r) => wideOku(r.tr)),
      col('合計', W.oku, 'w-num w-val', (r) => wideOku(r.fo + r.tr)),
      col('佔成交值', W.share, 'w-num',
        (r) => wideShare(r.fo + r.tr, ranked.get(r.code))),
      col('收盤', W.price, 'w-num', (r) => cellNum(r.close)),
      col('漲跌%', W.pct, 'w-num',
        (r) => widePct((ranked.get(r.code) || {}).changePct)),
      col('名次', W.back, 'w-num w-streak',
        (r) => { const s = ranked.get(r.code); return s ? s.rank : `${KEPT}+`; }),
    ],
  }));

/** 這一頁共用的一段話：這些數字能講什麼、不能拿它講什麼。 */
const INSTI_CAVEAT = `個股的金額是<b>估算</b>的：官方的三大法人日報表從頭到尾只有股數，
  這裡的金額一律是「買賣超股數 × 當日收盤價」。真正的成交均價不等於收盤價，
  拿全市場合計去對官方那張買賣金額彙總表，外資的相對誤差中位數約 5%、
  金額差距中位數 2.8 億（22 個交易日、上市與上櫃分開算）。
  量級與方向是可靠的，<b>但門檻邊緣的個股會因為這幾個百分點進出榜</b>。
  表頭那六個全市場合計是官方金額，不是估算。`;

async function renderInsti(view) {
  let index;
  try {
    index = await loadInstiIndex();
  } catch (err) {
    view.innerHTML = `<p class="hint">還沒有法人資料（${esc(err.message)}）。<br>
      請先執行 <code>scripts/fetch_institutions.py</code> 與
      <code>scripts/build_institutions.py</code>；
      要一次補上一段歷史就加 <code>--days 30</code>。</p>`;
    return;
  }
  const days = index.days || [];
  if (!days.length) {
    view.innerHTML = '<p class="hint">法人目錄裡沒有任何交易日，請重跑 scripts/build_institutions.py。</p>';
    return;
  }

  const controls = `<div class="controls">${pills('instimin', INSTI_MINS, state.instiMin)}</div>`;
  const today = days.find((d) => d.d === state.date);
  if (!today) {
    // 法人資料是後來才開始累積的，涵蓋的交易日比排行短。缺哪一天要講清楚是
    // 「還沒抓到」而不是「那天法人沒動作」，不然畫面上兩者長得一模一樣。
    view.innerHTML = `${controls}
      <p class="hint">${state.date} 還沒有法人資料。<br>
      目前有 ${days.length} 個交易日：${esc(index.first)} ~ ${esc(index.latest)}。<br>
      請把日期挪到那一段裡面，或執行
      <code>scripts/fetch_institutions.py --days 30</code> 往前回補。</p>`;
    return;
  }

  const [payload, daily] = await Promise.all([loadInstiDay(state.date), loadDaily(state.date)]);
  const ranked = new Map(daily.stocks.map((s) => [s.code, s]));
  // 頂部的範圍選單對這一頁一樣有效：選了上市就只看上市，表頭的合計也跟著只留上市
  const markets = state.scope === 'all' ? ['twse', 'tpex'] : [state.scope];
  const rows = instiRows(payload).filter((r) => markets.includes(r.market));
  const min = state.instiMin;
  const buys = instiTogether(rows, 'buy', min);
  const sells = instiTogether(rows, 'sell', min);
  const foBuy = instiAgainst(rows, 'foBuy', min);
  const foSell = instiAgainst(rows, 'foSell', min);

  // 統計格一排三個，所以要嘛三個、要嘛六個：兩個市場 × 三邊法人剛好排滿兩排
  const stats = [];
  for (const market of markets) {
    const total = today[market] || {};
    for (const [key, label] of [['fo', '外資'], ['tr', '投信'], ['de', '自營商']]) {
      stats.push({
        b: signedOku(total[key]),
        span: `${MARKET_TAGS[market]}${label}`,
        cls: trend(total[key]),
      });
    }
  }

  const both = new Set([...buys, ...sells].map((r) => r.code));
  const against = new Set([...foBuy, ...foSell].map((r) => r.code));
  view.innerHTML = `
    ${controls}
    <section class="card">
      <h2>三大法人買賣超 <small>${esc(state.date)} ${esc(scopeLabel())} · 同買 ${buys.length} 檔、同賣 ${sells.length} 檔、對作 ${against.size} 檔</small></h2>
      <div class="stat-grid">${stats
        .map((s) => `<div class="stat"><b class="${s.cls}">${s.b}</b><span>${s.span}</span></div>`)
        .join('')}</div>
      <p class="note">上面那幾格是<b>官方</b>的全市場買賣超金額${today.e ? '（這一天官方彙總表抓不到，用估算值代替）' : ''}。
        「外資」含外資自營商，「自營商」含自行買賣與避險，與市場上引用的口徑一致。</p>
      <p class="note">下面兩張榜的門檻是<b>兩邊各自</b>都要達到 ${min} 億：外資買超 ${min} 億以上
        <b>而且</b>投信也買超 ${min} 億以上才算同買。不是合計達到就算 ——
        合計那樣算的話，外資買超十億配上投信賣超九億也會進榜，方向卻是相反的。
        這一天${esc(scopeLabel())}有 ${rows.length} 檔進了資料檔（三邊的估算金額都不到
        ${payload.cut} 億的不收），其中 ${both.size} 檔在目前門檻下同買或同賣、
        ${against.size} 檔是對作。</p>
      <p class="note">底下兩張是<b>土洋對作</b>：一邊買、另一邊賣，兩邊各自都達 ${min} 億。
        同買有意思的理由是「兩種完全不同的決策流程指到了同一個地方」，對作有意思的理由
        是同一句話的反面 —— <b>這次指到了相反的方向</b>。誰對誰錯事後才知道，但它標示的是
        「這一檔現在有分歧」。對作榜<b>依較小的那一邊排序</b>：合計在這裡接近零（兩邊互相
        抵消），拿它排序等於隨機；外資買 50 億配投信賣 0.5 億，與外資買 5 億配投信賣 5 億，
        後者才是真的兩邊都下了重手。</p>
    </section>
    ${listCard('外資投信同買', `兩邊各自都買超 ${min} 億以上 · 依合計排序 · 取前 ${INSTI_TOP}`,
      instiList(buys.slice(0, INSTI_TOP), ranked),
      `${state.date} 沒有任何一檔外資與投信都買超 ${min} 億以上`)}
    ${listCard('外資投信同賣', `兩邊各自都賣超 ${min} 億以上 · 依合計排序 · 取前 ${INSTI_TOP}`,
      instiList(sells.slice(0, INSTI_TOP), ranked),
      `${state.date} 沒有任何一檔外資與投信都賣超 ${min} 億以上`)}
    ${listCard('土洋對作 · 外資買投信賣', `兩邊各自都達 ${min} 億以上 · 依較小的那一邊排序 · 取前 ${INSTI_TOP}`,
      instiList(foBuy.slice(0, INSTI_TOP), ranked),
      `${state.date} 沒有任何一檔是外資買超、投信賣超各 ${min} 億以上`)}
    ${listCard('土洋對作 · 外資賣投信買', `兩邊各自都達 ${min} 億以上 · 依較小的那一邊排序 · 取前 ${INSTI_TOP}`,
      instiList(foSell.slice(0, INSTI_TOP), ranked),
      `${state.date} 沒有任何一檔是外資賣超、投信買超各 ${min} 億以上`)}
    <section class="card">
      <h2>這一頁在講什麼 <small>以及不能拿它講什麼</small></h2>
      <p class="note">${INSTI_CAVEAT}</p>
      <p class="note">外資與投信的錢性質不同，「同買」才是這一頁的重點：外資動的是全球資金的
        配置，一天幾百億而且常常是被動的（ETF 調整成分、指數換股、避險部位）；投信動的是
        國內主動型基金，一檔幾千萬到幾億，經理人得對每一筆負責。兩種完全不同的決策流程
        在同一天指到同一檔，比任何單邊的買超排行都少見。</p>
      <p class="note">但買超不等於看多：外資的買超裡混著避險、借券還券與指數調整，投信在季底
        與年底有作帳的動機。而且淨額看不出成本 —— 同樣買超一億，開盤搶進與收盤前掛低接的
        處境完全不同，日報表只有一個淨數字，分不出來。<b>這是籌碼的事後紀錄，不是投資建議。</b></p>
      <p class="note">同一個門檻套在大小型股上意義不同：0.5 億對一檔日成交 200 億的權值股是零頭，
        對一檔日成交 3 億的中小型股是當天成交值的六分之一。所以每一列的金額底下擺了
        「<b>佔成交值</b>」＝外資與投信合計 ÷ 當日成交值：權值股常常不到 1%，
        中小型股可以到十幾趴，後者才是真的被法人吃掉了一大塊。成交值只有前 ${KEPT} 名
        有（本站的每日檔就留到那裡），其餘的那一格留白。</p>
      <p class="note">資料來自證交所「三大法人買賣超日報」與櫃買中心「三大法人買賣超彙總表」，
        涵蓋普通股、特別股與 ETF／ETN，已排除權證與牛熊證。表頭的全市場合計來自兩邊的
        「三大法人買賣金額彙總表」。</p>
    </section>`;
}

// --------------------------------------------------------------------------
// 分頁：買超（完整籌碼排行，含逆勢買超）
//
// 法人頁只答一個很窄的問題：外資與投信有沒有站在同一邊。那張榜好讀，卻把
// 「今天到底誰買最多」整個擋在外面 —— 而那是看籌碼的人第一個想問的。這一頁把它
// 補回來：外資、投信、自營商各自的買超榜與賣超榜，加上三大法人合計，一次看一邊。
//
// 但法人頁說單邊買超排行「看久了就沒有資訊」是對的：前幾名幾乎天天是同一批權值股，
// 台積電買超 0.3% 的量就比一檔中型股整天的成交值還大。所以這一頁不只有那兩張榜，
// 真正的重點是它的第二個軸 —— **逆勢**。
//
//   逆勢買超 ＝ 法人在買，這一檔今天卻收黑。
//   逆勢賣超 ＝ 法人在賣，這一檔今天卻收紅。
//
// 為什麼分這一刀：順勢的那一半（買超 + 收紅）常常是果不是因。股價自己在漲、買盤
// 跟著追進去，法人的買超只是那天成交量的一部分，「因為在漲所以有人買」這個最無聊的
// 解釋沒辦法排除。逆勢的那一半排除得掉 —— 買超是在賣壓裡接的、賣超是在漲勢裡出的。
// 那不代表它是對的（被動的指數調整照樣會撞上大盤下殺），但至少它不是跟風。
//
// 金額是估算的、買超不等於看多、淨額看不出成本 —— 三條警語與法人頁共用
// INSTI_CAVEAT。這一頁自己多一條：漲跌是收盤對收盤算的，沒有還原除權息。
// --------------------------------------------------------------------------
// 看哪一邊的法人。'sum' 是三邊相加，也就是市場上講的「三大法人買賣超」。
// 一次只排一邊：三張榜並排的話，每一張都只剩五、六列放得下，哪一張都讀不完。
const INSTI_LEGS = [
  { value: 'fo', label: '外資' },
  { value: 'tr', label: '投信' },
  { value: 'de', label: '自營' },
  { value: 'sum', label: '三大法人' },
];
// 卡片標題與說明裡的全名。pill 上要短（四個擠一列），句子裡要完整。
const LEG_NAMES = { fo: '外資', tr: '投信', de: '自營商', sum: '三大法人' };
const INSTI_LEG_KEY = 'stocktracker.instileg';

// 看哪一個期間。當日的資料在 insti/daily/ + insti/chg/，跨日的在 insti/sum/ ——
// 兩條路算出來的每一列形狀相同（三邊金額、三邊張數、期間漲跌），所以下面四張榜
// 與每一列的畫法完全共用，只有「從哪裡拿」不一樣。
const INSTI_WINS = [
  { value: 'd', label: '當日' },
  { value: '5', label: '近 5 日' },
  { value: '20', label: '近 20 日' },
];
const INSTI_WIN_KEY = 'stocktracker.instiwin';

// --------------------------------------------------------------------------
// 力道標：今天這筆買賣超，是這一檔平常的幾倍
//
// 「佔成交值」問的是「相對於**今天的量**大不大」，力道標問的是另一件事：
// 「相對於**這一檔自己的平常**大不大」。兩個都需要 —— 聯發科買超 50.9 億看起來很大，
// 但它平常就動 19.8 億，力道只有 2.6 倍；強茂買超 26.5 億而平常只有 2.7 億，
// 那是 9.8 倍。金額榜上兩檔挨在一起，異常程度差了四倍。
//
// 分母是後端算好的「平常的量」（過去 20 個交易日、日金額絕對值的中位數，
// 見 insti/base/）。這裡只負責除，外加一道**地板**：
//
//     力道 ＝ |今日金額| ÷ max(平常的量, 每日檔的收錄門檻)
//
// 地板是必要的：平常沒人動的個股分母趨近 0，今天動一次就是好幾百倍，那個數字
// 看起來最聳動、資訊量卻最低。而地板取每日檔自己的 cut（0.05 億）不是隨便挑的
// —— 比它小的金額，每日檔裡根本沒有記錄，那是這份資料的**解析度下限**。
// 真正的中位數是多少我們不知道，只知道在那之下；拿它當分母的地板，等於說
// 「最多只能講到這個倍數」，而不是假裝那一格沒有答案。
//
// 為什麼不乾脆把分母太小的列藏起來：實測 1,445 檔曾進過每日檔的個股裡，570 檔的
// 外資日金額中位數是 0、另有 98 檔不到 0.05 億 —— 藏起來等於對 58% 的個股留白，
// 而那裡面正好是最有意思的一類（平常沒人碰、今天忽然有人買三億）。
// --------------------------------------------------------------------------
const INSTI_SORTS = [
  { value: 'oku', label: '依金額' },
  { value: 'force', label: '依力道' },
];
const INSTI_SORT_KEY = 'stocktracker.instisort';

// 依力道排序時，金額至少要這麼多（億）才進榜。倍數高而金額是零頭的那些，
// 倍數再高也只是零頭的倍數 —— 地板擋掉了最誇張的，這一道擋掉剩下的。
const FORCE_MIN = 0.5;

// 四個 pill 在「每一邊各存一個值」那幾份資料裡的位置。insti/base/ 的 BASE_FIELDS
// 與 insti/sum/ 的四個均價欄共用這個順序。
//
// 第四個「三大法人」在兩份檔案裡都是**另外算**的，不是前三個的合成：中位數不可加
// （台積電三邊中位數相加 104.8 億，實際的三大法人淨額中位數只有 89.4 億），
// 均價更不可加。
const LEG_AT = { fo: 0, tr: 1, de: 2, sum: 3 };

const RANK_TOP = 30;   // 每張榜最多列幾檔

/** 選定那一邊的估算金額（億）。'sum' 是三邊相加。 */
const legOku = (entry, leg) => (leg === 'sum' ? entry.fo + entry.tr + entry.de : entry[leg]);

/** 選定那一邊的買賣超股數。 */
const legLots = (entry, leg) =>
  (leg === 'sum' ? entry.lots.fo + entry.lots.tr + entry.lots.de : entry.lots[leg]);

function loadInstiChg(date) {
  if (!state.instiChg.has(date)) {
    state.instiChg.set(date, getJSON(`${DATA}/insti/chg/${date}.json`));
  }
  return state.instiChg.get(date);
}

function loadInstiSum(date) {
  if (!state.instiSum.has(date)) {
    state.instiSum.set(date, getJSON(`${DATA}/insti/sum/${date}.json`));
  }
  return state.instiSum.get(date);
}

/**
 * 平常的量。資料起點往後那幾天前面湊不滿 10 個交易日，後端整天不寫檔 ——
 * 那不是錯誤，是「還講不出這一檔的平常」，所以 404 當成 null，力道標那一格留白。
 */
function loadInstiBase(date) {
  if (!state.instiBase.has(date)) {
    state.instiBase.set(date, getJSON(`${DATA}/insti/base/${date}.json`).catch(() => null));
  }
  return state.instiBase.get(date);
}

/** 力道倍數。算不出來（沒有那一天的檔、或這一檔不在裡面）回 null。 */
const forceOf = (norms, oku, floor) =>
  (norms === undefined || norms === null ? null : Math.abs(oku) / Math.max(norms, floor));

/** 力道那一格。10 倍以下給一位小數，以上就不必了。 */
const forceText = (force) =>
  (force === null || force === undefined ? '' : ` · 力道 ${num(force, force < 10 ? 1 : 0)} 倍`);

// 跨日累計檔的每一列。順序即 scripts/institutions.py 的 SUM_FIELDS，兩邊必須一致。
const W_FO = 0;        // 外資累計估算金額（億，逐日以當日收盤價換算後相加）
const W_TR = 1;        // 投信累計
const W_DE = 2;        // 自營商累計
const W_LFO = 3;       // 外資累計買賣超股數
const W_LTR = 4;       // 投信累計股數
const W_LDE = 5;       // 自營商累計股數
const W_RET = 6;       // 期間漲跌（%）：窗口第一天的前一個交易日收盤 -> 當日收盤
const W_PRICE = 7;     // 之後四個是三邊 + 三大法人的均價，順序同 LEG_AT
// meta 的三個值
const M_NAME = 0;
const M_MARKET = 1;
const M_CLOSE = 2;

/**
 * 跨日累計檔 -> 與 instiRows() 同一種形狀的一排。
 *
 * 差別只有金額怎麼來：當日那條路是「股數 × 收盤價」當場乘出來，跨日這條路是後端
 * 逐日以**當日**收盤價換算後相加的 —— 一段 20 天的期間裡股價本來就在動，用最後
 * 一天的價格回推會算錯（與連買頁累計金額同一個理由）。
 */
function sumRows(payload, win) {
  const block = (payload.w || {})[win];
  if (!block) return [];
  const meta = payload.meta || {};
  const out = [];
  for (const [code, row] of Object.entries(block.rows || {})) {
    const info = meta[code];
    if (!info) continue;
    out.push({
      code,
      market: info[M_MARKET],
      name: info[M_NAME],
      close: info[M_CLOSE],
      lots: { fo: row[W_LFO], tr: row[W_LTR], de: row[W_LDE] },
      fo: row[W_FO],
      tr: row[W_TR],
      de: row[W_DE],
      chg: row[W_RET],
      avgs: row.slice(W_PRICE, W_PRICE + 4),
    });
  }
  return out;
}

/** 當日漲跌。算不出來（前一個交易日沒有收盤價）就留白，不要寫成 0%。 */
const chgText = (chg) =>
  (chg === null || chg === undefined ? '—' : `${chg > 0 ? '+' : ''}${chg.toFixed(2)}%`);

/**
 * 依選定那一邊挑出一張榜，依金額大小排序。
 * side 是 'buy' 或 'sell'；against 為真時只留逆勢的那一半（買超收黑、賣超收紅）。
 *
 * 逆勢榜同樣依金額排序而不是依跌幅：跌幅排序會把一堆幾百萬的零頭推到最上面，
 * 而「誰在賣壓裡接了最多」才是這張榜要回答的。
 */
const legPick = (rows, leg, side, against = false) => {
  const want = side === 'buy' ? 1 : -1;
  return rows
    .filter((r) => {
      const oku = legOku(r, leg);
      if (Math.sign(oku) !== want) return false;
      if (!against) return true;
      // 平盤（chg 正好是 0）與算不出漲跌的都不算逆勢 —— 逆勢要有「勢」可逆
      return r.chg ? Math.sign(r.chg) === -want : false;
    })
    .sort((a, b) => (legOku(b, leg) - legOku(a, leg)) * want);
};

/**
 * 把一張榜改成依力道排序。力道算不出來的（那一天沒有 base 檔）與金額是零頭的
 * 都不進來 —— 零頭的倍數再高還是零頭。
 *
 * 刻意寫成「重排既有的榜」而不是 legPick 的一個模式：**統計用的母體必須是依金額
 * 那一份**。力道排序會套金額門檻，拿它去算「今天有幾檔買超」會少一大半，
 * 而那是另一個問題（今天有幾檔買超，與其中幾檔值得看，不是同一件事）。
 */
const byForce = (list, leg) => list
  .filter((r) => r.force !== null && r.force !== undefined
    && Math.abs(legOku(r, leg)) >= FORCE_MIN)
  .sort((a, b) => b.force - a.force);

/** 三邊的估算金額與張數，三個 chip。法人頁與買超頁共用。 */
const instiChips = (entry) => {
  const chip = (label, oku, shares) =>
    `<span class="chip">${label} <em class="${trend(oku)}">${signedOku(oku)}</em> · ${signedLots(shares)}</span>`;
  return `${chip('外資', entry.fo, entry.lots.fo)}${
    chip('投信', entry.tr, entry.lots.tr)}${chip('自營', entry.de, entry.lots.de)}`;
};

// 名次那一格擺的是**當日漲跌**，成交值名次退到中間的 chip 上。
// 四張榜裡有兩張是逆勢榜，逆不逆勢全看這一格；擺在 figures 那一欄的話，讀者得一列
// 一列往右找，而那一欄在手機上是最先被截掉的。
function instiRankRow(entry, seq, ranked, leg, win) {
  const stock = ranked.get(entry.code);
  const oku = legOku(entry, leg);
  // 當日擺「佔成交值」，跨日擺「買均／賣均」。
  //
  // 佔成交值只有當日算得出來（單日的成交值不能當 N 日累計的分母，而本站沒有存
  // N 日累計成交值）；均價則反過來，只有跨日才有意義 —— 當日的「均價」就是那天的
  // 收盤價本身，右邊那一格已經在顯示了。
  let tail = '';
  if (win === 'd') {
    tail = ` · ${stock && stock.value
      ? `佔成交值 ${num((Math.abs(oku) * 1e8 / stock.value) * 100, 1)}%`
      : '—'}`;
  } else {
    const avg = (entry.avgs || [])[LEG_AT[leg]];
    // 買均／賣均由淨額的方向決定：均價算的就是「與淨額同方向的那幾天」
    if (avg !== null && avg !== undefined) {
      tail = ` · ${oku > 0 ? '買均' : '賣均'} ${num(avg, 2)}`;
    }
  }
  return `<a class="row" href="#/stock/${entry.code}">
    <div class="rank"><span class="no">${seq}</span>
      <span class="delta ${trend(entry.chg)}">${chgText(entry.chg)}</span></div>
    <div class="ident">
      <span class="name">${state.watch.has(entry.code) ? '<span class="star">★</span>' : ''}${esc(entry.name)}</span>
      <span class="code">${entry.code} · ${esc(MARKET_TAGS[entry.market])}${
        hasIndustry() ? ` · ${esc(industryOf(entry.code))}` : ''}</span>
      <span class="chips">${instiChips(entry)}${
        stock ? `<span class="chip">名次 ${stock.rank}</span>` : ''}</span>
    </div>
    <div class="figures">
      <span class="value ${trend(oku)}">${signedOku(oku)}</span>
      <span class="price">${signedLots(legLots(entry, leg))}${forceText(entry.force)}</span>
      <span class="price">${num(entry.close, 2)}${tail}</span>
    </div>
  </a>`;
}

/**
 * 買超排行的清單。最後一欄跟著時間軸換：當日給「佔成交值」（單日的成交值只有當日
 * 的分母算得出來），跨日給「買賣均價」（當日的均價就是收盤價，隔壁那欄已經在顯示
 * 了）。這跟 instiRankRow() 右下角那行小字是同一條規則，只是換成一欄。
 */
const instiRankList = (entries, ranked, leg, win) => listOf(entries,
  (r, i) => instiRankRow(r, i + 1, ranked, leg, win),
  () => ({
    href: (r) => `#/stock/${r.code}`,
    cols: [
      colSeq,
      col('名稱', W.name, 'w-name', (r) => wideName(r.code, r.name, r.market)),
      ...(hasIndustry() ? [colIndustry((r) => r.code)] : []),
      col('估算金額', W.oku, 'w-num w-val', (r) => wideOku(legOku(r, leg))),
      col('張數', W.lots, 'w-num', (r) => signedLots(legLots(r, leg))),
      col('力道', W.force, 'w-num', (r) => wideForce(r.force)),
      col('收盤', W.price, 'w-num', (r) => cellNum(r.close)),
      col(win === 'd' ? '漲跌%' : '期間漲跌', W.pct, 'w-num',
        (r) => widePct(r.chg)),
      win === 'd'
        ? col('佔成交值', W.share, 'w-num',
          (r) => wideShare(legOku(r, leg), ranked.get(r.code)))
        : col('買賣均價', W.price, 'w-num',
          (r) => cellNum((r.avgs || [])[LEG_AT[leg]])),
      col('名次', W.back, 'w-num w-streak',
        (r) => { const s = ranked.get(r.code); return s ? s.rank : '—'; }),
    ],
  }));

async function renderInstiRank(view) {
  let index;
  try {
    index = await loadInstiIndex();
  } catch (err) {
    view.innerHTML = `<p class="hint">還沒有法人資料（${esc(err.message)}）。<br>
      請先執行 <code>scripts/fetch_institutions.py</code> 與
      <code>scripts/build_institutions.py</code>；
      要一次補上一段歷史就加 <code>--days 30</code>。</p>`;
    return;
  }
  const days = index.days || [];
  if (!days.length) {
    view.innerHTML = '<p class="hint">法人目錄裡沒有任何交易日，請重跑 scripts/build_institutions.py。</p>';
    return;
  }
  // 與連買頁同一個道理：舊的資料集有 daily/ 卻還沒有 chg/。少了這一行自我描述就先
  // 講清楚是哪一種情況，不然下面那個 fetch 會變成一則看不出原因的 404。
  if (!index.chg) {
    view.innerHTML = `<p class="hint">這份法人資料還沒有算當日漲跌。<br>
      請重跑 <code>scripts/build_institutions.py</code>（它會由
      <code>docs/data/insti/daily/</code> 與 <code>docs/data/close/</code>
      從頭重算，不用重抓）。</p>`;
    return;
  }

  // 舊的資料集有 daily/ 卻還沒有 sum/。與上面 chg 同一個道理。
  if (state.instiWin !== 'd' && !index.sum) {
    view.innerHTML = `${pills('instiwin', INSTI_WINS, state.instiWin)}
      <p class="hint">這份法人資料還沒有算跨日累計。<br>
      請重跑 <code>scripts/build_institutions.py</code>（它會由
      <code>docs/data/insti/daily/</code> 從頭重算，不用重抓）。</p>`;
    return;
  }

  // 排序那一排只在當日出現：跨日沒有力道可排，擺一顆按不動的 pill 比不擺更讓人困惑
  const sortRow = state.instiWin === 'd'
    ? `<div class="controls">${pills('instisort', INSTI_SORTS, state.instiSort)}</div>` : '';
  const controls = `<div class="controls">${pills('instileg', INSTI_LEGS, state.instiLeg)}</div>
    <div class="controls">${pills('instiwin', INSTI_WINS, state.instiWin)}</div>${sortRow}`;
  if (!days.some((d) => d.d === state.date)) {
    view.innerHTML = `${controls}
      <p class="hint">${state.date} 還沒有法人資料。<br>
      目前有 ${days.length} 個交易日：${esc(index.first)} ~ ${esc(index.latest)}。<br>
      請把日期挪到那一段裡面，或執行
      <code>scripts/fetch_institutions.py --days 30</code> 往前回補。</p>`;
    return;
  }

  const win = state.instiWin;
  const daily = await loadDaily(state.date);
  const ranked = new Map(daily.stocks.map((s) => [s.code, s]));
  // 頂部的範圍選單對這一頁一樣有效
  const markets = state.scope === 'all' ? ['twse', 'tpex'] : [state.scope];

  // 兩條路產出同一種形狀的一排，所以下面的四張榜完全共用。
  //   當日   insti/daily/ 的股數 × 收盤價，配 insti/chg/ 的當日漲跌
  //   跨日   insti/sum/ 後端算好的累計金額與期間漲跌
  let rows;
  let span;            // 這個窗口實際算了幾個交易日
  let pool;            // 這份資料檔在這個範圍下總共有幾檔，說明文要用
  let cutText;
  let base = null;     // 平常的量。只有當日算得出力道，跨日的沒有（理由見說明卡）
  if (win === 'd') {
    const [payload, moves, norms] = await Promise.all([
      loadInstiDay(state.date), loadInstiChg(state.date), loadInstiBase(state.date)]);
    const chg = moves.chg || {};
    base = norms;
    // 力道的分母地板取每日檔自己的 cut —— 比它小的金額檔案裡根本沒有記錄
    const at = LEG_AT[state.instiLeg];
    const table = (norms && norms.base) || {};
    rows = instiRows(payload)
      .filter((r) => markets.includes(r.market))
      .map((r) => ({
        ...r,
        chg: chg[r.code],
        force: forceOf((table[r.code] || [])[at], legOku(r, state.instiLeg), payload.cut),
      }));
    span = 1;
    pool = rows.length;
    cutText = `三邊的估算金額都不到 ${payload.cut} 億的不收`;
  } else {
    const payload = await loadInstiSum(state.date);
    rows = sumRows(payload, win).filter((r) => markets.includes(r.market));
    span = (payload.w[win] || {}).days || Number(win);
    pool = rows.length;
    cutText = `每個市場每一邊各留前 ${payload.keep} 名、不到 ${payload.floor} 億的不留`;
  }

  // 力道只有當日算得出來，所以排序軸也只在當日有作用；跨日一律依金額
  const canForce = win === 'd' && !!base;
  const sort = canForce ? state.instiSort : 'oku';
  const sortText = sort === 'force'
    ? `依力道排序 · 金額 ${FORCE_MIN} 億以上` : '依估算金額排序';

  const leg = state.instiLeg;
  const name = LEG_NAMES[leg];
  const winName = win === 'd' ? '' : `近 ${win} 日`;
  // 湊不滿的窗口要標出來：少算幾天的累計，看起來跟「那段時間法人沒什麼動作」一樣
  const shortfall = win !== 'd' && span < Number(win);
  const spanText = win === 'd' ? '當日'
    : `近 ${win} 日${shortfall ? `（實際只算得到 ${span} 天）` : ''}`;

  // 母體：四張榜的檔數統計一律取自這四份，與排序方式無關
  const buys = legPick(rows, leg, 'buy');
  const sells = legPick(rows, leg, 'sell');
  const buysAgainst = legPick(rows, leg, 'buy', true);
  const sellsAgainst = legPick(rows, leg, 'sell', true);
  // 顯示：依力道時重排並套金額門檻，依金額時就是母體本身
  const shown = (list) => (sort === 'force' ? byForce(list, leg) : list);

  const known = rows.filter((r) => r.chg !== null && r.chg !== undefined);
  const up = known.filter((r) => r.chg > 0).length;
  const down = known.filter((r) => r.chg < 0).length;
  const shareOfBuys = buys.length
    ? `${num((buysAgainst.length / buys.length) * 100, 0)}%` : '—';
  const moveWord = win === 'd' ? '收紅 / 收黑' : '期間漲 / 期間跌';
  const againstWord = win === 'd'
    ? ['逆勢買超（買超收黑）', '逆勢賣超（賣超收紅）']
    : ['逆勢買超（累計買超、期間卻跌）', '逆勢賣超（累計賣超、期間卻漲）'];

  setExport(`籌碼買超_${leg}_${win}_${state.scope}_${state.date}.csv`,
    ['代號', '名稱', '市場', '漲跌%', '外資(億)', '投信(億)', '自營(億)',
      `${name}(億)`, `${name}(張)`, '力道(倍)', '收盤'],
    [...buys, ...sells].map((r) => [r.code, r.name, MARKET_TAGS[r.market], r.chg,
      r.fo.toFixed(2), r.tr.toFixed(2), r.de.toFixed(2),
      legOku(r, leg).toFixed(2), Math.round(legLots(r, leg) / 1000),
      r.force === null || r.force === undefined ? '' : r.force.toFixed(1), r.close]));

  view.innerHTML = `
    ${controls}
    ${exportBar()}
    <section class="card">
      <h2>${esc(name)}${esc(winName)}買賣超排行 <small>${esc(state.date)} ${esc(scopeLabel())} · 買超 ${buys.length} 檔、賣超 ${sells.length} 檔</small></h2>
      <div class="stat-grid">
        <div class="stat"><b>${pair(up, down)}</b><span>${moveWord}</span></div>
        <div class="stat"><b class="up">${buysAgainst.length}</b><span>${againstWord[0]}</span></div>
        <div class="stat"><b class="down">${sellsAgainst.length}</b><span>${againstWord[1]}</span></div>
      </div>
      <p class="note">這一天${esc(scopeLabel())}有 ${pool} 檔進了${win === 'd' ? '法人的每日檔' : '累計檔'}（${cutText}），
        其中 ${known.length} 檔算得出${win === 'd' ? '當日漲跌' : '期間漲跌'} —— ${up} 檔漲、${down} 檔跌。
        ${esc(name)}${esc(spanText)}買超的有 ${buys.length} 檔，其中 ${buysAgainst.length} 檔（${shareOfBuys}）
        是在自己${win === 'd' ? '收黑' : '期間下跌'}的情況下被買的。</p>
      ${!canForce ? '' : `<p class="note">每一列的張數後面是<b>力道</b>：今天這筆是這一檔平常的幾倍
        （平常＝過去 ${base.win} 個交易日日金額絕對值的中位數，用了前 ${base.used} 天）。
        ${sort === 'force' ? `目前<b>依力道排序</b>，所以上面四張榜挑的是「對自己來說最異常」的，
        不是金額最大的 —— 金額不到 ${FORCE_MIN} 億的不進榜（買超 ${buys.length} 檔裡有
        ${byForce(buys, leg).length} 檔進得了力道榜）。上面那三格統計仍然是全部的檔數，
        不受排序影響。` : '權值股的力道常常只有一、兩倍：金額很大，但那是它的日常。'}</p>`}
      ${win === 'd' ? '' : `<p class="note">累計金額是逐日「買賣超股數 × <b>當日</b>收盤價」相加的，不是用最後一天
        的價格回推 —— 一段 ${win} 天的期間裡股價本來就在動，用同一個價格乘完會算錯。
        期間漲跌的基準是窗口第一天的<b>前一個交易日</b>收盤，與「連買」頁同一個慣例。
        ${shortfall ? `<b>這一天的窗口湊不滿</b>：本站的法人資料從 ${esc(index.first)} 開始，
        往前只接得到 ${span} 個交易日，所以這是 ${span} 日的累計、不是 ${win} 日的。` : ''}</p>`}
      <p class="note">四張榜都依<b>${sort === 'force' ? '力道' : '估算金額'}</b>排序。逆勢那兩張不是另外挑出來的股票，而是上面那兩張
        <b>濾掉順勢的那一半</b>：買超榜裡${win === 'd' ? '當天收紅' : '期間上漲'}的拿掉，剩下的就是逆勢買超。
        順勢的那一半常常是果不是因 —— 股價自己在漲、買盤跟著追進去，「因為在漲所以有人買」
        這個解釋排除不掉；逆勢的那一半排除得掉。</p>
    </section>
    ${listCard(`${name}${winName}買超排行`, `${sortText} · 取前 ${RANK_TOP}`,
      instiRankList(shown(buys).slice(0, RANK_TOP), ranked, leg, win),
      `${state.date} ${scopeLabel()}沒有任何一檔${name}${winName}買超`)}
    ${listCard(`${name}${winName}逆勢買超`,
      `買超、${win === 'd' ? '當天卻收黑' : '期間卻下跌'} · ${sortText} · 取前 ${RANK_TOP}`,
      instiRankList(shown(buysAgainst).slice(0, RANK_TOP), ranked, leg, win),
      `${state.date} 沒有任何一檔${name}${winName}買超而股價${win === 'd' ? '收黑' : '下跌'}`)}
    ${listCard(`${name}${winName}賣超排行`, `${sortText} · 取前 ${RANK_TOP}`,
      instiRankList(shown(sells).slice(0, RANK_TOP), ranked, leg, win),
      `${state.date} ${scopeLabel()}沒有任何一檔${name}${winName}賣超`)}
    ${listCard(`${name}${winName}逆勢賣超`,
      `賣超、${win === 'd' ? '當天卻收紅' : '期間卻上漲'} · ${sortText} · 取前 ${RANK_TOP}`,
      instiRankList(shown(sellsAgainst).slice(0, RANK_TOP), ranked, leg, win),
      `${state.date} 沒有任何一檔${name}${winName}賣超而股價${win === 'd' ? '收紅' : '上漲'}`)}
    <section class="card">
      <h2>這一頁在講什麼 <small>以及不能拿它講什麼</small></h2>
      <p class="note">法人頁問的是「外資與投信有沒有站在同一邊」，這一頁問的是<b>單邊的大小</b>：
        ${esc(name)}買最多、賣最多的是哪幾檔。上面兩排 pill 是兩個各自獨立的軸 ——
        第一排選<b>看哪一邊</b>（「三大法人」是三邊相加，市場上引用的那個口徑），
        第二排選<b>看多長的期間</b>。</p>
      <p class="note"><b>累計買超不是連續買超。</b>這一頁的 5 日／20 日問的是「總共買了多少」，
        中間翻不翻向不管；「連買」頁問的是「有沒有一路買下去」，中間一翻就斷。一檔可以在
        20 個交易日裡累計買超 50 億、而中間有 8 天是賣的 —— 連買頁看不到它，這裡看得到；
        反過來一檔連買 12 天但每天只有幾千萬，連買頁排在最前面，這裡排不進去。兩張榜挑出來的
        是不同的股票，所以兩頁並存。</p>
      <p class="note"><b>單純的買超排行前幾名幾乎天天是同一批權值股</b> —— 台積電買超 0.3% 的量
        就比一檔中型股整天的成交值還大。所以當日那個期間，每一列的最後擺了「佔成交值」＝
        這一邊的買賣超 ÷ 當日成交值：權值股常常不到 1%，中小型股可以到十幾趴。
        <b>跨日的兩個期間沒有這一格</b>：單日的成交值不能拿來當 N 日累計的分母，
        而本站沒有存 N 日累計成交值。成交值名次仍在中間的 chip 上（只有前 ${KEPT} 名有）。</p>
      <p class="note"><b>力道</b>＝今日金額 ÷ 這一檔<b>平常</b>的量（過去 ${(base && base.win) || 20} 個交易日、
        日金額絕對值的<b>中位數</b>）。「佔成交值」問的是「相對於今天的量大不大」，力道問的是
        「相對於這一檔自己的平常大不大」—— 兩個是不同的問題。${esc(state.date)} 的例子：
        聯發科外資買超 50.9 億看起來最大，但它平常就動 19.8 億，力道只有 2.6 倍；
        強茂買超 26.5 億、平常只有 2.7 億，那是 9.8 倍。金額榜上兩檔挨在一起，
        異常的程度差了快四倍。用中位數不用平均，是因為平均會被過去 20 天裡某一天的
        大額整個吃掉，算出來的「平常」其實是那一天。</p>
      <p class="note">分母有一道<b>地板</b>：平常沒人動的個股分母趨近 0，今天動一次就是好幾百倍，
        那個數字看起來最聳動、資訊量卻最低。地板取每日檔自己的收錄門檻（0.05 億）——
        比它小的金額，檔案裡根本沒有記錄，那是這份資料的<b>解析度下限</b>；真正的中位數是多少
        我們不知道，只知道在那之下。所以力道標的意思是「<b>最多</b>只能講到這個倍數」。
        依力道排序時另外要求金額至少 ${FORCE_MIN} 億：零頭的倍數再高還是零頭。</p>
      <p class="note"><b>跨日的兩個期間沒有力道標。</b>它要的是「5 日（或 20 日）累計的平常是多少」，
        而要有 20 個 20 日累計的樣本得回頭看 40 個交易日以上 —— 本站的法人資料目前只有
        ${days.length} 個交易日。這是「還不夠」不是「做不到」，資料長到那裡就補得上。</p>
      ${win === 'd' ? '' : `<p class="note">跨日的每一列最後是<b>買均／賣均</b>：這段期間裡，
        <b>與淨額同方向的那幾天</b>的股數加權收盤均價。淨買超就只算買進的那幾天、
        淨賣超就只算賣出的那幾天。</p>
      <p class="note">為什麼不直接拿「累計金額 ÷ 累計股數」——那個商數看起來就是均價，
        其實不是：<b>淨額是相減的結果，拿它當分母沒有物理意義</b>。實測近 20 日有外資
        淨額的 1,412 檔，只有 228 檔期間內是單邊（只買或只賣），其餘 1,184 檔有買有賣；
        用淨額算出來的「均價」有 219 檔落在期間的價格區間外，包括<b>負的價格</b>
        （竹陞科技 -4,849 元）與台積電的 2,597 元（那 20 天的收盤只在 2,350~2,440）。
        只取同方向的那幾天之後，權重全部同號，結果必定落在那幾天的收盤區間內。</p>
      <p class="note"><b>它描述的是那幾天，不是淨額。</b>一檔買 10,000 張、賣 9,900 張的股票，
        淨額只有 100 張，但買均描述的是那 10,000 張。</p>
      <p class="note"><b>而且它不是法人的成本。</b>官方的個股資料從頭到尾只有股數，本站的
        「金額」一律是股數 × <b>收盤價</b>，所以這裡的均價是「收盤價的加權平均」——
        真正的成交均價在盤中，日報表裡沒有任何一欄摸得到它。當天振幅越大差越遠。
        拿它去算「法人套住了沒」，那個結論建立在一個假的數字上。</p>`}
      <p class="note">漲跌是<b>收盤對收盤</b>算的。它與官方的「漲跌價差」差在一件事 ——
        官方是對除權息參考價算的，這裡沒有還原，所以<b>除權息會被算成下跌</b>，
        那一檔會出現在逆勢買超榜上而其實只是配息。金額大的那幾檔值得回頭確認一下
        期間內有沒有除權息。</p>
      <p class="note">${INSTI_CAVEAT}</p>
      <p class="note">逆勢買超不等於低接、也不等於看多：被動的指數調整、ETF 的成分股換股與避險
        部位照樣會撞上大盤下殺的那一天，它們在這張榜上與真的在建倉的錢長得一模一樣。
        這張榜排除掉的只是最無聊的那個解釋（因為在漲所以有人追），<b>不是替你做判斷</b>。
        要看一筆買盤有沒有持續性，去「連買」頁；要看外資與投信有沒有同時站在同一邊，
        去「法人」頁。</p>
    </section>`;
}

// --------------------------------------------------------------------------
// 分頁：連買（外資連續買超／賣超）
//
// 法人頁看的是一天，這一頁看的是**同一個方向撐了幾天**。
//
// 單日的買超很容易是別的東西：ETF 調整成分、指數換股、避險部位、除息前後的調節，
// 一天就結束。連續買超要的是「每一個交易日都站在同一邊」——一筆被動的調整不會
// 連著十天做同一件事，但一個真的在建倉（或減碼）的決定會。所以天數是這一頁的主軸，
// 排序也以它為先：金額大的單日買超在法人頁看得到，這裡要挑出來的是持續性。
//
// 兩個門檻各自解決一個問題：
//   - **天數**（3／5／8／12）決定「多久才算持續」。三天是最低的門檻，兩天在一天的
//     檔案裡就看得出來，算不上連續。
//   - **累計金額**（不限／1／5／20 億）把零頭濾掉。連買天數本身不分大小，一檔債券
//     ETF 每天被買進幾十萬元也能連上十幾天，那不是訊號、只是它天天有人申購。
//
// 每一列都帶「期間漲跌」，因為這一頁最容易被誤讀成「跟著買」。實際上兩邊都常見：
// 外資連賣二十幾天而股價還在漲的有、連買十幾天而股價沒動的也有。這一格擺在名單上，
// 讀者才不會自己把「連續買超」補完成「所以會漲」。
// --------------------------------------------------------------------------
const RUN_DAYS = [
  { value: 3, label: '3 天' },
  { value: 5, label: '5 天' },
  { value: 8, label: '8 天' },
  { value: 12, label: '12 天' },
];
// 累計金額的門檻。連買天數本身不分大小，這一格才分得出「真的在買」與「天天有零頭」。
const RUN_OKUS = [
  { value: 0, label: '不限' },
  { value: 1, label: '1 億' },
  { value: 5, label: '5 億' },
  { value: 20, label: '20 億' },
];
const RUN_DAYS_KEY = 'stocktracker.rundays';
const RUN_OKU_KEY = 'stocktracker.runoku';

// 每一段存的八個值，順序即 scripts/institutions.py 的 RUN_FIELDS，兩邊必須一致。
const R_NAME = 0;      // 簡稱
const R_DAYS = 1;      // 連續天數，正的是連買、負的是連賣
const R_LOTS = 2;      // 這段期間的累計買賣超股數
const R_OKU = 3;       // 這段期間的累計估算金額（億元，逐日以當日收盤價換算後相加）
const R_SINCE = 4;     // 這段連續的起算日
const R_CLOSE = 5;     // 最後一天（也就是選定日期那天）的收盤價
const R_RET = 6;       // 起算日「前一個交易日」收盤到最後一天收盤的漲跌（%）
const R_TRUNC = 7;     // 1 = 起算日的前一個交易日沒有法人資料，實際天數只可能更長

const RUN_TOP = 30;    // 每張榜最多列幾檔

function loadInstiRun(date) {
  if (!state.instiRun.has(date)) {
    state.instiRun.set(date, getJSON(`${DATA}/insti/streak/${date}.json`));
  }
  return state.instiRun.get(date);
}

/** 檔案攤平成一排。 */
function runRows(payload) {
  const out = [];
  for (const market of Object.keys(payload.stocks || {})) {
    for (const [code, row] of Object.entries(payload.stocks[market] || {})) {
      out.push({
        code,
        market,
        name: row[R_NAME],
        days: row[R_DAYS],
        lots: row[R_LOTS],
        oku: row[R_OKU],
        since: row[R_SINCE],
        close: row[R_CLOSE],
        ret: row[R_RET],
        trunc: !!row[R_TRUNC],
      });
    }
  }
  return out;
}

/**
 * 挑出一邊。'buy' 是連續買超、'sell' 是連續賣超。
 * 天數優先、同天數才比累計金額 —— 這一頁問的是持續性，不是單日的大小。
 */
const runPick = (rows, side, days, floor) =>
  rows
    .filter((r) => (side === 'buy' ? r.days >= days : -r.days >= days)
      && Math.abs(r.oku) >= floor)
    .sort((a, b) => Math.abs(b.days) - Math.abs(a.days) || Math.abs(b.oku) - Math.abs(a.oku));

/**
 * 連 N 天。沿用排行頁 streakLabel() 的兩個慣例：一樣寫成「連 N 天」，
 * 而連到資料起點（或缺口）的那幾段標 `+` —— 實際天數只可能更長。
 * 是買還是賣由所在的那張榜與紅綠決定，不必在每一列上再寫一次。
 */
const runDaysLabel = (entry) =>
  `連 ${Math.abs(entry.days)}${entry.trunc ? '+' : ''} 天`;

/** 期間漲跌。起算日的前一個交易日收盤起算，算不出來就留白。 */
const runRetLabel = (ret) =>
  (ret === null || ret === undefined
    ? '期間 —'
    : `期間 <em class="${trend(ret)}">${ret > 0 ? '+' : ''}${ret.toFixed(2)}%</em>`);

function runRow(entry, seq, ranked) {
  const stock = ranked.get(entry.code);
  const pct = stock && stock.changePct !== null && stock.changePct !== undefined
    ? ` <em class="${trend(stock.changePct)}">${stock.changePct > 0 ? '+' : ''}${stock.changePct.toFixed(2)}%</em>`
    : '';
  return `<a class="row" href="#/stock/${entry.code}">
    <div class="rank"><span class="no">${seq}</span>
      <span class="delta ${trend(entry.days)}">${runDaysLabel(entry)}</span></div>
    <div class="ident">
      <span class="name">${state.watch.has(entry.code) ? '<span class="star">★</span>' : ''}${esc(entry.name)}</span>
      <span class="code">${entry.code} · ${esc(MARKET_TAGS[entry.market])}${
        hasIndustry() ? ` · ${esc(industryOf(entry.code))}` : ''}</span>
      <span class="chips"><span class="chip">${esc(entry.since)} 起</span><span
        class="chip">${runRetLabel(entry.ret)}</span>${
        stock ? `<span class="chip">名次 ${stock.rank}</span>` : ''}</span>
    </div>
    <div class="figures">
      <span class="value ${trend(entry.oku)}">${signedOku(entry.oku)}</span>
      <span class="price">${signedLots(entry.lots)}</span>
      <span class="price">${num(entry.close, 2)}${pct}</span>
    </div>
  </a>`;
}

/**
 * 連買清單。手機把「起算日、期間漲跌、名次」收成三個 chip，桌面一段一欄——這一頁
 * 是依天數排的，起算日與期間漲跌各自成欄才對得起來：同樣連 10 天，一段從高點起算、
 * 一段從低點起算，是完全不同的兩回事。
 */
const runList = (entries, ranked) => listOf(entries,
  (r, i) => runRow(r, i + 1, ranked),
  () => ({
    href: (r) => `#/stock/${r.code}`,
    cols: [
      colSeq,
      col('名稱', W.name, 'w-name', (r) => wideName(r.code, r.name, r.market)),
      ...(hasIndustry() ? [colIndustry((r) => r.code, true)] : []),
      col('連續', W.note, 'w-num',
        (r) => `<em class="${trend(r.days)}">${runDaysLabel(r)}</em>`),
      col('起算日', W.date, 'w-num w-streak', (r) => esc(r.since)),
      col('期間漲跌', W.pct, 'w-num', (r) => widePct(r.ret)),
      col('累計金額', W.oku, 'w-num w-val', (r) => wideOku(r.oku)),
      col('張數', W.lots, 'w-num', (r) => signedLots(r.lots)),
      col('收盤', W.price, 'w-num', (r) => cellNum(r.close)),
      col('漲跌%', W.pct, 'w-num',
        (r) => widePct((ranked.get(r.code) || {}).changePct)),
      optional(col('名次', W.back, 'w-num w-streak',
        (r) => { const s = ranked.get(r.code); return s ? s.rank : '—'; })),
    ],
  }));

async function renderInstiRun(view) {
  let index;
  try {
    index = await loadInstiIndex();
  } catch (err) {
    view.innerHTML = `<p class="hint">還沒有法人資料（${esc(err.message)}）。<br>
      請先執行 <code>scripts/fetch_institutions.py</code> 與
      <code>scripts/build_institutions.py</code>；
      要一次補上一段歷史就加 <code>--days 30</code>。</p>`;
    return;
  }
  const days = index.days || [];
  if (!days.length) {
    view.innerHTML = '<p class="hint">法人目錄裡沒有任何交易日，請重跑 scripts/build_institutions.py。</p>';
    return;
  }
  // 舊的資料集有 daily/ 卻還沒有 streak/。少了這一行自我描述就先講清楚是哪一種情況，
  // 不然下面那個 fetch 會變成一則看不出原因的 404。
  if (!index.streak) {
    view.innerHTML = `<p class="hint">這份法人資料還沒有算連續買賣超。<br>
      請重跑 <code>scripts/build_institutions.py</code>（它會由
      <code>docs/data/insti/daily/</code> 從頭重算，不用重抓）。</p>`;
    return;
  }

  const controls = `<div class="controls">${pills('rundays', RUN_DAYS, state.runDays)}${
    pills('runoku', RUN_OKUS, state.runOku)}</div>`;
  if (!days.some((d) => d.d === state.date)) {
    // 與法人頁同一個道理：缺哪一天要講清楚是「還沒抓到」而不是「那天沒有連續買超」
    view.innerHTML = `${controls}
      <p class="hint">${state.date} 還沒有法人資料。<br>
      目前有 ${days.length} 個交易日：${esc(index.first)} ~ ${esc(index.latest)}。<br>
      請把日期挪到那一段裡面，或執行
      <code>scripts/fetch_institutions.py --days 30</code> 往前回補。</p>`;
    return;
  }

  const [payload, daily] = await Promise.all([loadInstiRun(state.date), loadDaily(state.date)]);
  const ranked = new Map(daily.stocks.map((s) => [s.code, s]));
  // 頂部的範圍選單對這一頁一樣有效
  const markets = state.scope === 'all' ? ['twse', 'tpex'] : [state.scope];
  const rows = runRows(payload).filter((r) => markets.includes(r.market));
  const n = state.runDays;
  const floor = state.runOku;
  const buys = runPick(rows, 'buy', n, floor);
  const sells = runPick(rows, 'sell', n, floor);
  const picked = [...buys, ...sells];
  const longest = Math.max(0, ...picked.map((r) => Math.abs(r.days)));
  // 最長那一段本身連到資料起點時，這一格也要標 +，不然它會與底下的列對不起來
  const longestOpen = picked.some((r) => Math.abs(r.days) === longest && r.trunc);
  const truncated = picked.filter((r) => r.trunc).length;
  const floorText = floor ? `累計 ${floor} 億以上` : '累計金額不限';

  view.innerHTML = `
    ${controls}
    <section class="card">
      <h2>外資連續買賣超 <small>${esc(state.date)} ${esc(scopeLabel())} · ${n} 天以上 · ${floorText}</small></h2>
      <div class="stat-grid">
        <div class="stat"><b class="up">${buys.length}</b><span>連買 ${n} 天以上</span></div>
        <div class="stat"><b class="down">${sells.length}</b><span>連賣 ${n} 天以上</span></div>
        <div class="stat"><b>${longest ? `${longest}${longestOpen ? '+' : ''} 天` : '—'}</b><span>最長一段</span></div>
      </div>
      <p class="note">天數的算法：從 ${esc(state.date)} 往前，<b>每一個交易日</b>外資的買賣超都同向
        才算一天，中間只要有一天翻向、歸零，或是<b>沒進當天的資料檔</b>（三邊的估算金額都
        不到 ${index.cut} 億，那天外資動的是幾萬元的零頭）就斷掉，從那裡重新起算。
        這一天${esc(scopeLabel())}有 ${rows.length} 檔連續 ${payload.min} 天以上（檔案就只留
        ${payload.min} 天以上的），目前的兩個門檻篩掉其中 ${rows.length - picked.length} 檔。</p>
      <p class="note">本站的法人資料從 ${esc(index.first)} 開始。起算日的前一個交易日沒有法人資料的
        那幾段標成「連 N<b>+</b> 天」——實際天數只可能更長，不可能更短。目前榜上有
        ${truncated} 段是這種。</p>
    </section>
    ${listCard('外資連續買超', `連 ${n} 天以上 · ${floorText} · 依天數排序 · 取前 ${RUN_TOP}`,
      runList(buys.slice(0, RUN_TOP), ranked),
      `${state.date} 沒有任何一檔外資連續買超 ${n} 天以上${floor ? `、且累計達 ${floor} 億` : ''}`)}
    ${listCard('外資連續賣超', `連 ${n} 天以上 · ${floorText} · 依天數排序 · 取前 ${RUN_TOP}`,
      runList(sells.slice(0, RUN_TOP), ranked),
      `${state.date} 沒有任何一檔外資連續賣超 ${n} 天以上${floor ? `、且累計達 ${floor} 億` : ''}`)}
    <section class="card">
      <h2>這一頁在講什麼 <small>以及不能拿它講什麼</small></h2>
      <p class="note">法人頁看的是一天，這一頁看的是<b>同一個方向撐了幾天</b>。單日的買超很容易是
        別的東西 —— ETF 調整成分、指數換股、避險部位、除息前後的調節，一天就結束。
        一筆被動的調整不會連著十天做同一件事，但一個真的在建倉（或減碼）的決定會。
        所以這兩張榜以<b>天數</b>排序，同天數才比累計金額：金額大的單日買超在法人頁看得到，
        這裡要挑的是持續性。</p>
      <p class="note"><b>連續買超不等於會漲。</b>每一列都帶「期間漲跌」就是為了這件事 ——
        兩邊都常見：外資連賣二十幾天而股價還在漲的有、連買十幾天而股價原地不動的也有。
        期間漲跌是「起算日<b>前一個交易日</b>的收盤」到選定日期收盤的變化：外資是在起算日
        當天買的，那天的收盤價已經含了這筆買盤推上去的部分，拿它當起點會少算第一天。</p>
      <p class="note">${INSTI_CAVEAT}</p>
      <p class="note">累計金額是逐日「買賣超股數 × <b>當日</b>收盤價」相加的，不是用最後一天的
        價格回推 —— 一段連買十幾天的期間裡股價本來就在動，用同一個價格乘完會算錯。
        累計張數則是純粹的股數相加，不受價格影響，兩格並排就看得出這段期間的均價落在哪。</p>
      <p class="note">「外資」含外資自營商，與市場上引用的口徑一致。連續天數只算外資 ——
        投信與自營商的每日資料同樣在法人頁上，但這一頁要回答的是「外資有沒有一路買下去」，
        三邊都排出來只會讓人一次看三張榜、一張也讀不完。</p>
    </section>`;
}

// --------------------------------------------------------------------------
// 分頁：雷達（多條件籌碼篩選）
//
// 前面幾頁各自是一張排行榜：買超頁問「誰買最多」、連買頁問「誰買最久」、
// 法人頁問「外資與投信同不同邊」。每一張都只排一個維度，而真正想問的往往是
// **交集**：「外資連買 5 天以上、今天還逆勢加碼、而且力道是平常的三倍的，有誰？」
//
// 所以這一頁不是排行榜，是**篩選器**。它輸出的是一個集合，不是一個名次。
//
// ## 八組條件，每一組預設「不限」
//
// 條件是**可組合**的，不是選單裡的幾種預設組合 —— 預設組合永遠少一種你要的。
// 外資／投信／自營三組各自選方向，所以「土洋同買」＝外資買超＋投信買超、
// 「對作」＝外資買超＋投信賣超，不必另外給名字。
//
// 歷史維度（連續、力道、近 20 日）一律看**外資**：連續榜本來就只算外資
// （見連買頁），力道與累計三邊都有，但三邊各給一組條件會讓這一頁變成 14 排 pill，
// 而外資是這三個維度上最常被問的那一邊。
//
// ## 漏斗：看得出是哪一條條件把清單砍光
//
// 多條件篩選最惱人的情況是「一檔都沒有」，而畫面不告訴你是哪一條害的。所以條件
// 逐條套用時記下每一步剩幾檔，畫成一個漏斗 —— 砍最兇的那一條一眼就看得出來。
//
// ## 歷史回看＝把頂部的日期往回挪
//
// 「對過去 20 天每天跑一次」要抓 20 × 159 KB ≈ 3.1 MB（這一頁一天就要五份檔案）。
// 不值得，而且瀏覽器要算 20 遍。這一頁吃的是全站共用的日期選單，往回挪一天就是
// 對那一天跑同一組條件 —— 條件記在 localStorage，換日期不會被重設。
// --------------------------------------------------------------------------
const RADAR_CONDS = [
  { key: 'fo', label: '外資', opts: [['', '不限'], ['buy', '買超'], ['sell', '賣超']] },
  { key: 'tr', label: '投信', opts: [['', '不限'], ['buy', '買超'], ['sell', '賣超']] },
  { key: 'de', label: '自營', opts: [['', '不限'], ['buy', '買超'], ['sell', '賣超']] },
  { key: 'against', label: '逆勢', opts: [['', '不限'], ['buy', '買超收黑'], ['sell', '賣超收紅']] },
  { key: 'force', label: '力道', opts: [['', '不限'], ['2', '2 倍'], ['3', '3 倍'], ['5', '5 倍']] },
  { key: 'run', label: '連續', opts: [['', '不限'], ['b3', '連買 3'], ['b5', '連買 5'], ['b8', '連買 8'], ['s3', '連賣 3'], ['s5', '連賣 5']] },
  { key: 'sum20', label: '近20日', opts: [['', '不限'], ['buy', '累計買超'], ['sell', '累計賣超']] },
  { key: 'min', label: '門檻', opts: [['0.1', '0.1 億'], ['0.5', '0.5 億'], ['1', '1 億'], ['3', '3 億']] },
];
const RADAR_KEY = 'stocktracker.radar';
const RADAR_TOP = 50;        // 命中太多時最多列幾檔

/** 條件列：左邊一個標籤、右邊一組 pill。八組疊在一起，沒有標籤就認不出在篩什麼。 */
const condRow = (cond, current) =>
  `<div class="cond"><b>${esc(cond.label)}</b><div class="pills">${cond.opts
    .map(([value, label]) => `<button class="pill ${value === current ? 'active' : ''}"
      data-radar="${cond.key}:${value}">${esc(label)}</button>`)
    .join('')}</div></div>`;

/**
 * 把五份檔案併成一排「每一檔的所有籌碼屬性」。
 * 缺哪一份就少哪一種屬性（例如資料起點附近沒有 base/，那幾天就沒有力道），
 * 對應的條件會篩不到東西 —— 那是誠實的空集合，不是壞掉。
 */
function radarRows(daily, chg, base, runs, sums, markets) {
  const moved = (chg && chg.chg) || {};
  const norms = (base && base.base) || {};
  const cut = daily.cut || 0.05;

  const streak = new Map();
  for (const stocks of Object.values((runs && runs.stocks) || {})) {
    for (const [code, row] of Object.entries(stocks)) streak.set(code, row[R_DAYS]);
  }

  const long = new Map();
  const block = sums && sums.w && sums.w['20'];
  for (const [code, row] of Object.entries((block && block.rows) || {})) {
    long.set(code, row[W_FO]);
  }

  return instiRows(daily)
    .filter((r) => markets.includes(r.market))
    .map((r) => ({
      ...r,
      chg: moved[r.code],
      // 力道與連續、累計一樣只看外資，理由見這一段最上面的說明
      force: forceOf((norms[r.code] || [])[LEG_AT.fo], r.fo, cut),
      run: streak.get(r.code),
      sum20: long.get(r.code),
    }));
}

/** 一條條件的判斷。回 true 代表這一檔通過。 */
function radarPass(row, key, value, min) {
  if (!value) return true;
  if (key === 'fo' || key === 'tr' || key === 'de') {
    return value === 'buy' ? row[key] >= min : row[key] <= -min;
  }
  if (key === 'against') {
    if (!row.chg) return false;                 // 平盤與算不出漲跌的都不算逆勢
    return value === 'buy' ? row.fo > 0 && row.chg < 0 : row.fo < 0 && row.chg > 0;
  }
  if (key === 'force') {
    return row.force !== null && row.force !== undefined && row.force >= Number(value);
  }
  if (key === 'run') {
    const days = row.run;
    if (!days) return false;
    const want = Number(value.slice(1));
    return value[0] === 'b' ? days >= want : -days >= want;
  }
  if (key === 'sum20') {
    if (row.sum20 === undefined) return false;
    return value === 'buy' ? row.sum20 > 0 : row.sum20 < 0;
  }
  return true;
}

/** 逐條套用，記下每一步剩幾檔。最後一格就是命中的集合。 */
function radarFunnel(rows, picks) {
  const steps = [];
  let left = rows;
  for (const cond of RADAR_CONDS) {
    if (cond.key === 'min') continue;           // 門檻不是獨立的一條，它是上面幾條的參數
    const value = picks[cond.key];
    if (!value) continue;
    left = left.filter((r) => radarPass(r, cond.key, value, Number(picks.min)));
    const label = (cond.opts.find(([v]) => v === value) || [])[1] || value;
    steps.push({ label: `${cond.label} ${label}`, n: left.length });
  }
  return { steps, hit: left };
}

function radarRow(entry, seq, ranked) {
  const stock = ranked.get(entry.code);
  const sum = entry.fo + entry.tr + entry.de;
  const extra = [];
  if (entry.run) extra.push(`<span class="chip">連${entry.run > 0 ? '買' : '賣'} ${Math.abs(entry.run)} 天</span>`);
  if (entry.sum20 !== undefined) extra.push(`<span class="chip">近20日 ${signedOku(entry.sum20)}</span>`);
  if (stock) extra.push(`<span class="chip">名次 ${stock.rank}</span>`);
  const share = stock && stock.value
    ? `佔成交值 ${num((Math.abs(sum) * 1e8 / stock.value) * 100, 1)}%` : '—';
  return `<a class="row" href="#/stock/${entry.code}">
    <div class="rank"><span class="no">${seq}</span>
      <span class="delta ${trend(entry.chg)}">${chgText(entry.chg)}</span></div>
    <div class="ident">
      <span class="name">${state.watch.has(entry.code) ? '<span class="star">★</span>' : ''}${esc(entry.name)}</span>
      <span class="code">${entry.code} · ${esc(MARKET_TAGS[entry.market])}${
        hasIndustry() ? ` · ${esc(industryOf(entry.code))}` : ''}</span>
      <span class="chips">${instiChips(entry)}${extra.join('')}</span>
    </div>
    <div class="figures">
      <span class="value ${trend(sum)}">${signedOku(sum)}</span>
      <span class="price">${forceText(entry.force).replace(' · ', '') || '力道 —'}</span>
      <span class="price">${num(entry.close, 2)} · ${share}</span>
    </div>
  </a>`;
}

/**
 * 雷達清單。這一頁是篩選器不是排行榜，桌面就把**每一條篩選條件看的那個數字**各給
 * 一欄：讀者按完漏斗，要能一眼核對「這幾檔憑什麼進來」。
 *
 * 連續與近 20 日來自衍生檔，那一天沒有那份檔就整欄不出——一整欄破折號只是佔位置，
 * 而上面的漏斗已經講過少了哪幾份。
 */
const radarList = (entries, ranked) => listOf(entries,
  (r, i) => radarRow(r, i + 1, ranked),
  (list) => ({
    href: (r) => `#/stock/${r.code}`,
    cols: [
      colSeq,
      col('名稱', W.name, 'w-name', (r) => wideName(r.code, r.name, r.market)),
      ...(hasIndustry() ? [colIndustry((r) => r.code, true)] : []),
      col('漲跌%', W.pct, 'w-num', (r) => widePct(r.chg)),
      col('外資', W.oku, 'w-num', (r) => wideOku(r.fo)),
      col('投信', W.oku, 'w-num', (r) => wideOku(r.tr)),
      col('自營', W.oku, 'w-num', (r) => wideOku(r.de)),
      col('三大法人', W.oku, 'w-num w-val',
        (r) => wideOku(r.fo + r.tr + r.de)),
      optional(col('佔成交值', W.share, 'w-num',
        (r) => wideShare(r.fo + r.tr + r.de, ranked.get(r.code)))),
      col('力道', W.force, 'w-num', (r) => wideForce(r.force)),
      ...(list.some((r) => r.run) ? [col('外資連續', W.note, 'w-num',
        (r) => (r.run
          ? `<em class="${trend(r.run)}">連${r.run > 0 ? '買' : '賣'} ${Math.abs(r.run)} 天</em>`
          : '—'))] : []),
      ...(list.some((r) => r.sum20 !== undefined)
        ? [col('近 20 日', W.oku, 'w-num',
          (r) => (r.sum20 === undefined ? '—' : wideOku(r.sum20)))] : []),
    ],
  }));

async function renderRadar(view) {
  let index;
  try {
    index = await loadInstiIndex();
  } catch (err) {
    view.innerHTML = `<p class="hint">還沒有法人資料（${esc(err.message)}）。<br>
      請先執行 <code>scripts/fetch_institutions.py</code> 與
      <code>scripts/build_institutions.py</code>。</p>`;
    return;
  }
  const days = index.days || [];
  const picks = state.radar;
  const controls = `<div class="conds">${RADAR_CONDS
    .map((c) => condRow(c, picks[c.key])).join('')}</div>`;

  if (!days.some((d) => d.d === state.date)) {
    view.innerHTML = `${controls}
      <p class="hint">${state.date} 還沒有法人資料。<br>
      目前有 ${days.length} 個交易日：${esc(index.first)} ~ ${esc(index.latest)}。<br>
      這一頁吃頂部的日期選單，把日期挪到那一段裡面就會跑。</p>`;
    return;
  }

  // 五份檔案缺哪一份就少哪一種條件，所以全部用 catch 包起來，不讓其中一份拖垮整頁
  const [daily, chg, base, runs, sums, dailyRank] = await Promise.all([
    loadInstiDay(state.date),
    loadInstiChg(state.date).catch(() => null),
    loadInstiBase(state.date),
    loadInstiRun(state.date).catch(() => null),
    loadInstiSum(state.date).catch(() => null),
    loadDaily(state.date),
  ]);
  const ranked = new Map(dailyRank.stocks.map((s) => [s.code, s]));
  const markets = state.scope === 'all' ? ['twse', 'tpex'] : [state.scope];
  const rows = radarRows(daily, chg, base, runs, sums, markets);
  const { steps, hit } = radarFunnel(rows, picks);

  const missing = [
    !chg && '當日漲跌（逆勢）', !base && '平常的量（力道）',
    !runs && '連續買賣（連續）', !sums && '跨日累計（近 20 日）',
  ].filter(Boolean);

  const sorted = [...hit].sort((a, b) =>
    Math.abs(b.fo + b.tr + b.de) - Math.abs(a.fo + a.tr + a.de));
  // 匯出的是**命中的全部**，不是畫面上取前 50 的那一份 —— 篩選器的產出就是那個集合
  setExport(`籌碼雷達_${state.scope}_${state.date}.csv`,
    ['代號', '名稱', '市場', '漲跌%', '外資(億)', '投信(億)', '自營(億)', '三大法人(億)',
      '力道(倍)', '外資連續天數', '近20日外資(億)', '收盤'],
    sorted.map((r) => [r.code, r.name, MARKET_TAGS[r.market], r.chg,
      r.fo.toFixed(2), r.tr.toFixed(2), r.de.toFixed(2), (r.fo + r.tr + r.de).toFixed(2),
      r.force === null || r.force === undefined ? '' : r.force.toFixed(1),
      r.run || '', r.sum20 === undefined ? '' : r.sum20, r.close]));

  view.innerHTML = `
    ${controls}
    <section class="card">
      <h2>籌碼雷達 <small>${esc(state.date)} ${esc(scopeLabel())} · 命中 ${hit.length} 檔</small></h2>
      ${steps.length ? `<ol class="funnel">
        <li><span>全部</span><b>${rows.length}</b></li>
        ${steps.map((s) => `<li><span>${esc(s.label)}</span><b>${s.n}</b></li>`).join('')}
      </ol>
      <p class="note">上面是<b>漏斗</b>：條件由上而下逐條套用，每一格是套完之後還剩幾檔。
        一檔都不剩的時候，砍最兇的是哪一條一眼就看得出來 —— 多條件篩選最惱人的情況
        就是「什麼都沒有」而畫面不告訴你為什麼。</p>`
      : `<p class="note">目前<b>一條條件都沒下</b>，所以這裡是這一天全部的 ${rows.length} 檔。
        上面八組各自預設「不限」，選幾組就是取它們的<b>交集</b>。</p>`}
      <p class="note">「外資／投信／自營」看的是<b>當日</b>的方向，門檻那一排是它們共用的金額下限
        （買超 ≥ 門檻、賣超 ≤ −門檻）。所以「土洋同買」＝外資買超＋投信買超、
        「土洋對作」＝外資買超＋投信賣超，不必另外給名字。</p>
      <p class="note"><b>逆勢、力道、連續、近 20 日這四條只看外資。</b>連續榜本來就只算外資，
        而力道與累計三邊都有 —— 三邊各給一組條件會讓這一頁變成 14 排 pill，
        而外資是這三個維度上最常被問的那一邊。</p>
      ${missing.length ? `<p class="note">${esc(state.date)} 少了這幾份衍生檔：
        ${esc(missing.join('、'))}。對應的條件會篩不到任何東西 —— 那是誠實的空集合，
        不是壞掉（資料起點附近算不出來的那幾天就會這樣）。</p>` : ''}
    </section>
    ${exportBar()}
    ${listCard('命中的股票',
      `依三大法人合計金額排序 · ${hit.length > RADAR_TOP ? `命中 ${hit.length} 檔，取前 ${RADAR_TOP}` : `共 ${hit.length} 檔`}`,
      radarList(sorted.slice(0, RADAR_TOP), ranked),
      `${state.date} 沒有任何一檔同時符合這幾條。把上面的漏斗由下往上看，
       最後一格掉到 0 的那一條就是最嚴的那一條。`)}
    <section class="card">
      <h2>這一頁在講什麼 <small>以及不能拿它講什麼</small></h2>
      <p class="note">前面幾頁各自是一張排行榜：買超頁問「誰買最多」、連買頁問「誰買最久」、
        法人頁問「外資與投信同不同邊」。每一張都只排一個維度，而真正想問的往往是<b>交集</b>。
        這一頁因此不是排行榜而是<b>篩選器</b> —— 它輸出的是一個集合，不是一個名次
        （列出來的順序只是為了好讀，依三大法人合計金額排）。</p>
      <p class="note"><b>歷史回看就是把頂部的日期往回挪。</b>這一頁一天要吃五份衍生檔
        （約 160 KB），「對過去 20 天每天跑一次」是 3 MB 加上瀏覽器算 20 遍，不值得。
        條件記在瀏覽器裡，換日期不會被重設，所以往回翻就是對那一天跑同一組條件。</p>
      <p class="note">${INSTI_CAVEAT}</p>
      <p class="note">條件全部是<b>事後的籌碼紀錄</b>：這些帳戶昨天收盤前做了什麼。它沒有說
        為什麼，也沒有說明天會怎樣 —— 外資的買超裡混著避險、借券還券與指數調整，
        投信在季底與年底有作帳的動機。<b>命中不是買進訊號，這一頁也不提供訊號。</b></p>
    </section>`;
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

/**
 * 展開後那一行「連動美股」的說明。連動不是因果：美股只是同一個訊號比台股早幾個小時
 * 反應，真正的驅動常是報價指數（SCFI、BDI、DXI、合約價）與匯率，這點要講在前面。
 */
function usNote() {
  if (!hasUsLink()) return '';
  const stars = [3, 2, 1].map((s) => `${US_STARS[s]} ${US_MEANS[s]}`).join('；');
  const bench = state.usBench.map((b) => `<b>${esc(b.t)}</b>（${esc(b.n)}）`).join('、');
  return `<br>展開一族會多一行<b>連動美股</b>（<code>data/us_link.json</code>${
    state.usUpdated ? `，維護於 ${esc(state.usUpdated)}` : ''}）：${stars}。
    ${bench ? `大盤層級另看 ${bench}。` : ''}
    美股只是同一個訊號比台股早幾個小時反應，真正的驅動常是報價與匯率——這是觀察的起點，不是訊號。
    星等是人工標的；想看實際算出來的相關性百分比與美股漲跌幅，去
    <a class="accent" href="us.html">美股 × 台股連動</a>。`;
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
  // 連動美股只有族群頁講得到（要展開一族才看得到那一行），流向頁沒有可以展開的列
  const note = groupingNote(mode, topStocks.length, ungrouped) + (mode === 'theme' ? usNote() : '');

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
  const rowsOf = (codes) => stockList(codes
    .slice()
    .sort((a, b) => byCode.get(a).rank - byCode.get(b).rank)
    .map((c) => ({ s: byCode.get(c), base: baseRanks.get(c) })));
  const bodyOf = (name) => {
    const g = found.get(name);
    if (!g) return '';
    // 連動美股只掛在題材族群上：官方產業（「電子零組件業」）的顆粒度對不到任何一段供應鏈
    const top = mode === 'theme' ? usLinkOf(name) : [];
    const head = usLine(top, usWhyOf(name));
    const subLine = (sub) => {
      const us = mode === 'theme' ? usLinkOf(name, sub.name) : [];
      return usLine(sameUs(us, top) ? [] : us);
    };
    if (!g.subs) return head + rowsOf(g.codes);
    if (g.subs.length < 2) return head + rowsOf(g.subs[0].codes);
    return head + g.subs.map((sub) =>
      `<p class="subhead">${esc(sub.name)}
        <small>${sub.codes.length} 檔 · ${fmtValue(sub.value)}</small></p>
       ${subLine(sub)}${rowsOf(sub.codes)}`).join('');
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
 * 報價清單。手機一列是「名稱＋迷你走勢＋數字」，桌面把擠在名稱底下那行小字（來源
 * 表、單位、類別）拆成欄——同一張卡裡的品項單位常常不一樣（美元／噸 與 人民幣／片
 * 並排），單位成欄才看得出「這兩個數字不能直接比大小」。
 *
 * valuesOf 給迷你走勢的序列；withTable 為假時來源表寫在卡片標題上，不再出一欄。
 */
const quoteList = (items, valuesOf, { withTable = true } = {}) => listOf(items,
  (item) => quoteRow(item, valuesOf(item), { withTable }),
  () => ({
    href: (item) => `#/quote/${encodeURIComponent(item.id)}`,
    cols: [
      col('品項', W.title, 'w-name', (item) => esc(item.name)),
      ...(withTable
        ? [col('來源表', W.text, 'w-ind', (item) => esc(item.table))] : []),
      col('單位', W.text, 'w-ind', (item) => esc(quoteUnit(item))),
      col('類別', W.kind, 'w-ind',
        (item) => esc((QUOTE_KINDS[item.kind] || QUOTE_KINDS.price).label)),
      col('走勢', W.spark, 'w-spark', (item) => sparkline(valuesOf(item))),
      col('最新', W.price, 'w-num w-val', (item) => quoteNum(item.last.v)),
      col('報價日', W.date, 'w-num w-streak', (item) => esc(item.last.d)),
      col(quoteSpanSpec().label, W.pct, 'w-num', (item) => {
        const chg = quoteChg(item);
        return chg === null ? '—' : `<em class="${trend(chg)}">${signedPct(chg, 2)}</em>`;
      }),
    ],
  }));

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
    const rows = quoteList(
      group.slice().sort((a, b) => (quoteChg(b) ?? -Infinity) - (quoteChg(a) ?? -Infinity)),
      valuesOf, { withTable: false });
    // 金屬與指數的「表」就是品類本身（一個品類一張卡），不要印成「金屬原料 · 金屬原料」
    const title = table === catName(cat) ? table : `${catName(cat)} · ${table}`;
    return listCard(title,
      `報價日 ${asof} · ${group[0].freq}更新 · ${group.length} 項`, rows);
  });

  const moverRows = (list, n = 6) => quoteList(list.slice(0, n), valuesOf);

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
      ${quoteList(retired.slice().sort((a, b) => (a.last.d < b.last.d ? 1 : -1)), valuesOf)}
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
/*
 * 導覽（群組 → 分頁）整組搬到 docs/nav.js 了：us.html 以前是照著這裡的 NAV 手抄
 * 一份寫死在它自己的 HTML 裡，兩邊得靠記性同步。現在兩頁共用同一份，這裡只剩呼叫。
 */

// --------------------------------------------------------------------------
// 匯出與分享
//
// 在這之前完全沒有把資料帶走的方法，也沒有把「我現在看到的畫面」給別人的方法。
// 兩件事都不需要後端。
//
// ## CSV：前端組字串 + Blob
//
// 開頭一定要放 BOM（﻿）。少了它，Excel 會用系統的 ANSI 編碼去猜，中文股名
// 整欄變亂碼 —— 這是最常被回報、又最容易漏掉的一件事。
//
// 欄位裡的逗號、引號與換行照 RFC 4180 處理（用雙引號包起來、內部的引號變兩個）。
// 股票名稱裡確實有逗號以外的怪字元（「臻鼎-KY」「國巨*」「康霈*」），但真正會
// 咬到的是題材族群那種人工維護的欄位，所以一律照規矩跳脫，不挑欄位。
//
// ## 分享連結：把狀態放進網址，而且用完就拿掉
//
// 這支 SPA 的 hash 只有「哪一頁」（#/rank），日期與範圍是存在 state 裡的 ——
// 所以直接複製網址給別人，對方看到的是他自己的日期與範圍，不是你的。
//
// 分享鈕產生的網址帶 `?d=` 與 `?s=`，render() 開場時讀到就套用，**然後立刻從網址
// 上拿掉**（replaceState，不會觸發 hashchange）。一次性的理由很實際：留著的話，
// 使用者接下來自己換日期會被網址上的 d 一直蓋回去 —— 那是個很難查的 bug。
// --------------------------------------------------------------------------

/** 一格 CSV。逗號、雙引號、換行都要包起來（RFC 4180）。 */
const csvCell = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * 把畫面上那份資料存成 CSV。
 * BOM 開頭，否則 Excel 會把中文欄位整欄讀成亂碼。
 */
function downloadCSV(name, header, rows) {
  const text = '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 立刻釋放：Blob 會一直佔著記憶體直到分頁關掉
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** 目前畫面上那一份帶得走的資料。render 時設好，匯出鈕按下去才有東西可給。 */
function setExport(name, header, rows) {
  state.csv = rows && rows.length ? { name, header, rows } : null;
}

/**
 * 匯出與分享那兩顆鈕。兩顆一律都畫出來 —— 外層的 HTML 在 state.csv 填好之前就
 * 排好了（排行頁的清單是 paint() 之後才進去的），依 state.csv 決定要不要畫，
 * 第一次進頁面就會少一顆。按下去沒東西可匯出時由事件那邊講話。
 */
const exportBar = () => `<div class="controls tools">
  <button class="linky" id="export-csv">⤓ 下載 CSV</button>
  <button class="linky" id="share-link">🔗 複製分享連結</button>
  <span class="tools-said" id="tools-said"></span>
</div>`;

/**
 * 目前畫面的分享網址：帶上日期與範圍，別人打開才會看到同一個畫面。
 * 其餘的篩選條件（門檻、排序、雷達的八組條件）不放進去 —— 那些記在對方自己的
 * localStorage 裡，硬塞進網址會變成「打開別人的連結，自己的設定被改掉」。
 */
function shareURL() {
  const { view, arg } = parseHash();
  const path = `${view}${arg ? `/${arg}` : ''}`;
  const params = new URLSearchParams({ d: state.date, s: state.scope });
  return `${location.origin}${location.pathname}#/${path}?${params}`;
}

/**
 * 網址上的 d／s 套用到 state，然後把這兩個參數從網址拿掉。
 * 回傳有沒有動到東西（有的話 paintChrome 要重畫選單）。
 */
function applyShareParams(route) {
  const wantDate = route.params.get('d');
  const wantScope = route.params.get('s');
  let changed = false;
  if (wantDate && state.index.dates.includes(wantDate)) {
    state.date = wantDate;
    changed = true;
  }
  if (wantScope && SCOPES.some((s) => s.value === wantScope)) {
    state.scope = wantScope;
    changed = true;
  }
  if (!wantDate && !wantScope) return false;

  // 用完就拿掉，其餘參數（例如對照頁的 a／b）原樣留著
  route.params.delete('d');
  route.params.delete('s');
  const rest = route.params.toString();
  const path = `${route.view}${route.arg ? `/${route.arg}` : ''}`;
  history.replaceState(null, '', `${location.pathname}#/${path}${rest ? `?${rest}` : ''}`);
  return changed;
}

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

/** 上一次畫的是哪一頁。用來分辨「換頁」與「同一頁換條件」，見 render()。 */
let lastRouteKey = null;

async function render() {
  const route = parseHash();
  // 分享連結帶來的日期與範圍。套用之後就從網址上拿掉，不然使用者自己換日期會被蓋回去
  applyShareParams(route);
  StockNav.paintNav(route.view);
  destroyCharts();
  const view = $('#view');
  // 流向頁那兩張圖看的是面積，寬螢幕不跟其他分頁一樣限在 720px
  view.classList.toggle('wide', route.view === 'flow');

  /*
   * 換頁要回到頂端，換篩選不要。
   *
   * render() 不只在 hashchange 時跑——換日期、換範圍、按藥丸都會叫它一次，而那些
   * 都不動 hash。正在比較兩組條件時被彈回頂端很煩，所以比對的是「哪一頁」而不是
   * 「有沒有重畫」。個股頁換代號（#/stock/2330 → 2454）算換頁，所以 arg 也要比。
   */
  const routeKey = `${route.view}/${route.arg || ''}`;
  const turned = routeKey !== lastRouteKey;
  if (turned) {
    lastRouteKey = routeKey;
    window.scrollTo(0, 0);
    view.scrollTop = 0;   // 桌面版捲的是 .view（固定外殼），不是 window
  }

  /*
   * 換頁才清空畫面，同一頁換條件**不要**清空。
   *
   * 清空會讓文件高度塌陷，瀏覽器就把捲動位置夾到 0；資料回來、高度長回去了，位置也
   * 不會自己復原。行動網路上捲到第 80 名再換一個日期，就是這樣被彈回頂端的——換頁
   * 本來就要回頂端所以看不出來，換日期時才看得出來。
   *
   * 留著舊內容高度就還在，位置自然保得住，而且換日期時舊資料留在畫面上反而利於比較。
   * 換頁那一路照舊給「載入中…」：捲動位置已經歸零了，上一頁的內容留著只會看起來像
   * 沒反應。
   */
  if (turned) view.innerHTML = '<p class="hint">載入中…</p>';
  view.classList.add('loading');
  // 上一頁的匯出資料不能留到下一頁 —— 那會讓人在圖表頁按下匯出、拿到別頁的清單
  state.csv = null;

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
    else if (route.view === 'entry') await renderEntry(view);
    else if (route.view === 'period') await renderPeriod(view);
    else if (route.view === 'burst') await renderBurst(view);
    else if (route.view === 'ma') await renderMa(view);
    else if (route.view === 'macd') await renderMacd(view);
    else if (route.view === 'holders') await renderHolders(view, route.arg);
    else if (route.view === 'insti') await renderInsti(view);
    else if (route.view === 'instirank') await renderInstiRank(view);
    else if (route.view === 'instirun') await renderInstiRun(view);
    else if (route.view === 'radar') await renderRadar(view);
    else if (route.view === 'quote') await renderQuote(view, route.arg);
    else if (route.view === 'stock') await renderStock(view, route.arg);
    else if (route.view === 'compare') await renderCompare(view, route.params);
    else await renderRank(view);
    paintChrome();
  } catch (err) {
    view.innerHTML = failBox(`載入失敗：${err.message}`,
      `前端版本 ${APP_VERSION}。若清除快取後仍然一樣，就不是快取的問題。`);
  } finally {
    // 上面有一條提早 return 的路（那個範圍那一天沒有資料），所以放 finally
    view.classList.remove('loading');
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
    if (pill.dataset.instimin) {
      state.instiMin = Number(pill.dataset.instimin);
      try {
        localStorage.setItem(INSTI_MIN_KEY, String(state.instiMin));
      } catch (err) {
        /* 記不住就算了，下次回到預設的 0.5 億 */
      }
    }
    if (pill.dataset.instileg) {
      state.instiLeg = pill.dataset.instileg;
      try {
        localStorage.setItem(INSTI_LEG_KEY, state.instiLeg);
      } catch (err) {
        /* 記不住就算了，下次回到預設的外資 */
      }
    }
    if (pill.dataset.instiwin) {
      state.instiWin = pill.dataset.instiwin;
      try {
        localStorage.setItem(INSTI_WIN_KEY, state.instiWin);
      } catch (err) {
        /* 記不住就算了，下次回到預設的當日 */
      }
    }
    if (pill.dataset.period) {
      state.period = pill.dataset.period;
      try {
        localStorage.setItem(PERIOD_KEY, state.period);
      } catch (err) {
        /* 記不住就算了，下次回到預設的本週 */
      }
    }
    if (pill.dataset.radar) {
      const [key, value] = pill.dataset.radar.split(':');
      state.radar = { ...state.radar, [key]: value };
      try {
        localStorage.setItem(RADAR_KEY, JSON.stringify(state.radar));
      } catch (err) {
        /* 記不住就算了，下次回到八組都「不限」 */
      }
    }
    if (pill.dataset.instisort) {
      state.instiSort = pill.dataset.instisort;
      try {
        localStorage.setItem(INSTI_SORT_KEY, state.instiSort);
      } catch (err) {
        /* 記不住就算了，下次回到預設的依金額 */
      }
    }
    if (pill.dataset.rundays) {
      state.runDays = Number(pill.dataset.rundays);
      try {
        localStorage.setItem(RUN_DAYS_KEY, String(state.runDays));
      } catch (err) {
        /* 記不住就算了，下次回到預設的 3 天 */
      }
    }
    // 「不限」的 value 是 0，但 dataset 讀出來是字串 "0"，照樣進得來
    if (pill.dataset.runoku) {
      state.runOku = Number(pill.dataset.runoku);
      try {
        localStorage.setItem(RUN_OKU_KEY, String(state.runOku));
      } catch (err) {
        /* 記不住就算了，下次回到預設的「不限」 */
      }
    }
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

  // 匯出與分享。畫面重繪後不必重新綁定，所以用事件委派。
  $('#view').addEventListener('click', async (e) => {
    const said = (text) => {
      const box = $('#tools-said');
      if (box) box.textContent = text;
    };
    if (e.target.closest('#export-csv')) {
      if (!state.csv) return said('這一頁沒有可以匯出的清單');
      downloadCSV(state.csv.name, state.csv.header, state.csv.rows);
      said(`已下載 ${state.csv.rows.length} 列`);
    }
    if (e.target.closest('#share-link')) {
      const url = shareURL();
      try {
        await navigator.clipboard.writeText(url);
        said('已複製，連結帶著目前的日期與範圍');
      } catch (err) {
        // 非 HTTPS 或使用者拒絕剪貼簿權限時，至少把網址秀出來讓他自己複製
        said(url);
      }
    }
  });

  window.addEventListener('hashchange', render);

  /*
   * 跨過 1024px（換不換多欄）或 1280px（窄桌面要不要省略上下文欄）就得重畫：清單的
   * 欄位是在 render() 裡決定的，不是 CSS 能切換的東西。
   * 只有真的跨過斷點才會發事件，拉視窗的過程中不會一直重畫。
   */
  wide.addEventListener('change', render);
  roomy.addEventListener('change', render);
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
  // 美股對照又是題材族群的選配：沒有這一份，族群頁照常，只是少了「連動美股」那一行。
  try {
    const us = await getJSON(`${DATA}/us_link.json`);
    state.usLink = Array.isArray(us.groups) ? us.groups : [];
    state.usUpdated = us._updated || '';
    state.usBench = Array.isArray(us.benchmarks) ? us.benchmarks : [];
  } catch (err) {
    state.usLink = [];
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
    const instiMin = Number(localStorage.getItem(INSTI_MIN_KEY));
    if (INSTI_MINS.some((o) => o.value === instiMin)) state.instiMin = instiMin;
    const instiLeg = localStorage.getItem(INSTI_LEG_KEY);
    if (INSTI_LEGS.some((o) => o.value === instiLeg)) state.instiLeg = instiLeg;
    const instiWin = localStorage.getItem(INSTI_WIN_KEY);
    if (INSTI_WINS.some((o) => o.value === instiWin)) state.instiWin = instiWin;
    const instiSort = localStorage.getItem(INSTI_SORT_KEY);
    if (INSTI_SORTS.some((o) => o.value === instiSort)) state.instiSort = instiSort;
    // 雷達的條件整包存成 JSON。只收認得的鍵與認得的值 —— 舊版存下來的條件組合
    // 換了選項之後可能已經不存在，照單全收會讓畫面上一顆 pill 都不是 active
    const period = localStorage.getItem(PERIOD_KEY);
    if (PERIODS.some((o) => o.value === period)) state.period = period;
    const radar = JSON.parse(localStorage.getItem(RADAR_KEY) || '{}');
    for (const cond of RADAR_CONDS) {
      if (cond.opts.some(([v]) => v === radar[cond.key])) state.radar[cond.key] = radar[cond.key];
    }
    // 「不限」是 0，而讀不到時 Number(null) 也是 0 —— 兩者的結果一樣，所以不用分辨
    const runDays = Number(localStorage.getItem(RUN_DAYS_KEY));
    if (RUN_DAYS.some((o) => o.value === runDays)) state.runDays = runDays;
    const runOku = Number(localStorage.getItem(RUN_OKU_KEY));
    if (RUN_OKUS.some((o) => o.value === runOku)) state.runOku = runOku;
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
