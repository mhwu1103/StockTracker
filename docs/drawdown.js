/*
 * 跌深（drawdown.html）：今年每一檔股票從高點跌下來有多深。
 *
 *   最大回落   今年先出現的高點，到它之後最低的那一天跌了多少——高點買進、抱到最低最慘賠多少
 *   距高點     現在離今年最高點多遠（中間反彈過的，在這裡會比最大回落淺）
 *   還在破底   今年最低點就落在最近幾個交易日：還沒止跌的
 *
 * 全部在 scripts/build_drawdown.py 算好（只存最大回落超過 25% 的），這裡只篩選、排序、畫。
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
const PAGE = 50;
const KEY = 'stocktracker.drawdown';

const state = { data: null, rows: [], tab: 'dd', mk: 'all', liq: 'all', ind: '', more: 1 };

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (v, digits = 1) => {
  if (v === null || v === undefined) return '—';
  const t = Number(v).toFixed(digits);
  return Number(t) === 0 ? `${(0).toFixed(digits)}%` : `${v > 0 ? '+' : ''}${t}%`;
};
const dir = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const md = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '');
const num = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('zh-TW', { maximumFractionDigits: 2 }));

function pills(name, options, current) {
  return `<div class="pills">${options
    .map((o) => `<button class="pill ${o.value === current ? 'active' : ''}" data-${name}="${o.value}">${esc(o.label)}</button>`)
    .join('')}</div>`;
}

function filtered() {
  const d = state.data;
  let xs = state.rows.filter((r) => (state.mk === 'all' || r.mk === state.mk)
    && (state.liq === 'all' || r.liq) && (!state.ind || r.ind === state.ind));
  if (state.tab === 'low') xs = xs.filter((r) => r.ld >= d.lowSince);
  const key = state.tab === 'cur' ? 'cur' : 'dd';
  return xs.slice().sort((a, b) => a[key] - b[key]);
}

function row(r, i) {
  const cur = state.tab === 'cur';
  const sub = cur
    ? `今年高點 ${md(r.pd)} ${num(r.pp)} · 最大回落 ${pct(r.dd)}`
    : `高 ${md(r.hd)} ${num(r.hp)} → 低 ${md(r.ld)} ${num(r.lp)}`;
  const foot = cur
    ? `現 ${num(r.cl)} · 今年 <span class="${dir(r.ytd)}">${pct(r.ytd, 0)}</span>`
    : `現 ${num(r.cl)} · ${r.reb > 0 ? `低點起 <span class="up">${pct(r.reb, 0)}</span>` : '就在低點'}`;
  return `<a class="row" href="index.html#/stock/${esc(r.c)}">
    <span class="rank"><span class="no">${i + 1}</span></span>
    <span class="ident">
      <span class="name">${esc(r.n || r.c)}</span>
      <span class="code">${esc(r.c)} · ${esc(r.mk)}${r.ind ? ` · ${esc(r.ind)}` : ''}</span>
      <span class="rev-sub">${sub}</span>
    </span>
    <span class="figures"><span class="value down">${pct(cur ? r.cur : r.dd)}</span><span class="price">${foot}</span></span>
  </a>`;
}

function summary() {
  const d = state.data;
  const C = d.count;
  const T = d.taiex;
  return `<section class="card">
    <h2>${esc(d.year)} 年 <small>${md(d.from)} ～ ${md(d.asof)} · ${C.all} 檔</small></h2>
    <div class="stat-grid">
      ${T ? `<div class="stat"><b class="down">${pct(T.dd)}</b><span>加權指數最大回落（${md(T.hd)} → ${md(T.ld)}）</span></div>` : ''}
      <div class="stat"><b>${C.d30}</b><span>最大回落超過 30%</span></div>
      <div class="stat"><b>${C.d50}</b><span>超過 50%</span></div>
      <div class="stat"><b>${C.d70}</b><span>超過 70%</span></div>
    </div>
    <p class="note">${T ? `加權指數今年 ${pct(T.ytd, 0)}，現在離今年高點（${md(T.pd)}）${pct(T.cur)}。` : ''}
      很多股票的低點擠在同一天，多半是跟著大盤一起跌；低點在最近、而且沒反彈的，才是還沒止跌的。</p>
  </section>`;
}

function explain() {
  const d = state.data;
  const t = state.tab;
  if (t === 'cur') return '現在離今年最高點多遠。中間跌深又反彈回來的，這裡會比「最大回落」淺。';
  if (t === 'low') return `今年最低點落在最近 ${d.newLow} 個交易日（${md(d.lowSince)} 起）：還沒止跌的。`;
  return '今年先出現的高點，到它之後最低的那一天跌了多少——高點買進、抱到最低，最慘會賠多少。';
}

function render() {
  const d = state.data;
  $('#meta').textContent = `收盤 ${d.asof} · ${d.year} 年最大回落超過 50% 的 ${d.count.d50} 檔`;
  const inds = [...new Set(state.rows.map((r) => r.ind).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  const xs = filtered();
  const shown = xs.slice(0, PAGE * state.more);
  const rest = xs.length - shown.length;
  $('#view').innerHTML = `${summary()}
  <section class="card">
    <div class="controls cyc-tabs">${pills('tab', TABS, state.tab)}</div>
    <div class="cond"><b>市場</b>${pills('mk', MARKETS, state.mk)}</div>
    <div class="cond"><b>流動性</b>${pills('liq', LIQS, state.liq)}</div>
    <div class="cond"><b>產業</b><select id="dd-ind"><option value="">全部產業</option>${inds
      .map((x) => `<option value="${esc(x)}" ${x === state.ind ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
    <p class="note">${explain()}${state.liq === 'liq' ? '「成交熱門」是近期常進成交值前段班的股票。' : ''}
      只列最大回落超過 ${Math.abs(d.keep)}% 的，共 ${xs.length} 檔。</p>
  </section>
  <section class="card">
    ${shown.length ? shown.map(row).join('') : '<p class="hint">沒有符合條件的股票。</p>'}
    ${rest > 0 ? `<button class="cyc-morebtn" data-more="1">再列 ${Math.min(PAGE, rest)} 檔（還有 ${rest}）</button>` : ''}
  </section>`;
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
    if (ds.tab) state.tab = ds.tab;
    else if (ds.mk) state.mk = ds.mk;
    else if (ds.liq) state.liq = ds.liq;
    else if (ds.more) { state.more += 1; render(); return; }
    else return;
    state.more = 1;
    save();
    render();
  });
  view.addEventListener('change', (ev) => {
    if (ev.target.id !== 'dd-ind') return;
    state.ind = ev.target.value;
    state.more = 1;
    render();
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
    const res = await fetch(`${DATA}/drawdown.json`);
    if (!res.ok) throw new Error(`drawdown.json ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    console.error(err);
    $('#meta').textContent = '載入失敗';
    $('#view').innerHTML = '<p class="hint">資料載不到。這一頁要等 <code>scripts/build_drawdown.py</code> 跑過一次才有東西。</p>';
    return;
  }
  const cols = state.data.cols;
  state.rows = state.data.rows.map((a) => Object.fromEntries(cols.map((k, i) => [k, a[i]])));
  bind();
  render();
}

main();
