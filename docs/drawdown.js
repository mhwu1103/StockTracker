/*
 * 跌深（drawdown.html）：一段期間內每一檔股票從高點跌下來有多深。
 *
 *   最大回落   期間內先出現的高點，到它之後最低的那一天跌了多少——高點買進、抱到最低最慘賠多少
 *   距高點     結束日離期間最高點多遠（中間反彈過的，在這裡會比最大回落淺）
 *   還在破底   期間最低點就落在結束日前幾個交易日：還沒止跌的
 *
 * 期間可以選（預設今年 1 月第一個交易日 ～ 最新一天），所以這一頁自己算：scripts/build_drawdown.py
 * 只存每一檔的還原收盤（data/drawdown/<年>.json，對數報酬壓縮），這裡依選的期間載入需要的年份。
 *
 * 搜尋（代號開頭或名稱）不管市場、流動性、產業與「還在破底」的篩選，直接在全部股票裡找；名次是
 * 在這個分頁全市場的名次，搜到的才知道它排第幾。
 */

const DATA = 'data';
const TABS = [
  { value: 'dd', label: '最大回落' },
  { value: 'cur', label: '距高點' },
  { value: 'low', label: '還在破底' },
];
const MARKETS = [
  { value: 'all', label: '全部' }, { value: '上市', label: '上市' }, { value: '上櫃', label: '上櫃' },
];
const LIQS = [
  { value: 'all', label: '全部' }, { value: 'liq', label: '成交熱門' },
];
// 快選期間：ytd 是結束日那一年的第一個交易日起；數字是往回幾個交易日
const RANGES = [
  { value: 'ytd', label: '今年' }, { value: '21', label: '近 1 月' }, { value: '63', label: '近 3 月' },
  { value: '126', label: '近半年' }, { value: '250', label: '近 1 年' },
];
const PAGE = 50;
const KEY = 'stocktracker.drawdown';

