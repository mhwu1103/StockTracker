'use strict';

const DATA = 'data';
const TOP = 200;                       // 排行榜與進出榜的門檻
const KEPT = 300;                      // daily/*.json 每天留幾名（twse.py 的 TOP_N）
const CHART_CDN = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js';

// 圖表線色。Chart.js 吃不到 CSS 變數，只能寫死；深淺色模式都看得清楚的中間色調。
const LINE = { rank: '#2f6fed', market: '#2f6fed', top200: '#7b61ff', top10: '#d92d20' };

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
  macdSide: 'up',      // 「MACD」分頁：up 黃金交叉／down 死亡交叉
  macdWhen: '3',       // 「MACD」分頁的時點：近 N 日已交叉，或 d1 明天／d2 後天
  daily: new Map(),    // date -> Promise<payload>
  history: new Map(),  // year -> Promise<payload>
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
    const rows = top
      .filter(match)
      .filter((s) => s.value >= state.floor * 1e8)
      .filter((s) => !q || s.code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
      .sort((a, b) => sortKey(b) - sortKey(a))
      .map((s) => stockRow(s, baseMap.get(s.code)));

    const watchNote = state.sector === '!WATCH'
      ? `<p class="note">自選清單：<code id="watch-codes">${[...state.watch].sort().join(',')}</code>
          <button class="linky" id="copy-watch">複製</button><br>
          自選股只存在這台裝置的瀏覽器。要讓 Telegram 也只推這幾檔，把上面這串設成 <code>WATCHLIST</code> secret。</p>`
      : '';
    $('#rank-list').innerHTML =
      (rows.length ? rows.join('') : '<p class="hint">找不到符合的股票</p>') + watchNote;

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
      <span class="ma-chips">${maChips(stock)}</span></div>
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
  const verb = side === 'up' ? '站上' : '跌破';
  const span = maSpanText(days);

  const board = today.stocks.filter((s) => s.rank <= TOP);
  const above = board.filter((s) => maAbove(s, win) === true).length;
  const below = board.filter((s) => maAbove(s, win) === false).length;
  const unknown = board.length - above - below;
  const allUp = board.filter((s) => maStacked(s, 'up')).length;

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

  // 四線篩選先套在池子上，矩陣的每一格與下面的清單都只算這個池子裡的
  const pool = stack === 'any' ? board : board.filter((s) => maStacked(s, stack));
  const stackText = stack === 'any' ? '' : `　${stack === 'up' ? '四線全上' : '四線全下'}`;
  const hits = pool
    .filter((s) => maHit(s, win, side, days))
    .sort((a, b) => Math.abs(maRun(a, win) || MA_STREAK_MAX + 1) - Math.abs(maRun(b, win) || MA_STREAK_MAX + 1)
      || a.rank - b.rank);

  view.innerHTML = `
    <div class="controls">${pills('maside', MA_SIDES, side)}${pills('mastack', MA_STACKS, stack)}</div>
    <section class="card">
      <h2>${side === 'up' ? '剛站上' : '剛跌破'}${stackText}
        <small>幾檔在近 N 個交易日內穿越，按數字換清單</small></h2>
      <div class="matrix-box">${maMatrix(pool, side)}</div>
    </section>
    <div class="card"><div class="stat-grid">
      <div class="stat"><b class="${side === 'up' ? 'up' : 'down'}">${hits.length}</b>
        <span>${span}${verb} ${win} 日線</span></div>
      <div class="stat"><b class="up">${above}</b><span>收在 ${win} 日線上</span></div>
      <div class="stat"><b class="down">${below}</b><span>收在 ${win} 日線下</span></div>
      <div class="stat"><b class="up">${allUp}</b><span>四線全上</span></div>
      <div class="stat"><b>${unknown}</b><span>${win} 日線資料不足</span></div>
    </div></div>
    ${listCard(`${state.date} ${span}${verb} ${win} 日線${stackText}`,
      `榜上前 ${TOP} 名　${days ? '穿越越新的排越前面' : '天數短的排前面'}`,
      hits.map((s) => maRow(s, baseMap.get(s.code), win)),
      `${state.date} 榜上沒有${stackText ? `${stackText.trim()}、而且` : ''}${span}${verb} ${win} 日線的股票，把天數或線別換一個看看`)}
    <section class="card">
      <h2>這一頁在看什麼</h2>
      <p class="note">均線是收盤價的算術平均：${win} 日線就是含今天在內最近 ${win} 個交易日的收盤均價。
        「站上」是收盤價高於均線，「跌破」是收盤價不高於均線（剛好相等算在跌破那一側）。
        「近 N 日」數的是連續站上／跌破的天數：1 是今天剛穿越，3 是今天為穿越後的第 3 天——
        中間只要收回線的另一側，天數就重新起算。最後一欄的「不限」不看天數，是現在就收在那一側的全部。</p>
      <p class="note">每一列的 ${MA_WINDOWS.join('／')} 標記是這四條線各自的位置（▲ 收在線上、▼ 收在線下、· 資料不足），
        上面那排「四線全上／全下」就是拿這四個標記在篩：四個都 ▲ 代表短中長期的均線全在腳下，今天有 ${allUp} 檔。
        四條線裡只要有一條算不出來就不算數。乖離是收盤價離這條均線幾 %。</p>
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
  const name = side === 'up' ? '黃金交叉' : '死亡交叉';

  const board = today.stocks.filter((s) => s.rank <= TOP);
  const withMacd = board.filter((s) => macdOf(s));
  const above = withMacd.filter((s) => macdAbove(macdOf(s))).length;

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

  const whens = MACD_WHENS.map((w) => ({
    ...w,
    label: `${w.label} ${macdPick(withMacd, side, w.value).length}`,
  }));
  const hits = macdPick(withMacd, side, when);
  const forecast = when === 'd1' || when === 'd2';
  const title = forecast
    ? `${when === 'd1' ? '明天' : '後天'}可能${name}`
    : `近 ${when} 日${name}`;

  view.innerHTML = `
    <div class="controls">${pills('macdside', MACD_SIDES, side)}</div>
    <div class="controls">${pills('macdwhen', whens, when)}</div>
    <div class="card"><div class="stat-grid">
      <div class="stat"><b class="${side === 'up' ? 'up' : 'down'}">${hits.length}</b><span>${title}</span></div>
      <div class="stat"><b class="up">${above}</b><span>柱在零軸上</span></div>
      <div class="stat"><b class="down">${withMacd.length - above}</b><span>柱在零軸下</span></div>
      <div class="stat"><b>${board.length - withMacd.length}</b><span>資料不足</span></div>
    </div></div>
    ${listCard(`${state.date} ${title}`,
      forecast
        ? `榜上前 ${TOP} 名　${when === 'd2' ? '明天以平盤計　' : ''}要走的幅度小的排前面`
        : `榜上前 ${TOP} 名　交叉越新的排越前面`,
      hits.map((s) => macdRow(s, baseMap.get(s.code), side, when)),
      forecast
        ? `${state.date} 榜上沒有一檔在漲跌停範圍內${when === 'd1' ? '明天' : '後天'}就會${name}的`
        : `${state.date} 榜上沒有近 ${when} 日${name}的股票，把天數放寬看看`)}
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
      <p class="note">每一列的 ${MA_WINDOWS.join('／')} 標記是四條均線的位置，拿來對照用（▲ 收在線上、▼ 收在線下）。
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
      <h2>成交值排名走勢 <small>斷線＝當日未進前 300</small></h2>
      <div class="chart-box"><canvas id="c-rank"></canvas></div>
    </section>
    <section class="card">
      <h2>成交值走勢 <small>億元</small></h2>
      <div class="chart-box"><canvas id="c-value"></canvas></div>
    </section>`;

  try {
    const Chart = await loadChartJs();
    drawLine(Chart, $('#c-rank'), labels, [{ data: ranks, color: LINE.rank, label: '名次' }], { reverse: true });
    drawLine(Chart, $('#c-value'), labels, [{ data: values, color: LINE.top10, label: '成交值(億)' }]);
  } catch (err) {
    document.querySelectorAll('.chart-box').forEach((box) => {
      box.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
    });
  }
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
    <section class="card">
      <h2>榜上資金總量 <small>${state.date}${baseDate ? ` vs ${baseDate}` : ''}</small></h2>
      <div class="stat-grid">
        <div class="stat"><b class="sm">${okuText(totalValue)}</b><span>前 ${TOP} 大成交值</span></div>
        <div class="stat"><b class="sm ${trend(totalFlowPct)}">${signedPct(totalFlowPct)}</b><span>整體增減</span></div>
        <div class="stat"><b class="sm ${trend(marketChg)}">${signedPct(marketChg, 2)}</b><span>成交值加權漲跌</span></div>
        <div class="stat"><b class="sm"><span class="up">${inflow}</span> / <span class="down">${outflow}</span></b><span>流入 / 流出族群</span></div>
      </div>
      <p class="note">整體增減是大盤的縮放，會讓所有族群一起變大或變小。
        要看「錢從哪一族轉到哪一族」，用抽掉大盤縮放的<b>佔比位移（pp）</b>。</p>
    </section>
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
    </section>
    <section class="card">
      <h2>一句話 <small>${state.date} 前 ${TOP} 大</small></h2>
      <div class="stat-grid">
        <div class="stat"><b class="sm ${trend(totalFlowPct)}">${signedPct(totalFlowPct)}</b><span>榜上整體增減</span></div>
        <div class="stat"><b class="sm ${trend(marketChg)}">${signedPct(marketChg, 2)}</b><span>成交值加權漲跌</span></div>
        <div class="stat"><b class="sm ${trend(top.flow)}">${esc(top.name)}</b>
          <span>${top.flow > 0 ? '流入最多 +' : '減少最少 '}${okuText(top.flow)}</span></div>
        <div class="stat"><b class="sm ${trend(bottom.flow)}">${esc(bottom.name)}</b>
          <span>${bottom.flow < 0 ? '流出最多 ' : '增加最少 +'}${okuText(bottom.flow)}</span></div>
      </div>
      <p class="note">${groupingNote(mode, topStocks.length, ungrouped)}
        要看每一族的細項與成分股，切到「族群」分頁。</p>
    </section>`;

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
    <section class="card">
      <h2>${state.date} 市場概況 <small>${scopeLabel()}</small></h2>
      <div class="stat-grid">
        <div class="stat"><b>${num(ser.marketValues[at], 0)}</b><span>${scopeLabel()}成交值（億）</span></div>
        <div class="stat"><b class="${trend(dod)}">${signed(dod)}</b><span>對比前一日</span></div>
        <div class="stat"><b>${num(share(ser.top200Values[at]))}%</b><span>前 200 大佔比</span></div>
        <div class="stat"><b>${num(share(ser.top10Values[at]))}%</b><span>前 10 大佔比</span></div>
      </div>
      <p class="note">成交值是本站追蹤範圍（普通股與 ETF，已排除權證等商品）的合計，
        與交易所公布的市場總成交值會有小幅差異。</p>
    </section>
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
    else if (route.view === 'stock') await renderStock(view, route.arg);
    else if (route.view === 'compare') await renderCompare(view, route.params);
    else await renderRank(view);
    paintChrome();
  } catch (err) {
    view.innerHTML = failBox(`載入失敗：${err.message}`,
      `前端版本 ${APP_VERSION}。若清除快取後仍然一樣，就不是快取的問題。`);
  }
}

function bindGlobalControls() {
  $('#date-select').addEventListener('change', (e) => {
    state.date = e.target.value;
    render();
  });

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
    if (pill.dataset.macdside) state.macdSide = pill.dataset.macdside;
    if (pill.dataset.macdwhen) state.macdWhen = pill.dataset.macdwhen;
    if (pill.dataset.sectorsort) state.sectorSort = pill.dataset.sectorsort;
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
