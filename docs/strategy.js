/*
 * 策略（strategy.html）：動能 ＋ 營收創新高、抱 20 天。
 *
 *   今天   今天收盤後的訊號（明天開盤照空位依序買）與實盤追蹤的持股
 *   績效   實盤追蹤（2026-10-19 起）與近一年照同一套規則跑的淨值，都跟 0050 並排
 *   規則   規則本身、5 年回測的範圍，與它在哪些地方會輸
 *
 * 訊號、持股與淨值全在 scripts/build_strategy.py 算好（算式跟回測共用 scripts/strategy.py），這裡只畫。
 * 回測的數字一律報範圍與輸的年份——頁面上不能長得比回測更有把握。
 */

const DATA = 'data';
const TABS = [
  { value: 'today', label: '今天' },
  { value: 'perf', label: '績效' },
  { value: 'rules', label: '規則' },
];
const PAGE = 20;
const KEY_TAB = 'stocktracker.strategytab';

const state = { data: null, tab: 'today', more: {} };

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (v, digits = 2) => (v === null || v === undefined ? '—'
  : Number(v).toLocaleString('zh-TW', { maximumFractionDigits: digits }));
const pct = (v, digits = 0) => {
  if (v === null || v === undefined) return '—';
  const t = Number(v).toFixed(digits);
  return Number(t) === 0 ? `${(0).toFixed(digits)}%` : `${v > 0 ? '+' : ''}${t}%`;
};
const dir = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const md = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '');

function pills(name, options, current) {
  return `<div class="pills">${options
    .map((o) => `<button class="pill ${o.value === current ? 'active' : ''}" data-${name}="${o.value}">${esc(o.label)}</button>`)
    .join('')}</div>`;
}

// 淨值圖：策略與 0050 同一個刻度（起點都是 1）
function equityChart(c, label) {
  if (!c || c.dates.length < 2) return '';
  const W = 600;
  const H = 180;
  const pad = 6;
  const all = [...c.eq, ...c.bench].filter((v) => v !== null && v !== undefined);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const n = c.dates.length;
  const x = (k) => pad + (k / Math.max(1, n - 1)) * (W - pad * 2);
  const y = (v) => pad + (1 - (v - lo) / (hi - lo || 1)) * (H - pad * 2);
  const path = (v) => v.map((p, k) => (p === null ? null : `${x(k).toFixed(1)},${y(p).toFixed(1)}`)).filter(Boolean).join(' ');
  const ticks = [];
  let last = '';
  c.dates.forEach((d, k) => {
    const m = d.slice(0, 7);
    if (m === last) return;
    last = m;
    const mm = Number(d.slice(5, 7));
    if (n < 60 || mm % 3 === 1) ticks.push(`<span style="left:${(x(k) / W) * 100}%">${d.slice(2, 4)}/${mm}</span>`);
  });
  return `<figure class="cyc-chart">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}" style="height:160px">
      <line class="cyc-chart__zero" x1="0" x2="${W}" y1="${y(1).toFixed(1)}" y2="${y(1).toFixed(1)}"/>
      <polyline class="cyc-line cyc-line--mkt" points="${path(c.bench)}"/>
      <polyline class="cyc-line cyc-line--stk" points="${path(c.eq)}"/>
    </svg>
    <div class="cyc-chart__years">${ticks.join('')}</div>
    <div class="cyc-chart__range">上 ${pct((hi - 1) * 100)}　下 ${pct((lo - 1) * 100)}</div>
  </figure>
  <p class="gy-keys"><span class="cyc-key cyc-line--stk">策略</span><span class="cyc-key cyc-line--mkt">0050</span></p>`;
}

function statGrid(s) {
  return `<div class="stat-grid">
    <div class="stat"><b class="${dir(s.ret)}">${pct(s.ret, 1)}</b><span>策略</span></div>
    <div class="stat"><b class="${dir(s.bret)}">${pct(s.bret, 1)}</b><span>0050</span></div>
    <div class="stat"><b class="down">${pct(s.mdd, 0)}</b><span>最大回落（0050 ${pct(s.bmdd, 0)}）</span></div>
    <div class="stat"><b>${s.n ? pct(s.win, 0).replace('+', '') : '—'}</b><span>每筆勝率（${s.n} 筆已出場）</span></div>
  </div>`;
}

function stockRow(r, main, cls, foot, sub) {
  return `<a class="row gy-row" href="index.html#/stock/${esc(r.c)}">
    <span class="ident">
      <span class="name">${esc(r.n || r.c)}</span>
      <span class="code">${esc(r.c)}${r.ind ? ` · ${esc(r.ind)}` : ''}${sub ? ` · ${sub}` : ''}</span>
    </span>
    <span class="figures"><span class="value ${cls}">${main}</span><span class="price">${foot}</span></span>
  </a>`;
}