const state = {
  data: null, years: {}, rows: [], res: null,
  start: '', end: '', range: 'ytd',
  tab: 'dd', mk: 'all', liq: 'all', ind: '', q: '', more: 1,
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (v, digits = 1) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const t = Number(v).toFixed(digits);
  return Number(t) === 0 ? `${(0).toFixed(digits)}%` : `${v > 0 ? '+' : ''}${t}%`;
};
const dir = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const md = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '');
const ymd = (d) => (d ? `${d.slice(0, 4)}/${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '');
const px = (x) => (x < 100 ? Math.round(x * 100) / 100 : x < 1000 ? Math.round(x * 10) / 10 : Math.round(x));
const num = (v) => (v === null || v === undefined ? '—' : Number(px(v)).toLocaleString('zh-TW', { maximumFractionDigits: 2 }));
const r1 = (x) => Math.round(x * 1000) / 10;

function pills(name, options, current) {
  return `<div class="pills">${options
    .map((o) => `<button class="pill ${o.value === current ? 'active' : ''}" data-${name}="${o.value}">${esc(o.label)}</button>`)
    .join('')}</div>`;
}

// ---------------------------------------------------------------- 資料
async function getJson(path) {
  const res = await fetch(`${DATA}/${path}`);
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

/** 載入並解碼一年：{dates, px: {代號: {s, e, v: Float64Array（今天的基準）}}} */
async function loadYear(y) {
  if (state.years[y]) return state.years[y];
  const raw = await getJson(`drawdown/${y}.json`);
  const unit = state.data.unit;
  const sc = state.data.scale[y] || {};
  const out = {};
  for (const [c, a] of Object.entries(raw.s)) {
    const [s, e, p0] = a;
    const v = new Float64Array(e - s + 1);
    let acc = Math.log(p0);
    const f = sc[c] || 1;
    v[0] = p0 * f;
    for (let i = 1; i < v.length; i += 1) {
      acc += a[i + 2] / unit;
      v[i] = Math.exp(acc) * f;
    }
    out[c] = { s, e, v };
  }
  state.years[y] = { dates: raw.dates, px: out };
  return state.years[y];
}

/** 從 dates（全部交易日）裡找 ≥ d 的第一天（after）或 ≤ d 的最後一天 */
function snap(dates, d, after) {
  if (after) return dates.find((x) => x >= d) || dates[dates.length - 1];
  for (let i = dates.length - 1; i >= 0; i -= 1) if (dates[i] <= d) return dates[i];
  return dates[0];
}

function maxDrawdown(v) {
  let run = -Infinity; let runAt = 0; let best = 0; let hi = 0; let lo = 0;
  for (let i = 0; i < v.length; i += 1) {
    if (v[i] > run) { run = v[i]; runAt = i; }
    const dd = v[i] / run - 1;
    if (dd < best) { best = dd; hi = runAt; lo = i; }
  }
  return { dd: best, hi, lo };
}

/** 算 state.start ～ state.end 的每一檔 */
async function compute() {
  const d = state.data;
  const ys = d.years.filter((y) => y >= state.start.slice(0, 4) && y <= state.end.slice(0, 4));
  const loaded = await Promise.all(ys.map(loadYear));
  // 期間涵蓋的年份串起來的交易日，與每一年在這串裡的起點
  const dates = [];
  const offs = [];
  for (const Y of loaded) {
    offs.push(dates.length);
    dates.push(...Y.dates);
  }
  const i0 = dates.findIndex((x) => x >= state.start);
  let i1 = dates.length - 1;
  while (i1 > 0 && dates[i1] > state.end) i1 -= 1;
  const n = i1 - i0 + 1;
  const lowFrom = Math.max(0, n - d.newLow);
  const rows = [];
  for (const [c, m] of Object.entries(d.meta)) {
    // 串起這一檔在期間內的價格；first／lastReal 是期間內第一筆、最後一筆真的有成交的位置
    const v = new Float64Array(n).fill(NaN);
    let first = -1; let lastReal = -1;
    loaded.forEach((Y, k) => {
      const p = Y.px[c];
      if (!p) return;
      for (let j = p.s; j <= p.e; j += 1) {
        const g = offs[k] + j - i0;
        if (g < 0 || g >= n) continue;
        v[g] = p.v[j - p.s];
        if (first < 0) first = g;
        lastReal = g;
      }
    });
    if (first < 0 || first >= d.lateStart || n - 1 - lastReal > d.stale) continue;
    for (let g = first + 1; g < n; g += 1) if (!Number.isFinite(v[g])) v[g] = v[g - 1];
    const w = v.subarray(first);
    const { dd, hi, lo } = maxDrawdown(w);
    let pk = 0;
    for (let i = 1; i < w.length; i += 1) if (w[i] > w[pk]) pk = i;
    const L = w.length - 1;
    const at = (i) => dates[i0 + first + i];
    rows.push({
      c, n: m[0], ind: m[1], mk: m[2], liq: m[3],
      hd: at(hi), hp: w[hi], ld: at(lo), lp: w[lo], dd: r1(dd),
      pd: at(pk), pp: w[pk], cl: w[L],
      cur: r1(w[L] / w[pk] - 1), reb: r1(w[L] / w[lo] - 1), ret: r1(w[L] / w[0] - 1),
      low: first + lo >= lowFrom,
    });
  }
  // 加權指數同一段期間
  const T = d.taiex;
  const ti = T.d.map((x, i) => [x, T.c[i]]).filter(([x]) => x >= dates[i0] && x <= dates[i1]);
  let taiex = null;
  if (ti.length) {
    const tv = ti.map(([, x]) => x);
    const { dd, hi, lo } = maxDrawdown(tv);
    let pk = 0;
    tv.forEach((x, i) => { if (x > tv[pk]) pk = i; });
    taiex = { dd: r1(dd), hd: ti[hi][0], ld: ti[lo][0], pd: ti[pk][0],
      cur: r1(tv[tv.length - 1] / tv[pk] - 1), ret: r1(tv[tv.length - 1] / tv[0] - 1) };
  }
  const cnt = (x) => rows.filter((r) => r.dd <= x).length;
  state.rows = rows;
  state.res = { from: dates[i0], to: dates[i1], days: n, lowSince: dates[i0 + lowFrom], all: rows.length, taiex,
    d30: cnt(-30), d50: cnt(-50), d70: cnt(-70) };
}

/** 全部交易日。年份檔要載入才知道日期，快選與對齊日期改用加權指數的日期——同一份交易日曆 */
const tradingDays = () => state.data.taiex.d;

function applyRange(r) {
  const days = tradingDays();
  const end = state.end;
  if (r === 'ytd') state.start = snap(days, `${end.slice(0, 4)}-01-01`, true);
  else {
    const i = days.indexOf(snap(days, end, false));
    state.start = days[Math.max(0, i - Number(r))];
  }
  state.range = r;
}

// ---------------------------------------------------------------- 畫面
const sortKey = () => (state.tab === 'cur' ? 'cur' : 'dd');

function filtered() {
  const key = sortKey();
  // 全市場名次（這個分頁的排序），篩選之後仍顯示原本的名次
  const all = state.rows.slice().sort((a, b) => a[key] - b[key]);
  all.forEach((r, i) => { r.no = i + 1; });
  const q = state.q.trim().toLowerCase();
  if (q) return all.filter((r) => r.c.startsWith(q) || (r.n || '').toLowerCase().includes(q));
  let xs = all.filter((r) => (state.mk === 'all' || r.mk === state.mk)
    && (state.liq === 'all' || r.liq) && (!state.ind || r.ind === state.ind));
  if (state.tab === 'low') xs = xs.filter((r) => r.low);
  return xs;
}

function row(r) {
  const cur = state.tab === 'cur';
  const endLabel = state.res.to === state.data.asof ? '現' : `${md(state.res.to)} 收`;
  const sub = cur
    ? `期間高點 ${md(r.pd)} ${num(r.pp)} · 最大回落 ${pct(r.dd)}`
    : `高 ${md(r.hd)} ${num(r.hp)} → 低 ${md(r.ld)} ${num(r.lp)}`;
  const foot = cur
    ? `${endLabel} ${num(r.cl)} · 期間 <span class="${dir(r.ret)}">${pct(r.ret, 0)}</span>`
    : `${endLabel} ${num(r.cl)} · ${r.reb > 0 ? `低點起 <span class="up">${pct(r.reb, 0)}</span>` : '就在低點'}`;
  const val = cur ? r.cur : r.dd;
  return `<a class="row" href="index.html#/stock/${esc(r.c)}">
    <span class="rank"><span class="no">${r.no}</span></span>
    <span class="ident">
      <span class="name">${esc(r.n || r.c)}</span>
      <span class="code">${esc(r.c)} · ${esc(r.mk)}${r.ind ? ` · ${esc(r.ind)}` : ''}</span>
      <span class="rev-sub">${sub}</span>
    </span>
    <span class="figures"><span class="value ${dir(val)}">${pct(val)}</span><span class="price">${foot}</span></span>
  </a>`;
}

function summaryHtml() {
  const R = state.res;
  const T = R.taiex;
  return `<h2>${ymd(R.from)} ～ ${ymd(R.to)} <small>${R.days} 個交易日 · ${R.all} 檔</small></h2>
    <div class="stat-grid">
      ${T ? `<div class="stat"><b class="${dir(T.dd)}">${pct(T.dd)}</b><span>加權指數最大回落（${md(T.hd)} → ${md(T.ld)}）</span></div>` : ''}
      <div class="stat"><b>${R.d30}</b><span>最大回落超過 30%</span></div>
      <div class="stat"><b>${R.d50}</b><span>超過 50%</span></div>
      <div class="stat"><b>${R.d70}</b><span>超過 70%</span></div>
    </div>
    <p class="note">${T ? `加權指數期間 ${pct(T.ret, 0)}，結束日離期間高點（${md(T.pd)}）${pct(T.cur)}。` : ''}
      很多股票的低點擠在同一天，多半是跟著大盤一起跌；低點在最近、而且沒反彈的，才是還沒止跌的。</p>`;
}

function explain() {
  const t = state.tab;
  if (t === 'cur') return '結束日離期間最高點多遠。中間跌深又反彈回來的，這裡會比「最大回落」淺。';
  if (t === 'low') return `期間最低點落在最後 ${state.data.newLow} 個交易日（${md(state.res.lowSince)} 起）：還沒止跌的。`;
  return '期間內先出現的高點，到它之後最低的那一天跌了多少——高點買進、抱到最低，最慘會賠多少。';
}

function listHtml() {
  const xs = filtered();
  const shown = xs.slice(0, PAGE * state.more);
  const rest = xs.length - shown.length;
  const q = state.q.trim();
  const head = q ? `<p class="note">搜尋「${esc(q)}」：${xs.length} 檔（不套用上面的篩選；名次是全市場的）</p>`
    : `<p class="note">共 ${xs.length} 檔。</p>`;
  return `${head}
    ${shown.length ? shown.map(row).join('') : `<p class="hint">${q ? '找不到這檔股票（期間開始後才上市、或長期停牌的不列）。' : '沒有符合條件的股票。'}</p>`}
    ${rest > 0 ? `<button class="cyc-morebtn" data-more="1">再列 ${Math.min(PAGE, rest)} 檔（還有 ${rest}）</button>` : ''}`;
}

function renderList() {
  $('#dd-list').innerHTML = listHtml();
}

function renderResults() {
  $('#dd-sum').innerHTML = summaryHtml();
  $('#dd-explain').textContent = explain() + (state.liq === 'liq' ? '「成交熱門」是近期常進成交值前段班的股票（看最新一天）。' : '');
  renderList();
}

function render() {
  const d = state.data;
  $('#meta').textContent = `最新收盤 ${d.asof}`;
  const inds = [...new Set(Object.values(d.meta).map((m) => m[1]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  $('#view').innerHTML = `
  <section class="card">
    <div class="cond"><b>期間</b>${pills('range', RANGES, state.range)}</div>
    <div class="cond"><b>起訖</b>
      <input id="dd-start" type="date" min="${d.first}" max="${d.asof}" value="${state.start}" style="min-width:0;flex:1 1 0">
      <span>～</span>
      <input id="dd-end" type="date" min="${d.first}" max="${d.asof}" value="${state.end}" style="min-width:0;flex:1 1 0">
    </div>
  </section>
  <section class="card" id="dd-sum"></section>
  <section class="card">
    <div class="controls cyc-tabs">${pills('tab', TABS, state.tab)}</div>
    <div class="cond"><b>搜尋</b><input id="dd-q" type="search" inputmode="search" placeholder="代號或名稱，例如 2330、台積電"
      value="${esc(state.q)}" autocomplete="off" style="flex:1 1 auto;min-width:0"></div>
    <div class="cond"><b>市場</b>${pills('mk', MARKETS, state.mk)}</div>
    <div class="cond"><b>流動性</b>${pills('liq', LIQS, state.liq)}</div>
    <div class="cond"><b>產業</b><select id="dd-ind"><option value="">全部產業</option>${inds
      .map((x) => `<option value="${esc(x)}" ${x === state.ind ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
    <p class="note" id="dd-explain"></p>
  </section>
  <section class="card" id="dd-list"></section>`;
  renderResults();
}

/** 期間變了：重算（可能要多載一年）再畫 */
async function recompute() {
  $('#dd-sum').innerHTML = '<p class="hint">計算中…</p>';
  try {
    await compute();
  } catch (err) {
    console.error(err);
    $('#dd-sum').innerHTML = '<p class="hint">這段期間的資料載不到。</p>';
    return;
  }
  state.more = 1;
  $('#dd-start').value = state.start;
  $('#dd-end').value = state.end;
  document.querySelectorAll('[data-range]').forEach((b) => b.classList.toggle('active', b.dataset.range === state.range));
  renderResults();
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ tab: state.tab, mk: state.mk, liq: state.liq }));
  } catch (err) { /* 記不住就算了 */ }
}

