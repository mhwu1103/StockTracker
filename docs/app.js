'use strict';

const DATA = 'data';
const TOP = 200;                       // 排行榜與進出榜的門檻
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
 * 每一塊都先把名字與金額寫進去，塞不塞得下等畫出來以後量了再說（fitTiles）。
 */
function treemap(groups) {
  const items = groups
    .filter((g) => g.value > 0)
    .map((g) => ({ ...g, value: g.value }))
    .sort((a, b) => b.value - a.value);
  if (!items.length) return '<p class="hint">這一天沒有資料。</p>';

  const tiles = squarify(items, { x: 0, y: 0, w: 100, h: 100 });
  return `<div class="treemap">${tiles.map((t) => {
    const cls = t.flow === null ? 'flat' : trend(t.flow);
    // 增減幅度對到 0.12～0.68 的底色濃度；60% 以上一律最濃
    const ink = t.flowPct === null ? 0.1 : 0.12 + Math.min(1, Math.abs(t.flowPct) / 60) * 0.56;
    const amount = t.flow === null ? 'NEW' : `${t.flow > 0 ? '+' : ''}${okuText(t.flow)}`;
    return `<div class="tile ${cls}" style="left:${t.x.toFixed(2)}%;top:${t.y.toFixed(2)}%;
        width:${t.w.toFixed(2)}%;height:${t.h.toFixed(2)}%;--ink:${ink.toFixed(2)}"
        title="${esc(t.name)}｜${okuText(t.value)}｜${amount}">
      <b>${esc(t.name)}</b><span>${amount}</span>
    </div>`;
  }).join('')}</div>`;
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
    // 夠高就讓名字折兩行。「功率元件 · 第三代半導體」這種長名字擠成一行一定會被切，
    // 折成兩行反而放得下比較大的字——樹狀圖本來就是這樣處理的。
    const wrap = height >= 42;
    el.classList.toggle('wrap', wrap);
    el.classList.toggle('no-text', width < 34 || height < 18);
    // 名字被切成「軍工 · 航太…」還讀得懂，金額被切成「+120…」卻會被誤讀成別的數字，
    // 所以金額只有在最小字級也塞得下時才顯示，塞不下就整個不出現。
    const numEm = emWidth(num.textContent);
    el.classList.toggle('no-num', height < 32 || (width - TILE_PAD) / numEm < 9);

    const nameEm = emWidth(name.textContent) / (wrap ? 2 : 1);
    el.style.setProperty('--name-size', `${fitFont(width, height, nameEm, 13, wrap ? 4.6 : 3.4)}px`);
    el.style.setProperty('--num-size', `${fitFont(width, height, numEm, 11, 3.4)}px`);
  });
}

/**
 * 粗估一串字佔幾個「字寬」。中日韓字元算一個，英數與半形符號約 0.55 個——
 * 「-244 億」全照中文字寬算會比實際寬一倍，窄格子上的金額就會被誤判成放不下。
 */
const TILE_PAD = 12;      // .tile 的左右內距 5px 加上外框 1px，兩邊共 12px

function emWidth(text) {
  let em = 0;
  for (const ch of text) em += /[　-〿㐀-鿿＀-￯]/.test(ch) ? 1 : 0.55;
  return em || 1;
}

/**
 * 讓 em 個字寬剛好塞得進 width 的字級，再受格子高度與 9～max 的上下限節制。
 * rows 是高度要分給幾「份」（名字一行還是兩行，加上金額那行與行距）。
 *
 * 寧可字小一點，也不要「光通訊 · CPO · 矽光子」被切成「光通訊 · CPO · 矽…」。
 * 真的連 9px 都塞不下時就讓它 ellipsis，完整名稱在 title 裡。
 */
function fitFont(width, height, em, max, rows) {
  const byWidth = (width - TILE_PAD) / em;
  const byHeight = height / rows;
  return Math.max(9, Math.min(max, Math.floor(Math.min(byWidth, byHeight))));
}

/**
 * 盯著地圖的大小重新量字。
 *
 * 用 ResizeObserver 而不是 window 的 resize：地圖變大變小不只在改視窗寬度時發生
 * （分頁切換、面板收合、字體縮放都會），而且 observe() 一掛上就會先送一次，
 * 初次量測與後續變化用同一條路徑，不會有「量到 0 寬之後就再也沒重量」的狀況。
 */
let tileObserver = null;

function watchTiles(view) {
  if (tileObserver) tileObserver.disconnect();     // 上一次 render 的觀察對象已經不在了
  const map = $('.treemap', view);
  if (!map) return;
  // 先自己量一次：背景分頁不會跑 ResizeObserver（連 rAF 都不跑），
  // 但 getBoundingClientRect() 照樣算得出來，切回來時才不會是一片沒有字的方塊。
  fitTiles(view);
  if (!window.ResizeObserver) return;
  tileObserver = new ResizeObserver(() => fitTiles(view));
  tileObserver.observe(map);
}

