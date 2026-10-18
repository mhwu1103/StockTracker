/*
 * 處置（disposal.html）：被交易所處置（分盤撮合、預收款券）的股票。
 *
 *   今天   今天公布、明天開始處置的（訊號：處置第一天開盤買、抱到處置最後一天收盤），與處置中的
 *   近期   最近公布的每一筆，照同一條規則的實際結果——讓人看得到它最近還靈不靈
 *   規則   5 年回測的數字、它跟誰比、在哪些地方不賺
 *
 * 全部在 scripts/build_disposal.py 算好，這裡只畫。回測在 scripts/backtest_disposal.py。
 * 回測說的是「比漲幅相近、沒被處置的股票強」，不是「一定賺」——頁面上兩個數字都要擺。
 */

const DATA = 'data';
const TABS = [
  { value: 'today', label: '今天' },
  { value: 'recent', label: '近期' },
  { value: 'rules', label: '規則' },
];
const PAGE = 20;
const KEY_TAB = 'stocktracker.disposaltab';

const state = { data: null, tab: 'today', more: {} };

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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

const kind = (r) => `${r.k >= 2 ? '第二次' : '第一次'}${r.mins ? ` · ${r.mins} 分鐘撮合` : ''}`;

function row(r, main, cls, foot) {
  return `<a class="row gy-row" href="index.html#/stock/${esc(r.c)}">
    <span class="ident">
      <span class="name">${esc(r.n || r.c)}</span>
      <span class="code">${esc(r.c)}${r.ind ? ` · ${esc(r.ind)}` : ''}</span>
      <span class="rev-sub">${kind(r)} · ${md(r.from)}～${md(r.to)}${r.pre !== undefined ? ` · 處置前 10 日 <span class="${dir(r.pre)}">${pct(r.pre)}</span>` : ''}</span>
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

const heldRow = (r) => (r.limit
  ? row(r, '買不到', 'flat', '第一天開盤就漲停')
  : row(r, pct(r.r, 1), dir(r.r), r.done ? `抱滿 ${r.day} 天` : `第 ${r.day} 天`));

// --------------------------------------------------------------------------
function todayView() {
  const d = state.data;
  const R = d.research;
  return `<section class="card">
    <h2>明天開始處置 <small>${md(d.asof)} 收盤後公布 · ${d.today.length} 檔</small></h2>
    <p class="note">規則：處置第一天開盤買、抱到處置最後一天收盤賣；開盤就漲停的跳過。5 年回測平均 ${pct(R.avg, 1)}、
      中位數 ${pct(R.med, 1)}、${R.win}% 上漲；比漲幅相近、沒被處置的股票平均多 ${pct(R.ex, 1)}。
      處置期間要<b>預收款券</b>（先把錢存進交割戶才能買），細節在「規則」。</p>
    ${listMore('today', d.today, (r) => row(r, md(r.from), '', '開始處置'), '今天沒有新公布的處置股。')}
  </section>
  <section class="card">
    <h2>處置中 <small>${d.active.length} 檔</small></h2>
    <p class="note">從處置第一天開盤算到 ${md(d.asof)} 收盤（還原除權息）。</p>
    ${listMore('active', d.active, heldRow, '目前沒有處置中的股票。')}
  </section>`;
}

function recentView() {
  const d = state.data;
  const S = d.recentStats;
  const done = d.recent.filter((r) => r.done);
  const going = d.recent.filter((r) => !r.done);
  return `<section class="card">
    <h2>近 ${S.days} 個交易日 <small>已出關 ${S.n} 筆</small></h2>
    <div class="stat-grid">
      <div class="stat"><b class="${dir(S.avg)}">${pct(S.avg, 1)}</b><span>平均</span></div>
      <div class="stat"><b class="${dir(S.med)}">${pct(S.med, 1)}</b><span>中位數</span></div>
      <div class="stat"><b>${S.win ?? '—'}%</b><span>上漲比例</span></div>
      <div class="stat"><b>${pct(d.research.med, 1)}</b><span>5 年回測中位數</span></div>
    </div>
    <p class="note">照同一條規則（處置第一天開盤買、抱到最後一天收盤）的每一筆，未扣成本；開盤就漲停的不算。
      最近的數字比 5 年回測好很多的話，多半是行情好，不是規則變強了。</p>
    ${going.length ? `<h3 class="gy-sec">還在處置中</h3>${listMore('going', going, heldRow, '')}` : ''}
    <h3 class="gy-sec">已出關</h3>
    ${listMore('done', done, heldRow, '還沒有出關的。')}
  </section>`;
}

function rulesView() {
  const R = state.data.research;
  return `<section class="card">
    <h2>規則 <small>每天收盤後</small></h2>
    <ul class="rule-rules">
      <li><b>訊號</b><span>證交所或櫃買今天公布處置（隔天起處置）的普通股。</span></li>
      <li><b>進場</b><span>處置第一天開盤買；開盤就漲停（≥ 前一天收盤 × 1.095）的跳過——實務上買不到。</span></li>
      <li><b>出場</b><span>處置最後一天收盤賣，中間不停損、不停利。</span></li>
      <li><b>處置是什麼</b><span>連續幾天被公布「注意交易資訊」的股票，交易所改成分盤撮合（每幾分鐘撮合一次）、
        買賣要預收款券。2026-08-07 起第一次、第二次處置都是 5 個交易日、約每 2 分鐘撮合；之前是 10 個交易日、
        第一次 5 分鐘、第二次 20 分鐘。</span></li>
    </ul>
  </section>
  <section class="card">
    <h2>5 年回測 <small>${esc(R.period)} · ${R.n} 筆</small></h2>
    <div class="stat-grid">
      <div class="stat"><b class="${dir(R.avg)}">${pct(R.avg, 1)}</b><span>平均（中位數 ${pct(R.med, 1)}）</span></div>
      <div class="stat"><b>${R.win}%</b><span>上漲比例</span></div>
      <div class="stat"><b class="${dir(R.ex)}">${pct(R.ex, 1)}</b><span>減漲幅相近的對照組（中位數 ${pct(R.exmed, 1)}）</span></div>
      <div class="stat"><b>${R.beat}%</b><span>贏對照組的比例</span></div>
    </div>
    <p class="note">被處置的股票是前幾天大漲的那一群（公布那天近 10 日漲幅中位數 +${R.pre}%）。直接跟大盤比，賺賠全是「大漲之後」的效果，
      不是處置的；所以每一筆都跟<b>同一天、近 10 日漲幅相近（±25%）但沒被處置</b>的股票比，同一段期間。
      第一次處置多 ${pct(R.first.ex, 1)}（${R.first.beat}% 贏），第二次多 ${pct(R.second.ex, 1)}（${R.second.beat}% 贏）。</p>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>期間</th><th>原始中位數</th><th>減對照組</th></tr></thead>
      <tbody>${R.years.map((y) => `<tr><th>${esc(y.y)}</th><td><b class="${dir(y.med)}">${pct(y.med, 1)}</b></td>
        <td><b class="${dir(y.ex)}">${pct(y.ex, 1)}</b></td></tr>`).join('')}</tbody>
    </table></div>
    <h3 class="gy-sec">要知道的事</h3>
    <ul class="rule-rules">
      <li><span>相對強，絕對不一定賺：2021-10～2022 的原始中位數幾乎是 0，一半的筆數是賠的。它贏的是「同樣大漲、沒被處置」的股票。</span></li>
      <li><span>報酬沒扣成本（來回約 0.585%），也沒算分盤撮合的滑價——每 2～20 分鐘才撮合一次，開盤價不一定買得到。</span></li>
      <li><span>新制（2026-08 起）只有兩個多月、一百多筆，而且都在多頭；這一段的數字還不能當定論。</span></li>
      <li><span>${esc(R.out)}。</span></li>
      <li><span>這一頁抓公告的時間是平日收盤後的排程；交易所公告得比排程晚的，要到隔天才會出現在「今天」，那一筆就錯過進場了。</span></li>
    </ul>
  </section>`;
}

// --------------------------------------------------------------------------
function render() {
  const d = state.data;
  $('#meta').textContent = `收盤 ${d.asof} · 明天開始處置 ${d.today.length} 檔 · 處置中 ${d.active.length} 檔`;
  const head = `<section class="card"><div class="controls cyc-tabs">${pills('tab', TABS, state.tab)}</div></section>`;
  const body = state.tab === 'recent' ? recentView() : state.tab === 'rules' ? rulesView() : todayView();
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
    const res = await fetch(`${DATA}/disposal.json`);
    if (!res.ok) throw new Error(`disposal.json ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    console.error(err);
    $('#meta').textContent = '載入失敗';
    $('#view').innerHTML = '<p class="hint">資料載不到。這一頁要等 <code>scripts/build_disposal.py</code> 跑過一次才有東西。</p>';
    return;
  }
  bind();
  render();
}

main();
