/*
 * 美股 × 台股連動（us.html）。
 *
 * 這是一個獨立的頁面，不是排行榜那支 SPA 的分頁：它只讀 data/us/index.json 一份檔案，
 * 不需要交易日、範圍、基準日那一整套狀態，混進去只會讓兩邊都變複雜。
 * 共用的只有 style.css。
 *
 * 頁面回答的問題：昨晚哪幾檔美股在動、它們跟台股的哪幾檔真的綁在一起。
 *
 * 兩個相關性都是「美股 D 日 → 台股 D 之後第一個交易日」的日報酬相關係數：
 *   r  原始相關
 *   x  超額相關（兩邊各自扣掉自己市場的大盤之後再算）
 * 定義與限制寫在 scripts/us.py 的 docstring，數字由 scripts/build_us.py 算好，
 * 這裡只負責顯示——前端不做任何統計。
 */

const DATA = 'data';
const APP_VERSION = (() => {
  const src = document.currentScript?.src || '';
  return new URL(src, location.href).searchParams.get('v') || '?';
})();

const SORTS = [
  { value: 'corr', label: '依相關性' },
  { value: 'chg', label: '依昨夜漲跌' },
  { value: 'code', label: '依代號' },
];

const state = {
  data: null,
  span: 60,          // 相關性的觀察窗（交易日）
  sort: 'corr',
  open: new Set(),   // 展開中的美股代號，重畫之後要留著
};

const SPAN_KEY = 'stocktracker.usspan';
const SORT_KEY = 'stocktracker.ussort';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v, digits = 1) => (v === null || v === undefined
  ? '—'
  : v.toLocaleString('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const trend = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const signedPct = (v, digits = 2) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${num(v, digits)}%`);
const tint = (v, text) => `<em class="${trend(v)}">${text}</em>`;
const STARS = { 3: '★★★', 2: '★★☆', 1: '★☆☆' };

/** 相關性一律寫成整數百分比；沒有數字的那一格要看得出是「算不出來」而不是 0。 */
const corrText = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v}%`);

function pills(name, options, current) {
  return `<div class="pills">${options
    .map((o) => `<button class="pill ${o.value === current ? 'active' : ''}" data-${name}="${o.value}">${esc(o.label)}</button>`)
    .join('')}</div>`;
}

// --------------------------------------------------------------------------
// 取數
//
// cols 的長相是 [code, name, label, s, r20, x20, r60, x60, r120, x120, n]：
// 每個觀察窗兩欄、原始在前超額在後。欄位順序由 build_us.py 決定，這裡照 spans 算位置，
// 不要寫死 —— 以後多加一個觀察窗時才不用兩邊一起改。
// --------------------------------------------------------------------------
const colAt = (span, kind) => 4 + state.data.spans.indexOf(span) * 2 + (kind === 'x' ? 1 : 0);
const corrOf = (row, kind = 'r') => row[colAt(state.span, kind)];

/** 這一檔美股在目前觀察窗下的中位相關；沒有任何一組算得出來就回 null。 */
function midOf(item) {
  const vals = item.links.map((r) => corrOf(r)).filter((v) => v !== null && v !== undefined);
  if (!vals.length) return null;
  const sorted = vals.slice().sort((a, b) => a - b);
  return sorted[(sorted.length - 1) >> 1];
}

function sortedItems() {
  const items = state.data.items.slice();
  const byMid = (a, b) => {
    const [x, y] = [midOf(a), midOf(b)];
    if (x === null) return 1;
    if (y === null) return -1;
    return y - x;
  };
  if (state.sort === 'chg') {
    return items.sort((a, b) => (b.chg?.d1 ?? -Infinity) - (a.chg?.d1 ?? -Infinity));
  }
  if (state.sort === 'code') return items.sort((a, b) => a.t.localeCompare(b.t));
  return items.sort(byMid);
}

// --------------------------------------------------------------------------
// 畫面
// --------------------------------------------------------------------------

/** 相關性的長條。負相關往左畫，跟族群頁的資金流向同一套視覺語言。 */
function corrBar(v) {
  if (v === null || v === undefined) return '<span class="corr-bar"></span>';
  const w = Math.min(Math.abs(v), 100) / 2;      // 100% 對應半格，左右各一半
  return `<span class="corr-bar"><i class="${trend(v)}" style="${v >= 0
    ? `left:50%;width:${w}%`
    : `right:50%;width:${w}%`}"></i></span>`;
}

function benchCard(data) {
  const idx = data.spans.indexOf(state.span);
  const rows = data.bench.map((b) => `<div class="row">
      <div class="rank"><span class="no sm">${esc(b.t)}</span></div>
      <div class="ident"><span class="name">${esc(b.n)}</span>
        <span class="code">${esc(b.why)}</span></div>
      <div class="figures"><span class="value ${trend(b.chg?.d1)}">${signedPct(b.chg?.d1)}</span>
        <span class="price">與台股加權 <em class="${trend(b.twr[idx])}">${corrText(b.twr[idx])}</em></span></div>
    </div>`).join('');
  return `<section class="card">
    <h2>大盤層級 <small>不屬於任何一族</small></h2>
    ${rows}
    <p class="note">這幾個不配個股，只跟台股加權指數對一次。
      ^TWII 那一列是台股自己對自己，永遠是 +100%，留著是為了讓其他幾列有個比較的基準。</p>
  </section>`;
}

