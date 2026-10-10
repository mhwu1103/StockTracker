/*
 * MK 大腦（gooaye.html）：MK 講過的規則，哪些經得起台股資料的回測，今天照那些規則挑出來的是誰。
 *
 *   今天   只列回測成立的規則挑出來的股票（營收創高後的漂移、突破＋營收加速、整理後突破），
 *          以及回測說要避開的（強勢股剛破季線、創一年新低、低基期的高 YoY）
 *   大盤   加權指數相對季線、年線的位置，照他的原話跑出來的「持有／空手」；融資水位與維持率
 *   規則   他講過的每一條規則與回測結論：成立、只在多頭、只能控風險、證據不足、推翻
 *
 * 清單與判斷全在 scripts/build_gooaye.py 算好（算式跟回測共用 scripts/gooaye.py），這裡只畫。
 * 每一份清單的標題下面都寫回測數字——頁面上不能長得比回測更有把握。
 */

const DATA = 'data';

const TABS = [
  { value: 'today', label: '今天' },
  { value: 'market', label: '大盤' },
  { value: 'rules', label: '規則' },
];

const VERDICT = {
  ok: { label: '成立', cls: 'ok' },
  bull: { label: '只在多頭', cls: 'bull' },
  risk: { label: '只能控風險', cls: 'risk' },
  weak: { label: '證據不足', cls: 'weak' },
  no: { label: '不成立', cls: 'no' },
};

const PAGE = 20;
const DRIFT_DAYS = 20;     // 營收創高後的漂移，回測持有 20 個交易日（build_gooaye.py 的 DRIFT_DAYS）
const KEY_TAB = 'stocktracker.gooayetab';

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

function pills(name, options, current) {
  return `<div class="pills">${options
    .map((o) => `<button class="pill ${o.value === current ? 'active' : ''}" data-${name}="${o.value}">${esc(o.label)}</button>`)
    .join('')}</div>`;
}

const rule = (k) => state.data.rules.find((r) => r.k === k);

function verdictTag(v) {
  const x = VERDICT[v] || VERDICT.weak;
  return `<span class="gy-verdict gy-verdict--${x.cls}">${x.label}</span>`;
}

// --------------------------------------------------------------------------
// 折線圖：每一條線各自的刻度不一樣時（指數與均線同刻度、融資與維持率不同刻度），各畫各的
// --------------------------------------------------------------------------
function lineChart(dates, series, { height = 150, label = '' } = {}) {
  const W = 600;
  const H = 180;
  const pad = 6;
  const all = series.flatMap((s) => s.v).filter((v) => v !== null && v !== undefined);
  if (!all.length) return '';
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const n = dates.length;
  const x = (k) => pad + (k / Math.max(1, n - 1)) * (W - pad * 2);
  const y = (v) => pad + (1 - (v - lo) / (hi - lo || 1)) * (H - pad * 2);
  const path = (v) => v.map((p, k) => (p === null || p === undefined ? null : `${x(k).toFixed(1)},${y(p).toFixed(1)}`))
    .filter(Boolean).join(' ');
  // 標月份：資料超過一年標每年一月，不到一年標每季第一個月
  const ticks = [];
  let last = '';
  const long = n > 300;
  dates.forEach((d, k) => {
    const m = d.slice(0, 7);
    if (m === last) return;
    last = m;
    const mm = Number(d.slice(5, 7));
    if (long ? mm === 1 : mm % 3 === 1) {
      ticks.push(`<span style="left:${(x(k) / W) * 100}%">${long ? d.slice(0, 4) : `${d.slice(2, 4)}/${mm}`}</span>`);
    }
  });
  return `<figure class="cyc-chart">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}" style="height:${height}px">
      ${series.map((s) => `<polyline class="cyc-line ${s.cls}" points="${path(s.v)}"/>`).join('')}
    </svg>
    <div class="cyc-chart__years">${ticks.join('')}</div>
    <div class="cyc-chart__range">上 ${fmt(hi, 0)}　下 ${fmt(lo, 0)}</div>
  </figure>`;
}