function listMore(key, rows, render, empty) {
  const shown = rows.slice(0, PAGE * (state.more[key] || 1));
  const rest = rows.length - shown.length;
  return `${shown.length ? shown.map(render).join('') : `<p class="hint">${empty}</p>`}
    ${rest > 0 ? `<button class="cyc-morebtn" data-more="${key}">再列 ${Math.min(PAGE, rest)} 檔（還有 ${rest}）</button>` : ''}`;
}

const holdingRow = (r) => stockRow(r, pct(r.r, 1), dir(r.r),
  r.left <= 1 ? '明天開盤賣' : `第 ${r.day}/20 天`,
  `${md(r.ed)} 開盤 ${fmt(r.px)} 買`);
const tradeRow = (r) => stockRow(r, pct(r.r, 1), dir(r.r), `${md(r.ed)} → ${md(r.xd)}`, '已扣來回成本');

// --------------------------------------------------------------------------
function todayView() {
  const d = state.data;
  const L = d.live;
  const buys = d.signals.filter((s) => s.buy);
  const rest = d.signals.filter((s) => !s.buy);
  const sigRow = (s) => stockRow(s, pct(s.r20, 1), dir(s.r20), '20 日漲幅',
    `${s.m ? `${esc(s.m)} 營收 YoY ${pct(s.yoy)}` : '營收創新高'}${s.held ? ' · 已持有' : ''}`);
  return `<section class="card">
    <h2>明天開盤要買 <small>${d.d} 收盤後 · 空位 ${d.free}/${d.rule.slots}</small></h2>
    <p class="note">收盤創 60 日新高、最新月營收創 12 個月新高、在成交值前 300 的常客。照 20 日漲幅排，有空位就依序買；
      開盤就漲停的跳過、換下一檔（得等開盤才知道）。每檔投入淨值的 1/${d.rule.slots}，抱 ${d.rule.hold} 個交易日。</p>
    ${listMore('buy', buys, sigRow, d.signals.length ? '今天有訊號，但空位都滿了。' : '今天沒有同時符合兩個條件的股票。')}
  </section>
  ${rest.length ? `<section class="card"><h2>其他訊號 <small>${rest.length} 檔 · 沒有空位或已持有</small></h2>
    ${listMore('rest', rest, sigRow, '')}</section>` : ''}
  <section class="card">
    <h2>實盤持股 <small>${L.started ? `${esc(L.from)} 起` : `${esc(L.from)} 開盤開始`}</small></h2>
    ${L.started
      ? `${listMore('hold', L.holdings, holdingRow, '目前沒有持股，資金都在 0050。')}
         <p class="note">沒用到的錢放 0050，目前約佔 ${fmt(L.cash, 0)}%。報酬是還原除權息、還沒扣賣出成本的帳面數字。</p>`
      : `<p class="hint">實盤追蹤從 ${esc(L.from)} 開盤開始：照上面這份清單買進，之後每一天都是回測沒看過的資料。
         開始之前先看「績效」的近一年。</p>`}
  </section>`;
}

function perfView() {
  const d = state.data;
  const L = d.live;
  const Y = d.year;
  const live = L.started
    ? `<section class="card">
        <h2>實盤追蹤 <small>${esc(L.from)} 起 · 回測沒看過的資料</small></h2>
        ${statGrid(L.stats)}
        ${equityChart(L.curve, '實盤追蹤淨值與 0050')}
        ${L.trades.length ? `<h3 class="gy-sec">已出場</h3>${listMore('ltr', L.trades, tradeRow, '')}` : ''}
      </section>`
    : `<section class="card"><h2>實盤追蹤 <small>${esc(L.from)} 開盤開始</small></h2>
        <p class="hint">還沒開始。從那天起的每一筆都會記在這裡，跟 0050 並排。</p></section>`;
  return `${live}
  <section class="card">
    <h2>近一年照規則跑 <small>${esc(Y.from)} 起 · 每天往前滾</small></h2>
    ${statGrid(Y.stats)}
    ${equityChart(Y.curve, '近一年淨值與 0050')}
    <p class="note">同一套規則從一年前開始跑。這一年的資料，在決定用這套規則的時候已經看過（是回測的後段），
      所以只是讓你看規則長什麼樣子，不算考試；考試是上面的實盤追蹤。</p>
    <h3 class="gy-sec">目前持股</h3>
    ${listMore('yhold', Y.holdings, holdingRow, '沒有持股。')}
    <h3 class="gy-sec">最近出場</h3>
    ${listMore('ytr', Y.trades, tradeRow, '還沒有出場的交易。')}
  </section>`;
}