function linkRow(row, labels) {
  const [code, name, label, s] = row;
  const r = corrOf(row, 'r');
  const x = corrOf(row, 'x');
  return `<a class="row" href="index.html#/stock/${esc(code)}">
      <div class="rank"><span class="no sm ${trend(r)}">${corrText(r)}</span>
        ${corrBar(r)}</div>
      <div class="ident"><span class="name">${esc(name)}</span>
        <span class="code">${esc(code)} · ${esc(labels[label] || '')}</span></div>
      <div class="figures"><span class="value sm">超額 ${tint(x, corrText(x))}</span>
        <span class="price">標註 ${STARS[s] || ''} · ${row[row.length - 1]} 天</span></div>
    </a>`;
}

function itemRow(item) {
  const mid = midOf(item);
  const chg = item.chg || {};
  const summary = `<div class="rank"><span class="no sm ${trend(mid)}">${corrText(mid)}</span>
        <span class="delta">中位</span></div>
      <div class="ident"><span class="name">${esc(item.t)} ${esc(item.n)}</span>
        <span class="code">${item.links.length} 檔對照${item.pairs > item.links.length
          ? `（共 ${item.pairs}）` : ''} · 收 ${num(item.last, 2)}</span></div>
      <div class="figures"><span class="value ${trend(chg.d1)}">${signedPct(chg.d1)}</span>
        <span class="price">週 ${tint(chg.w1, signedPct(chg.w1, 1))}
          · 月 ${tint(chg.m1, signedPct(chg.m1, 1))}
          · 年 ${tint(chg.y1, signedPct(chg.y1, 1))}</span></div>`;
  return `<details class="sector" ${state.open.has(item.t) ? 'open' : ''}>
    <summary class="row">${summary}</summary>
    <div class="sector__body" data-us="${esc(item.t)}"></div>
  </details>`;
}

/** 一句話：這一頁最想讓人知道的是「標註對不對得上資料」。 */
function lede(data, items) {
  const all = [];
  for (const item of items) {
    for (const row of item.links) {
      const r = corrOf(row);
      if (r !== null && r !== undefined) all.push({ item, row, r });
    }
  }
  all.sort((a, b) => b.r - a.r);
  const top = all[0];
  const stars = all.filter((p) => p.row[3] === 3);
  const worst = stars[stars.length - 1];
  const mids = items.map(midOf).filter((v) => v !== null).sort((a, b) => a - b);
  const median = mids.length ? mids[(mids.length - 1) >> 1] : null;

  const who = (p) => `<b>${esc(p.item.t)}</b> × <b>${esc(p.row[1])}</b>`;
  const stats = [
    { b: esc(data.asof), span: '美股收盤日', cls: 'sm' },
    { b: esc(data.twAsof), span: '台股最後交易日', cls: 'sm' },
    { b: `${items.length} 檔`, span: '美股', cls: 'sm' },
    { b: corrText(median), span: `${state.span} 日相關中位數`, cls: `sm ${trend(median)}` },
  ];
  const sentence = `以最近 ${state.span} 個交易日算，人工標註的 ${data.items.reduce((n, i) => n + i.pairs, 0)}
    組配對裡，連動最強的是 ${who(top)}（${tint(top.r, corrText(top.r))}）。
    ${worst ? `標了 ★★★ 卻最弱的是 ${who(worst)}（${tint(worst.r, corrText(worst.r))}）——
    標註是憑供應鏈關係給的，資料不同意的時候以資料為準。` : ''}`;
  const note = `相關性是「一起漲一起跌的程度」，不是因果，更不是幅度：
    +50% 不代表美股漲 1% 台股就會漲 0.5%。`;
  return `<section class="card takeaway">
    <h2>一句話 <small>美股 ${esc(data.asof)} 收盤 · 台股至 ${esc(data.twAsof)}</small></h2>
    <p class="lede">${sentence}</p>
    <div class="stat-grid">${stats
      .map((s) => `<div class="stat"><b class="${s.cls || ''}">${s.b}</b><span>${s.span}</span></div>`)
      .join('')}</div>
    <p class="note">${note}</p>
  </section>`;
}