// --------------------------------------------------------------------------
// 今天
// --------------------------------------------------------------------------
function stockLink(r, extra) {
  return `<a class="row gy-row" href="index.html#/stock/${esc(r.c)}">
    <span class="ident">
      <span class="name">${esc(r.n || r.c)}</span>
      <span class="code">${esc(r.c)}${r.ind ? ` · ${esc(r.ind)}` : ''}${extra.sub ? ` · ${extra.sub}` : ''}</span>
    </span>
    <span class="figures"><span class="value ${extra.cls || ''}">${extra.main}</span><span class="price">${extra.foot}</span></span>
  </a>`;
}

function listCard(key, { title, small, ruleKey, avoid = false, row, empty }) {
  const L = state.data.lists[key];
  const R = rule(ruleKey);
  const shown = L.rows.slice(0, PAGE * (state.more[key] || 1));
  const rest = L.rows.length - shown.length;
  return `<section class="card gy-list ${avoid ? 'gy-list--avoid' : ''}" id="list-${key}">
    <h2>${title} <small>${L.n} 檔${L.n > L.rows.length ? `，列前 ${L.rows.length}` : ''}${small ? ` · ${small}` : ''}</small></h2>
    ${R ? `<p class="gy-why">${verdictTag(R.verdict)}<span><b>${esc(R.rule)}</b>　${esc(R.stat)}</span></p>` : ''}
    ${shown.length ? shown.map((r) => stockLink(r, row(r))).join('') : `<p class="hint">${empty}</p>`}
    ${rest > 0 ? `<button class="cyc-morebtn" data-more="${key}">再列 ${Math.min(PAGE, rest)} 檔（還有 ${rest}）</button>` : ''}
  </section>`;
}

function todayView() {
  const drift = state.data.lists.drift.rows;
  const pending = drift.length && drift.every((r) => r.day === null);
  return [
    listCard('drift', {
      title: '營收創新高之後',
      small: pending ? '公布期間，回測從 11 日開盤才算' : `公布後 ${DRIFT_DAYS} 個交易日內`,
      ruleKey: 'drift',
      row: (r) => ({
        main: r.day === null ? `YoY ${pct(r.yoy)}` : pct(r.r, 1),
        cls: r.day === null ? '' : dir(r.r),
        foot: r.day === null ? '公布中' : `第 ${r.day} 天`,
        sub: `${esc(r.m)} 營收 YoY ${pct(r.yoy)}，連 ${r.streak} 個月創新高`,
      }),
      empty: '這個月的營收還沒有創新高又年增 20% 以上的公司，或 20 天已經走完。',
    }),
    listCard('accel', {
      title: '股價創 12 個月新高＋營收加速',
      ruleKey: 'accel',
      row: (r) => ({
        main: pct(r.yoy[0]),
        cls: 'up',
        foot: `YoY ${pct(r.yoy[2])} → ${pct(r.yoy[1])} → ${pct(r.yoy[0])}`,
        sub: r.ath ? `營收創新高 · 過前高 ${pct(r.hi, 1)}` : `營收沒創新高（可能是低基期） · 過前高 ${pct(r.hi, 1)}`,
      }),
      empty: '今天沒有股價創 12 個月新高、營收 YoY 又連兩個月加速的股票。',
    }),
    listCard('base', {
      title: '整理後突破',
      small: '最近 5 個交易日',
      ruleKey: 'base',
      row: (r) => ({
        main: r.r === null ? '今天' : pct(r.r, 1),
        cls: r.r === null ? '' : dir(r.r),
        foot: r.r === null ? '明天開盤才算進場' : '突破後',
        sub: `${esc(r.d)} 創 250 日新高，舊高在 ${r.ago} 天前`,
      }),
      empty: '最近 5 天沒有整理多季後的突破。',
    }),
    `<h3 class="gy-sec">要避開的</h3>`,
    listCard('hotbreak', {
      title: '強勢股剛跌破季線',
      small: '最近 5 個交易日',
      ruleKey: 'hotbreak',
      avoid: true,
      row: (r) => ({
        main: pct(r.r60), cls: 'up', foot: '跌破前 60 日漲幅',
        sub: `${esc(r.d)} 第一次收在季線下${r.r === null ? '' : `，之後 ${pct(r.r, 1)}`}`,
      }),
      empty: '最近 5 天沒有強勢股跌破季線。',
    }),
    listCard('newlow', {
      title: '創一年新低',
      small: '最近 5 個交易日',
      ruleKey: 'newlow',
      avoid: true,
      row: (r) => ({
        main: r.r === null ? '今天' : pct(r.r, 1), cls: r.r === null ? '' : dir(r.r),
        foot: r.r === null ? '剛創新低' : '之後', sub: `${esc(r.d)} 創 250 日新低`,
      }),
      empty: '最近 5 天沒有股票創一年新低。',
    }),
    listCard('lowbase', {
      title: 'YoY 好看但只是低基期',
      ruleKey: 'lowbase',
      avoid: true,
      row: (r) => ({
        main: pct(r.yoy), cls: 'up', foot: `離近兩年高點 ${pct(r.vs_hi)}`, sub: `${esc(r.m)} 營收`,
      }),
      empty: '最新一個月沒有 YoY >30% 但營收離高點還遠的公司。',
    }),
  ].join('');
}