// 四象限圖的畫布。viewBox 的單位刻意接近手機的實際像素，
// 這樣字級寫 10 在手機上就是 10px，放到寬螢幕才等比放大。
const Q = { w: 360, h: 300, l: 30, r: 14, t: 14, b: 30, name: 10 };  // name 是 .q-name 的字級

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
 * 量價四象限。橫軸是成交值增減（量），縱軸是成交值加權漲跌（價），
 * 泡泡大小是成交值，顏色是佔比位移——四個維度都是同一天的同一批數字。
 */
function quadrant(groups) {
  const pts = groups.filter((g) => g.flowPct !== null && g.chg !== null && g.value > 0);
  if (pts.length < 2) return '<p class="hint">可比較的族群太少，畫不出四象限。</p>';

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

  // 只有大的才標名字，不然字疊字反而讀不出來
  const named = new Set(pts.slice().sort((a, b) => b.value - a.value).slice(0, 6).map((p) => p.name));

  /**
   * 標籤佔位。泡泡是照成交值由大到小畫的，所以先搶先贏＝大的族群優先標名字；
   * 會疊到已經放好的標籤就乾脆不標——兩個名字疊在一起等於兩個都讀不到。
   */
  const placed = [];
  const claim = (x, y, text) => {
    const half = (emWidth(text) * Q.name) / 2;
    const box = { x1: x - half, x2: x + half, y1: y - Q.name, y2: y + 3 };
    if (placed.some((p) => box.x1 < p.x2 && box.x2 > p.x1 && box.y1 < p.y2 && box.y2 > p.y1)) return false;
    placed.push(box);
    return true;
  };
  const corners = [
    { x: Q.w - Q.r - 3, y: Q.t + 11, anchor: 'end', text: '量增價漲 · 資金進駐' },
    { x: Q.l + 3, y: Q.t + 11, anchor: 'start', text: '量縮價漲 · 惜售' },
    { x: Q.w - Q.r - 3, y: Q.h - Q.b - 4, anchor: 'end', text: '量增價跌 · 出貨' },
    { x: Q.l + 3, y: Q.h - Q.b - 4, anchor: 'start', text: '量縮價跌 · 棄守' },
  ];

  const dots = pts.slice().sort((a, b) => b.value - a.value).map((p) => {
    const r = 3 + Math.sqrt(p.value / maxV) * 13;
    const x = px(p.flowPct);
    const y = py(p.chg);
    const cls = p.shift === null ? 'flat' : trend(p.shift);
    // 名字寫在泡泡正上方；貼著邊的往內縮，才不會被畫布切掉。
    // 太靠上的改寫在下方，否則會壓到象限名稱。
    const lx = Math.max(Q.l + 22, Math.min(Q.w - Q.r - 22, x));
    const ly = y > Q.t + innerH * 0.22 ? y - r - 3 : y + r + 9;
    const label = named.has(p.name) && claim(lx, ly, p.name)
      ? `<text class="q-name" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}"
           text-anchor="middle">${esc(p.name)}</text>`
      : '';
    const shiftText = p.shift === null ? '—' : `${p.shift > 0 ? '+' : ''}${p.shift.toFixed(2)}pp`;
    return `<g class="q-dot ${cls}"><title>${esc(p.name)}｜成交值 ${signedPct(p.flowPct)}｜`
      + `加權 ${signedPct(p.chg, 2)}｜佔比 ${shiftText}</title>`
      + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}"/>${label}</g>`;
  }).join('');

  return `<svg class="quad" viewBox="0 0 ${Q.w} ${Q.h}" role="img" aria-label="量價四象限散佈圖">
    <rect class="q-plot" x="${Q.l}" y="${Q.t}" width="${innerW}" height="${innerH}" rx="6"/>
    ${corners.map((c) => `<text class="q-corner" x="${c.x}" y="${c.y}" text-anchor="${c.anchor}">${c.text}</text>`).join('')}
    <line class="q-axis" x1="${Q.l}" y1="${cy}" x2="${Q.w - Q.r}" y2="${cy}"/>
    <line class="q-axis" x1="${cx}" y1="${Q.t}" x2="${cx}" y2="${Q.h - Q.b}"/>
    ${dots}
    <text class="q-tick" x="${Q.w - Q.r}" y="${Q.h - Q.b + 12}" text-anchor="end">成交值 +${maxX.toFixed(0)}%</text>
    <text class="q-tick" x="${Q.l}" y="${Q.h - Q.b + 12}" text-anchor="start">−${maxX.toFixed(0)}%</text>
    <text class="q-tick" x="${Q.l - 4}" y="${Q.t + 8}" text-anchor="end">+${maxY.toFixed(1)}%</text>
    <text class="q-tick" x="${Q.l - 4}" y="${Q.h - Q.b}" text-anchor="end">−${maxY.toFixed(1)}%</text>
    <text class="q-tick" x="${Q.w / 2}" y="${Q.h - 4}" text-anchor="middle">橫軸：成交值增減　縱軸：成交值加權漲跌</text>
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
      <div class="map-box">${quadrant(groups)}</div>
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

  watchTiles(view);
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