function bind() {
  const view = $('#view');
  view.addEventListener('click', (ev) => {
    const el = ev.target.closest('button');
    if (!el) return;
    const ds = el.dataset;
    if (ds.range) { applyRange(ds.range); recompute(); return; }
    if (ds.more) { state.more += 1; renderList(); return; }
    let k;
    if (ds.tab) { state.tab = ds.tab; k = 'tab'; }
    else if (ds.mk) { state.mk = ds.mk; k = 'mk'; }
    else if (ds.liq) { state.liq = ds.liq; k = 'liq'; }
    else return;
    state.more = 1;
    save();
    view.querySelectorAll(`[data-${k}]`).forEach((b) => b.classList.toggle('active', b === el));
    renderResults();
  });
  // 打字時只重畫清單，輸入框不重建，游標才不會跳掉
  view.addEventListener('input', (ev) => {
    if (ev.target.id !== 'dd-q') return;
    state.q = ev.target.value;
    state.more = 1;
    renderList();
  });
  view.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.id === 'dd-ind') {
      state.ind = t.value;
      state.more = 1;
      renderResults();
    } else if (t.id === 'dd-start' || t.id === 'dd-end') {
      const d = state.data;
      let s = $('#dd-start').value || d.first;
      let e = $('#dd-end').value || d.asof;
      if (s > e) [s, e] = [e, s];
      const days = tradingDays();
      state.start = snap(days, s < d.first ? d.first : s, true);
      state.end = snap(days, e > d.asof ? d.asof : e, false);
      state.range = '';
      recompute();
    }
  });
}

async function main() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (TABS.some((t) => t.value === v.tab)) state.tab = v.tab;
    if (MARKETS.some((t) => t.value === v.mk)) state.mk = v.mk;
    if (LIQS.some((t) => t.value === v.liq)) state.liq = v.liq;
  } catch (err) { /* 讀不到就用預設 */ }
  try {
    state.data = await getJson('drawdown.json');
    state.end = state.data.asof;           // 結束日預設最新一天
    applyRange('ytd');
    await compute();
  } catch (err) {
    console.error(err);
    $('#meta').textContent = '載入失敗';
    $('#view').innerHTML = '<p class="hint">資料載不到。這一頁要等 <code>scripts/build_drawdown.py</code> 跑過一次才有東西。</p>';
    return;
  }
  bind();
  render();
}

main();