function rulesView() {
  const d = state.data;
  const R = d.research;
  const u = d.rule;
  return `<section class="card">
    <h2>規則 <small>每天收盤後判斷，隔天開盤執行</small></h2>
    <ul class="rule-rules">
      <li><b>範圍</b><span>普通股，近 ${u.liq_window} 個交易日至少 ${u.liq_days} 天在上市＋上櫃成交值前 ${u.liq_top} 名。</span></li>
      <li><b>進場</b><span>收盤（還原除權息）創 ${u.high} 個交易日新高，而且最新已公布的月營收創 ${u.rev} 個月新高
        （m 月營收從 m+1 月 ${u.rev_day} 日起才算）。隔天開盤買；開盤就漲停的跳過。</span></li>
      <li><b>出場</b><span>抱 ${u.hold} 個交易日，第 ${u.hold + 1} 天開盤賣。中間不停損、不停利。</span></li>
      <li><b>資金</b><span>最多同時 ${u.slots} 檔，每檔投入當下淨值的 1/${u.slots}；訊號多於空位時先買 20 日漲幅大的。
        沒用到的錢放 0050。個股來回扣 ${(u.cost * 100).toFixed(3)}%。</span></li>
    </ul>
  </section>
  <section class="card">
    <h2>5 年回測 <small>${esc(R.period)} · 30 種挑股順序的中位數與 10～90% 範圍</small></h2>
    <ul class="rule-rules">
      ${R.rows.map((r) => `<li><b>${esc(r.k)}</b><span>策略 ${pct(r.s)}（${pct(r.lo)} ～ ${pct(r.hi)}），0050 ${pct(r.b)}；
        ${r.win}% 的路徑贏 0050。</span></li>`).join('')}
      <li><b>同一套進出規則改成隨機選股</b><span>前段 ${pct(R.rand.a)}、後段 ${pct(R.rand.b)}；只有 ${esc(R.rand.win)}% 的路徑贏 0050。</span></li>
    </ul>
    <div class="stat-grid">
      ${R.years.map((y) => `<div class="stat"><b class="${dir(y.pt)}">${y.pt > 0 ? '+' : ''}${y.pt} 點</b>
        <span>${esc(y.y)}（${y.win}% 的路徑贏）</span></div>`).join('')}
    </div>
    <p class="note">每格是那一年策略減 0050 的中位數（百分點）。每筆勝率 ${R.trade.win}%（${R.trade.n} 筆）。</p>
    <h3 class="gy-sec">要知道的事</h3>
    <ul class="rule-rules">${R.notes.map((x) => `<li><span>${esc(x)}</span></li>`).join('')}</ul>
  </section>`;
}

// --------------------------------------------------------------------------
function render() {
  const d = state.data;
  $('#meta').textContent = `資料 ${d.d} · 訊號 ${d.signals.length} 檔${d.live.started ? ` · 實盤 ${pct(d.live.stats.ret, 1)}（0050 ${pct(d.live.stats.bret, 1)}）` : ''}`;
  const head = `<section class="card"><div class="controls cyc-tabs">${pills('tab', TABS, state.tab)}</div></section>`;
  const body = state.tab === 'perf' ? perfView() : state.tab === 'rules' ? rulesView() : todayView();
  $('#view').innerHTML = head + body;
}

function bind() {
  $('#view').addEventListener('click', (ev) => {
    const el = ev.target.closest('button');
    if (!el) return;
    const ds = el.dataset;
    if (ds.tab) {
      state.tab = ds.tab;
      try { localStorage.setItem(KEY_TAB, ds.tab); } catch (err) { /* 記不住就算了 */ }
    } else if (ds.more) {
      state.more[ds.more] = (state.more[ds.more] || 1) + 1;
    } else {
      return;
    }
    render();
  });
}

async function main() {
  try {
    const v = localStorage.getItem(KEY_TAB);
    if (TABS.some((t) => t.value === v)) state.tab = v;
  } catch (err) { /* 讀不到就用預設 */ }
  try {
    const res = await fetch(`${DATA}/strategy.json`);
    if (!res.ok) throw new Error(`strategy.json ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    console.error(err);
    $('#meta').textContent = '載入失敗';
    $('#view').innerHTML = '<p class="hint">資料載不到。這一頁要等 <code>scripts/build_strategy.py</code> 跑過一次才有東西。</p>';
    return;
  }
  bind();
  render();
}

main();
