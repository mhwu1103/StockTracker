'use strict';

const DATA = 'data';
const TOP = 200;                       // 排行榜與進出榜的門檻
const CHART_CDN = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js';

// 圖表線色。Chart.js 吃不到 CSS 變數，只能寫死；深淺色模式都看得清楚的中間色調。
const LINE = { rank: '#2f6fed', market: '#2f6fed', top200: '#7b61ff', top10: '#d92d20' };

const TAIPEI_OFFSET_MIN = 8 * 60;
// 最新資料距今超過這麼多個日曆日就提示。週五收盤後到週一盤中最多差 3 天，
// 取 4 是為了讓正常的週末不會誤報 —— 寧可晚一天提醒，也不要天天狼來了。
const STALE_DAYS = 4;

const state = {
  index: null,
  date: null,          // 目前選定的交易日
  baseline: 1,         // 比較基準：往前 N 個交易日
  span: 120,           // 個股走勢顯示的交易日數
  query: '',           // 排行榜搜尋字串
  industry: {},        // code -> 產業中文名（industry.json，抓不到時為空）
  sector: '',          // 排行榜的產業篩選；'' 代表全部
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
// 資料存取
// --------------------------------------------------------------------------
function getJSON(path, opts) {
  return fetch(path, opts).then((res) => {
    if (!res.ok) throw new Error(`${path} (${res.status})`);
    return res.json();
  });
}

function loadDaily(date) {
  if (!date) return Promise.resolve(null);
  if (!state.daily.has(date)) state.daily.set(date, getJSON(`${DATA}/daily/${date}.json`));
  return state.daily.get(date);
}

function loadHistory(year) {
  if (!state.history.has(year)) state.history.set(year, getJSON(`${DATA}/history/${year}.json`));
  return state.history.get(year);
}

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

/** 把一份股票清單依產業彙總成 [{ name, count, value }]，成交值由大到小。 */
function bySector(stocks) {
  const acc = new Map();
  for (const s of stocks) {
    const name = industryOf(s.code);
    const cur = acc.get(name) || { name, count: 0, value: 0 };
    cur.count += 1;
    cur.value += s.value;
    acc.set(name, cur);
  }
  return [...acc.values()].sort((a, b) => b.value - a.value);
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

const hasIndustry = () => Object.keys(state.industry).length > 0;

function stockRow(stock, base) {
  const prev = base ? base.rank : null;
  const pct = stock.changePct;
  const pctText = pct === null || pct === undefined ? '' : `<em class="${trend(pct)}">${pct > 0 ? '+' : ''}${pct.toFixed(2)}%</em>`;
  const streak = streakLabel(stock, true);
  return `<a class="row" href="#/stock/${stock.code}">
    <div class="rank"><span class="no">${stock.rank}</span>${deltaBadge(stock.rank, prev)}</div>
    <div class="ident"><span class="name">${esc(stock.name)}</span>
      <span class="code">${stock.code}${hasIndustry() ? ` · ${esc(industryOf(stock.code))}` : ''}</span>
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

const BASELINES = [
  { value: 1, label: '對比前一日' },
  { value: 5, label: '對比 5 日前' },
  { value: 20, label: '對比 20 日前' },
];

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
  const sectorSelect = sectors.length
    ? `<select id="sector-pick" aria-label="產業篩選">
        <option value="">全部產業</option>
        <option value="!ETF" ${state.sector === '!ETF' ? 'selected' : ''}>排除 ETF</option>
        ${sectors.map((n) => `<option value="${esc(n)}" ${n === state.sector ? 'selected' : ''}>${esc(n)}</option>`).join('')}
      </select>`
    : '';

  view.innerHTML = `
    <div class="controls">
      <input type="search" id="q" placeholder="搜尋代號或名稱" value="${esc(state.query)}">
      ${sectorSelect}
      ${pills('baseline', BASELINES, state.baseline)}
    </div>
    <section class="card">
      <h2>成交值前 ${TOP} 大 <small>${baseDate ? `名次變化 vs ${baseDate}` : '無比較基準'}</small></h2>
      <div id="rank-list"></div>
    </section>`;

  const matchSector = (s) => {
    if (!state.sector) return true;
    if (state.sector === '!ETF') return industryOf(s.code) !== ETF_LABEL;
    return industryOf(s.code) === state.sector;
  };

  const paint = () => {
    const q = state.query.trim().toLowerCase();
    const rows = top
      .filter(matchSector)
      .filter((s) => !q || s.code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
      .map((s) => stockRow(s, baseMap.get(s.code)));
    $('#rank-list').innerHTML = rows.length ? rows.join('') : '<p class="hint">找不到符合的股票</p>';
  };
  paint();

  $('#q').addEventListener('input', (e) => {
    state.query = e.target.value;
    paint();
  });

  if (sectorSelect) {
    $('#sector-pick').addEventListener('change', (e) => {
      state.sector = e.target.value;
      paint();
    });
  }
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

  view.innerHTML = `
    <div class="controls">
      ${pills('span', SPANS, state.span)}
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
// 分頁六：族群（依產業看資金流向）
// --------------------------------------------------------------------------
function sectorRow(cur, base, totalValue) {
  const share = totalValue ? (cur.value / totalValue) * 100 : 0;
  const delta = base && base.value ? ((cur.value - base.value) / base.value) * 100 : null;
  const deltaText = delta === null
    ? '<em class="flat">NEW</em>'
    : `<em class="${trend(delta)}">${delta > 0 ? '+' : ''}${delta.toFixed(1)}%</em>`;
  const countDelta = base ? cur.count - base.count : null;

  return `<details class="sector">
    <summary class="row">
      <div class="rank"><span class="no">${cur.count}</span>
        <span class="delta ${trend(countDelta)}">${countDelta ? `${countDelta > 0 ? '+' : ''}${countDelta} 檔` : '檔'}</span></div>
      <div class="ident"><span class="name">${esc(cur.name)}</span>
        <span class="code">佔榜上成交值 ${num(share)}%</span></div>
      <div class="figures"><span class="value">${fmtValue(cur.value)}</span>
        <span class="price">${deltaText}</span></div>
    </summary>
    <div class="sector__body" data-sector="${esc(cur.name)}"></div>
  </details>`;
}

async function renderSector(view) {
  if (!hasIndustry()) {
    view.innerHTML = '<p class="hint">沒有產業對照資料，請先執行 scripts/fetch_industry.py。</p>';
    return;
  }

  const baseDate = dateBack(state.baseline);
  const [today, base] = await Promise.all([loadDaily(state.date), loadDaily(baseDate)]);
  const topStocks = today.stocks.filter((s) => s.rank <= TOP);
  const groups = bySector(topStocks);
  const baseGroups = new Map(
    base ? bySector(base.stocks.filter((s) => s.rank <= TOP)).map((g) => [g.name, g]) : []
  );
  const totalValue = groups.reduce((sum, g) => sum + g.value, 0);

  view.innerHTML = `
    <div class="controls">${pills('baseline', BASELINES, state.baseline)}</div>
    <section class="card">
      <h2>產業分布 <small>${state.date} 前 ${TOP} 大${baseDate ? ` · 成交值變化 vs ${baseDate}` : ''}</small></h2>
      ${groups.map((g) => sectorRow(g, baseGroups.get(g.name), totalValue)).join('')}
      <p class="note">點一列可以展開該產業當日在榜的個股。
        產業別採證交所的官方分類，與市場口中的題材族群（AI 伺服器、重電等）不一定對得起來；
        分類取自最新一次抓取的結果，並回頭套用到歷史日期。</p>
    </section>`;

  // 展開時才填內容，200 檔一次全渲染沒必要
  const rowsOf = (name) => topStocks
    .filter((s) => industryOf(s.code) === name)
    .map((s) => stockRow(s, rankMap(base).get(s.code)))
    .join('');
  view.querySelectorAll('details.sector').forEach((el) => {
    el.addEventListener('toggle', () => {
      const box = $('.sector__body', el);
      if (el.open && !box.innerHTML) box.innerHTML = rowsOf(box.dataset.sector);
    });
  });
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
  if (!idx.top200Values) {
    view.innerHTML = '<p class="hint">index.json 沒有集中度欄位，請重新執行 scripts/build_history.py。</p>';
    return;
  }

  const at = idx.dates.indexOf(state.date);          // 目前選定日在全序列中的位置
  const from = Math.max(0, at + 1 - state.span);
  const labels = idx.dates.slice(from, at + 1);
  const cut = (arr) => arr.slice(from, at + 1);

  const market = cut(idx.marketValues);
  const top200 = cut(idx.top200Values);
  const top10 = cut(idx.top10Values);

  const dod = at > 0 && idx.marketValues[at - 1]
    ? ((idx.marketValues[at] - idx.marketValues[at - 1]) / idx.marketValues[at - 1]) * 100
    : null;
  const share = (v) => (idx.marketValues[at] ? (v / idx.marketValues[at]) * 100 : null);

  view.innerHTML = `
    <div class="controls">${pills('span', SPANS, state.span)}</div>
    <section class="card">
      <h2>${state.date} 市場概況</h2>
      <div class="stat-grid">
        <div class="stat"><b>${num(idx.marketValues[at], 0)}</b><span>大盤成交值（億）</span></div>
        <div class="stat"><b class="${trend(dod)}">${signed(dod)}</b><span>對比前一日</span></div>
        <div class="stat"><b>${num(share(idx.top200Values[at]))}%</b><span>前 200 大佔比</span></div>
        <div class="stat"><b>${num(share(idx.top10Values[at]))}%</b><span>前 10 大佔比</span></div>
      </div>
      <p class="note">這裡的大盤成交值是本站追蹤範圍（上市普通股與 ETF，已排除權證等商品）的合計，
        與證交所公布的市場總成交值會有小幅差異。</p>
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
      { data: market, color: LINE.market, label: '大盤' },
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

  const i = idx.dates.indexOf(state.date);
  const market = idx.marketValues[i];
  $('#meta').textContent =
    `大盤成交值 ${num(market, 0)} 億 · 共 ${idx.dates.length} 個交易日（${idx.dates[0]} 起）· 更新 ${idx.updated.slice(0, 16).replace('T', ' ')}`;

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
    if (route.view === 'market') await renderMarket(view);
    else if (route.view === 'sector') await renderSector(view);
    else if (route.view === 'streak') await renderStreak(view);
    else if (route.view === 'moves') await renderMoves(view);
    else if (route.view === 'stock') await renderStock(view, route.arg);
    else if (route.view === 'compare') await renderCompare(view, route.params);
    else await renderRank(view);
    paintChrome();
  } catch (err) {
    view.innerHTML = `<p class="hint">載入失敗：${esc(err.message)}</p>`;
  }
}

function bindGlobalControls() {
  $('#date-select').addEventListener('change', (e) => {
    state.date = e.target.value;
    render();
  });

  // pill 按鈕以事件委派處理，畫面重繪後不必重新綁定
  $('#view').addEventListener('click', (e) => {
    const pill = e.target.closest('.pill');
    if (!pill) return;
    if (pill.dataset.baseline) state.baseline = Number(pill.dataset.baseline);
    if (pill.dataset.span) state.span = Number(pill.dataset.span);
    if (pill.dataset.streak) state.streakDays = Number(pill.dataset.streak);
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
  // 產業別是選配：抓不到就整站當作沒有產業資訊，不影響其他分頁。
  try {
    const ind = await getJSON(`${DATA}/industry.json`);
    state.industry = ind.map || {};
  } catch (err) {
    state.industry = {};
  }

  state.date = state.index.latest;
  bindGlobalControls();
  await render();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

start();