// --------------------------------------------------------------------------
// 大盤
// --------------------------------------------------------------------------
function taiexCard(t) {
  if (!t) return '<section class="card"><p class="hint">加權指數的資料不足（taiex.json 至少要 70 天）。</p></section>';
  const s = t.series;
  const d60 = (t.c / t.ma60 - 1) * 100;
  const d240 = t.ma240 ? (t.c / t.ma240 - 1) * 100 : null;
  const R60 = rule('ma60');
  const R240 = rule('ma240');
  const RB = rule('black');
  return `<section class="card">
    <h2>加權指數 <small>${esc(t.d)} 收盤 ${fmt(t.c, 0)}</small></h2>
    <p class="rule-level rule-level--${t.hold ? 'ok' : 'warn'}">
      <b>${t.hold ? '照他的季線規則：可以做多' : '照他的季線規則：不做多'}</b>
      <span>收盤跌破季線就出場，季線上揚而且站回才進場。${t.since ? `${esc(t.since)} 起${t.hold ? '站回' : '跌破'}。` : ''}</span>
    </p>
    <div class="stat-grid">
      <div class="stat"><b class="${dir(d60)}">${pct(d60, 1)}</b><span>距季線（${fmt(t.ma60, 0)}）</span></div>
      <div class="stat"><b class="sm">${t.ma60_up ? '往上' : '往下'}</b><span>季線方向（比 5 天前）</span></div>
      <div class="stat"><b class="${dir(d240)}">${pct(d240, 1)}</b><span>距年線${t.ma240 ? `（${fmt(t.ma240, 0)}）` : ''}</span></div>
    </div>
    ${lineChart(s.d, [{ v: s.c, cls: 'cyc-line--mkt' }, { v: s.ma60, cls: 'gy-line--ma60' }, { v: s.ma240, cls: 'gy-line--ma240' }],
      { label: '加權指數與季線、年線' })}
    <p class="gy-keys"><span class="cyc-key cyc-line--mkt">加權指數</span><span class="cyc-key gy-line--ma60">季線</span><span class="cyc-key gy-line--ma240">年線</span></p>
    <ul class="rule-rules">
      <li>${verdictTag(R60.verdict)} <b>${esc(R60.rule)}</b><span>${esc(R60.stat)}。${esc(R60.note)}</span></li>
      <li>${verdictTag(R240.verdict)} <b>${esc(R240.rule)}</b><span>${esc(R240.stat)}。${d240 !== null && d240 < 0
        ? '<b class="rule-good">現在就在年線下。</b>' : '現在在年線上。'}</span></li>
      <li>${verdictTag(RB.verdict)} <b>${esc(RB.rule)}</b><span>${esc(RB.stat)}</span></li>
    </ul>
  </section>`;
}

