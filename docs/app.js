'use strict';

const DATA = 'data';
const TOP = 200;                       // 排行榜與進出榜的門檻
const CHART_CDN = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js';

const state = {
  index: null,
  date: null,          // 目前選定的交易日
  baseline: 1,         // 比較基準：往前 N 個交易日
  span: 120,           // 個股走勢顯示的交易日數
  query: '',           // 排行榜搜尋字串
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

/** 由目前日期往前推 n 個交易日，超出範圍回傳 null */
function dateBack(n, from = state.date) {
  const i = state.index.dates.indexOf(from);
  return i - n >= 0 ? state.index.dates[i - n] : null;
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

function stockRow(stock, base) {
  const prev = base ? base.rank : null;
  const pct = stock.changePct;
  const pctText = pct === null || pct === undefined ? '' : `<em class="${trend(pct)}">${pct > 0 ? '+' : ''}${pct.toFixed(2)}%</em>`;
  const streak = streakLabel(stock, true);
  return `<a class="row" href="#/stock/${stock.code}">
    <div class="rank"><span class="no">${stock.rank}</span>${deltaBadge(stock.rank, prev)}</div>
    <div class="ident"><span class="name">${esc(stock.name)}</span>
      <span class="code">${stock.code}</span>
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

  view.innerHTML = `
    <div class="controls">
      <input type="search" id="q" placeholder="搜尋代號或名稱" value="${esc(state.query)}">
      ${pills('baseline', BASELINES, state.baseline)}
    </div>
    <section class="card">
      <h2>成交值前 ${TOP} 大 <small>${baseDate ? `名次變化 vs ${baseDate}` : '無比較基準'}</small></h2>
      <div id="rank-list"></div>
    </section>`;

  const paint = () => {
    const q = state.query.trim().toLowerCase();
    const rows = top
      .filter((s) => !q || s.code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
      .map((s) => stockRow(s, baseMap.get(s.code)));
    $('#rank-list').innerHTML = rows.length ? rows.join('') : '<p class="hint">找不到符合的股票</p>';
  };
  paint();

  $('#q').addEventListener('input', (e) => {
    state.query = e.target.value;
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

function drawLine(Chart, canvas, labels, data, { reverse = false, color = '#2f6fed', label = '' }) {
  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{ label, data, borderColor: color, backgroundColor: `${color}22`, borderWidth: 2, pointRadius: 0, tension: 0.2, spanGaps: false, fill: true }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${label}：${c.parsed.y ?? '未進榜'}` } } },
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

  view.innerHTML = `
    <div class="controls">
      ${pills('span', [{ value: 60, label: '60 日' }, { value: 120, label: '120 日' }, { value: 9999, label: '全部' }], state.span)}
    </div>
    <section class="card">
      <h2>${esc(name)} <small>${code}</small></h2>
      <div class="stat-grid">
        <div class="stat"><b>${latest ? latest.rank : '—'}</b><span>${state.date} 名次</span></div>
        <div class="stat"><b>${latest ? fmtOku(latest.value) : '—'}</b><span>成交值</span></div>
        <div class="stat"><b>${best ?? '—'}</b><span>期間最佳</span></div>
        <div class="stat"><b>${inTop}/${labels.length}</b><span>進前 ${TOP} 天數</span></div>
        <div class="stat"><b>${streak ?? '—'}</b><span>連續進前 ${TOP}</span></div>
        <div class="stat"><b class="sm">${todayEntry?.since ?? '—'}</b><span>連續起算日</span></div>
      </div>
      ${todayEntry && todayEntry.since === state.index.dates[0]
        ? `<p class="note">這段連續進榜從本站最早一天（${state.index.dates[0]}）就開始了，實際天數可能更長。</p>`
        : ''}
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
    drawLine(Chart, $('#c-rank'), labels, ranks, { reverse: true, color: '#2f6fed', label: '名次' });
    drawLine(Chart, $('#c-value'), labels, values, { color: '#d92d20', label: '成交值(億)' });
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
}

async function render() {
  const route = parseHash();
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === route.view));
  destroyCharts();
  const view = $('#view');
  view.innerHTML = '<p class="hint">載入中…</p>';
  try {
    if (route.view === 'streak') await renderStreak(view);
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
  state.date = state.index.latest;
  bindGlobalControls();
  await render();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

start();