function methodNote(data) {
  return `<section class="card">
    <h2>怎麼算的 <small>看數字之前先讀這一段</small></h2>
    <p class="note">
      <b>對齊方式</b>：美股 D 日的日報酬，對上台股「D 之後第一個交易日」的日報酬。
      美股收盤在台股開盤之前，因果方向只有這一個；擺在同一個日曆日是錯的。<br>
      <b>原始相關（r）</b>：兩邊日報酬的皮爾森相關係數。會被「整個市場一起動」灌水——
      台股電子股彼此本來就有五、六成的相關，對上任何一檔美股大型股都不會太難看。<br>
      <b>超額相關（超額）</b>：兩邊各自先扣掉自己市場的大盤（台股扣 ^TWII、美股扣 ^IXIC）再算。
      抽掉共同的市場因子之後，剩下的才是這一對自己的關係。
      <b>但權值股要打折看</b>：台積電自己就佔台股加權指數約三成，扣大盤等於把它自己扣掉一大半，
      超額相關會被壓成負的——那是算法的限制，不是它跟美股脫鉤。<br>
      <b>樣本範圍</b>：台股價格取自 <code>data/kline/</code>，只從 ${esc(data.from)} 開始
      （全市場四價是後來才存的），所以最長就到 ${Math.max(...data.spans)} 日，再長沒有資料。
      對齊後少於 ${data.minPoints} 天的配對不給數字。<br>
      <b>配對的範圍</b>：來自人工維護的 <code>data/us_link.json</code>，
      只算那份對照表畫出來的組合，不是拿每一檔美股去掃全市場。
      標 ★★★ 的配對一律列出（不管相關性排第幾），其餘每檔美股最多列前幾名。<br>
      <b>更新</b>：美股日線 <code>scripts/fetch_us.py</code>、相關性 <code>scripts/build_us.py</code>，
      兩支都是手動執行，沒有接進每日排程。這一份算於 ${esc(data.updated.slice(0, 16).replace('T', ' '))}。
    </p>
  </section>`;
}

function render() {
  const data = state.data;
  const items = sortedItems();
  const spanOpts = data.spans.map((s) => ({ value: String(s), label: `${s} 日` }));

  $('#meta').innerHTML = `美股 ${esc(data.asof)} 收盤 · 台股至 ${esc(data.twAsof)}
    · 相關性取最近 ${state.span} 個交易日`;

  $('#view').innerHTML = `
    ${lede(data, items)}
    <div class="controls">${pills('span', spanOpts, String(state.span))}</div>
    <div class="controls">${pills('sort', SORTS, state.sort)}</div>
    ${benchCard(data)}
    <section class="card">
      <h2>美股 <small>${items.length} 檔 · 點一列展開它對照的台股</small></h2>
      ${items.map(itemRow).join('')}
      <p class="note">左邊的百分比是這一檔美股對它所有對照台股的<b>相關性中位數</b>，
        右邊是它自己的漲跌幅（昨夜／週／月／年）。展開後每一列是一檔台股，
        點進去會回到排行榜的個股頁。</p>
    </section>
    ${methodNote(data)}`;

  const byTicker = new Map(items.map((i) => [i.t, i]));
  const fill = (el) => {
    const box = $('.sector__body', el);
    if (box.innerHTML) return;
    const item = byTicker.get(box.dataset.us);
    box.innerHTML = item.links.map((row) => linkRow(row, data.labels)).join('');
  };
  $('#view').querySelectorAll('details.sector').forEach((el) => {
    if (el.open) fill(el);
    el.addEventListener('toggle', () => {
      const name = $('.sector__body', el).dataset.us;
      el.open ? state.open.add(name) : state.open.delete(name);
      if (el.open) fill(el);
    });
  });
}

// --------------------------------------------------------------------------
// 啟動
// --------------------------------------------------------------------------
document.addEventListener('click', (ev) => {
  const pill = ev.target.closest('.pill');
  if (!pill) return;
  if (pill.dataset.span) {
    state.span = Number(pill.dataset.span);
    try { localStorage.setItem(SPAN_KEY, String(state.span)); } catch (err) { /* 無痕模式 */ }
  } else if (pill.dataset.sort) {
    state.sort = pill.dataset.sort;
    try { localStorage.setItem(SORT_KEY, state.sort); } catch (err) { /* 無痕模式 */ }
  } else {
    return;
  }
  render();
});

async function start() {
  try {
    const res = await fetch(`${DATA}/us/index.json`, { cache: 'reload' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    $('#meta').textContent = '載入失敗';
    $('#view').innerHTML = `<p class="hint">讀不到 <code>data/us/index.json</code>（${esc(err.message)}）。
      這一份不由每日排程產生，請先執行
      <code>python scripts/fetch_us.py</code> 與 <code>python scripts/build_us.py</code>。
      前端版本 ${esc(APP_VERSION)}。</p>`;
    return;
  }
  try {
    const span = Number(localStorage.getItem(SPAN_KEY));
    if (state.data.spans.includes(span)) state.span = span;
    const sort = localStorage.getItem(SORT_KEY);
    if (SORTS.some((s) => s.value === sort)) state.sort = sort;
  } catch (err) {
    /* 讀不到就用預設值 */
  }
  render();
}

start();