function marginCard(m) {
  if (!m) return '<section class="card"><p class="hint">融資資料還沒有（scripts/fetch_margin.py、build_margin.py）。</p></section>';
  const s = m.series;
  const R = rule('margin');
  return `<section class="card">
    <h2>融資 <small>${esc(m.d)} · 上市＋上櫃</small></h2>
    <div class="stat-grid">
      <div class="stat"><b>${fmt(m.amt, 0)} 億</b><span>融資餘額（20 日 ${pct(m.chg20, 1)}）</span></div>
      <div class="stat"><b class="${m.mt < 150 ? 'down' : ''}">${fmt(m.mt, 1)}%</b><span>大盤融資維持率</span></div>
      <div class="stat"><b>${fmt(m.sr, 2)}%</b><span>券資比</span></div>
      <div class="stat"><b>${m.pct}</b><span>融資餘額在 ${esc(m.since.slice(0, 7))} 以來的百分位</span></div>
    </div>
    ${lineChart(s.d, [{ v: s.amt, cls: 'cyc-line--mkt' }], { height: 110, label: '融資餘額（億）' })}
    <p class="gy-keys"><span class="cyc-key cyc-line--mkt">融資餘額（億）</span></p>
    ${lineChart(s.d, [{ v: s.mt, cls: 'gy-line--ma60' }], { height: 110, label: '大盤融資維持率（%）' })}
    <p class="gy-keys"><span class="cyc-key gy-line--ma60">大盤融資維持率（%）</span></p>
    ${R ? `<ul class="rule-rules"><li>${verdictTag(R.verdict)} <b>${esc(R.rule)}</b><span>${esc(R.stat)}${R.note ? `。${esc(R.note)}` : ''}</span></li></ul>` : ''}
    <p class="note">維持率官方沒有公布，這裡是 Σ（各檔融資餘額 × 當日收盤）÷ 融資金額，市場上流傳的數字也是這樣估的。
      上市融資成數六成，剛買進時約 166%，跌到 130% 附近開始有追繳、斷頭賣壓。資料期間最低是 ${esc(m.mt_min_d)} 的 ${fmt(m.mt_min, 1)}%。</p>
  </section>`;
}

// --------------------------------------------------------------------------
// 規則
// --------------------------------------------------------------------------
function rulesView() {
  const order = ['ok', 'risk', 'bull', 'weak', 'no'];
  const rules = [...state.data.rules].sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict));
  const count = (v) => rules.filter((r) => r.verdict === v).length;
  return `<section class="card">
    <h2>他講過的規則，資料怎麼說 <small>${rules.length} 條</small></h2>
    <div class="stat-grid">
      <div class="stat"><b class="gy-tone--ok">${count('ok')}</b><span>成立</span></div>
      <div class="stat"><b class="gy-tone--risk">${count('risk') + count('bull')}</b><span>有條件</span></div>
      <div class="stat"><b class="gy-tone--no">${count('no')}</b><span>不成立</span></div>
      <div class="stat"><b>${count('weak')}</b><span>證據不足</span></div>
    </div>
    <ul class="rule-rules gy-rules">
      ${rules.map((r) => `<li>
        <div class="gy-rules__head">${verdictTag(r.verdict)}<small>${esc(r.era)}</small></div>
        <b>${esc(r.rule)}</b>
        <span>${esc(r.stat)}${r.note ? `。${esc(r.note)}` : ''}</span>
      </li>`).join('')}
    </ul>
    <p class="note">「時期」是他在節目裡講這條的年份。成立的條件：同一套算式在 2022 空頭也站得住，或至少分年度都是同一個方向。
      數字是 1 個月左右的超額報酬（減掉同期全體普通股），股價都還原了除權息。完整的表與算法在 BACKTEST.md。</p>
  </section>`;
}

// --------------------------------------------------------------------------
function render() {
  const d = state.data;
  $('#meta').textContent = `資料 ${d.d} · ${d.rules.length} 條規則回測過`;
  const head = `<section class="card"><div class="controls cyc-tabs">${pills('tab', TABS, state.tab)}</div></section>`;
  let body;
  if (state.tab === 'market') body = taiexCard(d.market.taiex) + marginCard(d.market.margin);
  else if (state.tab === 'rules') body = rulesView();
  else body = todayView();
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
    const res = await fetch(`${DATA}/gooaye.json`);
    if (!res.ok) throw new Error(`gooaye.json ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    console.error(err);
    $('#meta').textContent = '載入失敗';
    $('#view').innerHTML = '<p class="hint">資料載不到。這一頁要等 <code>scripts/build_gooaye.py</code> 跑過一次才有東西。</p>';
    return;
  }
  bind();
  render();
}

main();
