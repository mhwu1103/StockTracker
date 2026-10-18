/*
 * 營收（rev.html）：月營收速報。
 *
 * 回答的問題：**這個月誰的營收剛公布、創了新高？股價反應了沒？同一族的其他家呢？**
 *
 *   速報   當月已公布的每一家：年增、月增、新高、連續年增，與公布後的股價反應
 *   族群   題材子族群裡已公布幾家、年增中位數、幾家創新高
 *   自選   排行榜那邊加的自選股（同一份 localStorage），公布了沒、數字如何
 *
 * 全部在 scripts/build_revenue.py 算好，這裡只畫。「營收 12 個月新高 ＋ 股價 60 日新高」是策略頁的
 * 進場條件，這裡把它標出來，但不重算策略（策略另外要流動性，見策略頁）。
 */

const DATA = 'data';
const TABS = [
  { value: 'flash', label: '速報' },
  { value: 'group', label: '族群' },
  { value: 'watch', label: '自選' },
];
const FILTERS = [
  { value: 'hi', label: '12 個月新高' },
  { value: 'all', label: '2019 起新高' },
  { value: 'both', label: '營收＋股價新高' },
  { value: 'yoy30', label: '年增 30% 以上' },
  { value: 'any', label: '全部' },
];
const SORTS = [
  { value: 'pub', label: '公布日' },
  { value: 'yoy', label: '年增' },
  { value: 'react', label: '公布後' },
  { value: 'rev', label: '營收規模' },
];
const PAGE = 30;
const KEYS = { tab: 'stocktracker.revtab', filter: 'stocktracker.revfilter', sort: 'stocktracker.revsort' };
const WATCH_KEY = 'stocktracker.watch';     // 跟排行榜（app.js）同一份自選股

const state = { data: null, tab: 'flash', month: 0, filter: 'hi', sort: 'pub', q: '', more: 1, open: new Set() };

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (v, digits = 2) => (v === null || v === undefined ? '—'
  : Number(v).toLocaleString('zh-TW', { maximumFractionDigits: digits }));
const pct = (v, digits = 0) => {
  if (v === null || v === undefined) return '—';
  if (v > 999) return '>999%';
  const t = Number(v).toFixed(digits);
  return Number(t) === 0 ? `${(0).toFixed(digits)}%` : `${v > 0 ? '+' : ''}${t}%`;
};
const dir = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const md = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '');
const ym = (m) => `${m.slice(0, 4)} 年 ${Number(m.slice(5))} 月`;
const median = (xs) => {
  const s = xs.filter((x) => x !== undefined && x !== null).sort((a, b) => a - b);
  if (!s.length) return null;
  const k = Math.floor(s.length / 2);
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
};

function pills(name, options, current) {
  return `<div class="pills">${options
    .map((o) => `<button class="pill ${o.value === current ? 'active' : ''}" data-${name}="${o.value}">${esc(o.label)}</button>`)
    .join('')}</div>`;
}

function loadWatch() {
  try {
    const raw = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch (err) {
    return [];
  }
}

function save(key, value) {
  try { localStorage.setItem(key, value); } catch (err) { /* 記不住就算了 */ }
}

const block = () => state.data.months[state.month];
const subName = (k) => state.data.subs[k][1];

// 一家公司的一列：主數字是年增，右下是公布後的股價
function revRow(r, B) {
  const tags = [
    r.hiAll ? '<span class="val-good">2019 起新高</span>' : r.hi ? '<span class="val-good">12 個月新高</span>' : '',
    r.nh ? '<span class="val-good">股價 60 日新高</span>' : '',
  ].filter(Boolean).join(' ');
  const sub = [
    `${fmt(r.rev)} 億`,
    `月增 <span class="${dir(r.mom)}">${pct(r.mom)}</span>`,
    r.run >= 2 ? `連 ${r.run} 月年增` : '',
    r.pub ? `${md(r.pub)} 公布` : '',
  ].filter(Boolean).join(' · ');
  const base = r.pub ? '公布後' : `${md(B.deadline)} 起`;
  return `<a class="row gy-row" href="index.html#/stock/${esc(r.c)}">
    <span class="ident">
      <span class="name">${esc(r.n || r.c)}</span>
      <span class="code">${esc(r.c)}${r.ind ? ` · ${esc(r.ind)}` : ''}${r.subs && r.subs.length ? ` · ${esc(subName(r.subs[0]))}` : ''}</span>
      <span class="rev-sub">${sub}${tags ? ` · ${tags}` : ''}</span>
    </span>
    <span class="figures">
      <span class="value ${dir(r.yoy)}">${pct(r.yoy)}</span>
      <span class="price">${base} <span class="${dir(r.react)}">${pct(r.react, 1)}</span></span>
    </span>
  </a>`;
}

function filtered(B) {
  const f = state.filter;
  let rows = B.rows.filter((r) => (f === 'hi' ? r.hi
    : f === 'all' ? r.hiAll
      : f === 'both' ? r.hi && r.nh
        : f === 'yoy30' ? r.yoy >= 30
          : true));
  const key = { yoy: 'yoy', react: 'react', rev: 'rev' }[state.sort];
  if (key) rows = [...rows].sort((a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity));
  return rows;   // 公布日：build 已經排好（新到舊，同一天年增大的在前）
}

function more(rows, render, empty) {
  const shown = rows.slice(0, PAGE * state.more);
  const rest = rows.length - shown.length;
  return `${shown.length ? shown.map(render).join('') : `<p class="hint">${empty}</p>`}
    ${rest > 0 ? `<button class="cyc-morebtn" data-more="1">再列 ${Math.min(PAGE, rest)} 家（還有 ${rest}）</button>` : ''}`;
}

function monthPills() {
  const opts = state.data.months.map((B, k) => ({ value: String(k), label: ym(B.m) }));
  return pills('month', opts, String(state.month));
}

// --------------------------------------------------------------------------
function flashView() {
  const B = block();
  const rows = filtered(B);
  const hi = B.rows.filter((r) => r.hi).length;
  const both = B.rows.filter((r) => r.hi && r.nh).length;
  const yoyMed = median(B.rows.map((r) => r.yoy));
  const up = B.rows.filter((r) => r.yoy > 0).length;
  const today = state.data.today;
  const fresh = today ? B.rows.filter((r) => r.pub === today).length : 0;
  const R = state.data.rules;
  const pending = B.prevCount - B.count;
  return `<section class="card">
    <div class="controls">${monthPills()}</div>
    <div class="stat-grid">
      <div class="stat"><b>${B.count}</b><span>已公布${pending > 0 ? `（上月 ${B.prevCount} 家，還差約 ${pending}）` : ''}</span></div>
      <div class="stat"><b class="${dir(yoyMed)}">${pct(yoyMed, 1)}</b><span>年增中位數 · ${Math.round((up / Math.max(1, B.count)) * 100)}% 年增為正</span></div>
      <div class="stat"><b>${hi}</b><span>創 12 個月新高</span></div>
      <div class="stat"><b>${both}</b><span>營收＋股價都新高</span></div>
    </div>
    ${fresh ? `<p class="note">${md(today)} 新公布 ${fresh} 家。</p>` : ''}
  </section>
  <section class="card">
    <h2>${ym(B.m)}營收 <small>${rows.length} 家</small></h2>
    <div class="controls">${pills('filter', FILTERS, state.filter)}</div>
    <div class="controls">${pills('sort', SORTS, state.sort)}</div>
    <p class="note">右邊大字是年增率；下面是${B.known ? '公布後' : `申報期限 ${md(B.deadline)} 起`}到 ${md(state.data.asof)} 收盤的股價漲跌（還原除權息）。
      「12 個月新高」比前 ${R.hiPrev} 個月都高；「2019 起新高」比 ${esc(R.since)} 以來每個月都高（前面至少 ${R.allMin} 個月）。
      ${B.known < B.count ? `${B.count - B.known} 家在本站開始記公布日之前就已公布，從申報期限（${md(B.deadline)}）算起。` : ''}</p>
    ${more(rows, (r) => revRow(r, B), '沒有符合的公司。')}
  </section>`;
}

function groupView() {
  const B = block();
  const gs = [...B.groups].sort((a, b) => (b.hi / b.got) - (a.hi / a.got) || (b.yoy ?? -1e9) - (a.yoy ?? -1e9));
  const S = state.data.subs;
  return `<section class="card">
    <div class="controls">${monthPills()}</div>
    <h2>族群 <small>${gs.length} 個子族群 · 依創新高的比例排</small></h2>
    <p class="note">同一族裡，一家營收亮眼、股價先動，另外幾家常被拿來比。每一列是子族群裡<b>已公布</b>的家數、
      年增中位數與創 12 個月新高的家數；點開看成員。公布後漲跌是中位數。</p>
    ${gs.map((g) => {
      const [gn, sn] = S[g.k];
      const open = state.open.has(String(g.k));
      const rows = open ? B.rows.filter((r) => r.subs && r.subs.includes(g.k)) : [];
      return `<button class="row gy-row rev-grp" data-grp="${g.k}" aria-expanded="${open}">
        <span class="ident">
          <span class="name">${esc(sn)}</span>
          <span class="code">${esc(gn)} · 已公布 ${g.got}/${g.n} · ${g.hi} 家新高 · ${g.up} 家年增為正</span>
        </span>
        <span class="figures"><span class="value ${dir(g.yoy)}">${pct(g.yoy, 1)}</span>
          <span class="price">${B.known ? '公布後' : `${md(B.deadline)} 起`} <span class="${dir(g.react)}">${pct(g.react, 1)}</span></span></span>
      </button>
      ${open ? `<div class="rev-members">${rows.sort((a, b) => (b.yoy ?? -1e9) - (a.yoy ?? -1e9)).map((r) => revRow(r, B)).join('')}</div>` : ''}`;
    }).join('')}
  </section>`;
}

function watchView() {
  const B = block();
  const codes = loadWatch();
  const by = new Map(B.rows.map((r) => [r.c, r]));
  const got = codes.filter((c) => by.has(c)).map((c) => by.get(c));
  const wait = codes.filter((c) => !by.has(c));
  return `<section class="card">
    <div class="controls">${monthPills()}</div>
    <h2>自選股 <small>${codes.length} 檔 · 已公布 ${got.length}</small></h2>
    ${codes.length
      ? `${got.map((r) => revRow(r, B)).join('')}
         ${wait.length ? `<p class="note">還沒公布（或不是普通股）：${wait.map(esc).join('、')}</p>` : ''}`
      : '<p class="hint">還沒有自選股。在排行榜任一列點星號加入，這裡就會列出它們的營收。</p>'}
    <p class="note">自選股存在這台裝置的瀏覽器裡，跟排行榜共用。Telegram 推播的自選股另外設定（WATCHLIST），
      有設定的話，自選股公布營收的那一天也會推播。</p>
  </section>`;
}

function searchView() {
  const B = block();
  const q = state.q.trim().toLowerCase();
  const hits = B.rows.filter((r) => r.c.startsWith(q) || (r.n || '').toLowerCase().includes(q)
    || (r.ind || '').toLowerCase().includes(q));
  return `<section class="card">
    <div class="controls">${monthPills()}</div>
    <h2>搜尋 <small>${hits.length} 家</small></h2>
    ${more(hits, (r) => revRow(r, B), '找不到。可能還沒公布，或不是普通股。')}
  </section>`;
}

// --------------------------------------------------------------------------
function render() {
  const d = state.data;
  const B = block();
  $('#meta').textContent = `${ym(B.m)}營收 ${B.count} 家 · 收盤 ${d.asof}`;
  if (state.q.trim()) {
    $('#view').innerHTML = searchView();
    return;
  }
  const head = `<section class="card"><div class="controls cyc-tabs">${pills('tab', TABS, state.tab)}</div></section>`;
  const body = state.tab === 'group' ? groupView() : state.tab === 'watch' ? watchView() : flashView();
  $('#view').innerHTML = head + body;
}

function bind() {
  $('#view').addEventListener('click', (ev) => {
    const el = ev.target.closest('button');
    if (!el) return;
    const ds = el.dataset;
    if (ds.tab) {
      state.tab = ds.tab;
      save(KEYS.tab, ds.tab);
    } else if (ds.month) {
      state.month = Number(ds.month);
      state.more = 1;
    } else if (ds.filter) {
      state.filter = ds.filter;
      state.more = 1;
      save(KEYS.filter, ds.filter);
    } else if (ds.sort) {
      state.sort = ds.sort;
      state.more = 1;
      save(KEYS.sort, ds.sort);
    } else if (ds.more) {
      state.more += 1;
    } else if (ds.grp) {
      if (state.open.has(ds.grp)) state.open.delete(ds.grp);
      else state.open.add(ds.grp);
    } else {
      return;
    }
    render();
  });
  const input = $('#q');
  input.addEventListener('input', () => {
    state.q = input.value;
    state.more = 1;
    render();
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && input.value) {
      input.value = '';
      state.q = '';
      render();
    }
  });
}

function restore() {
  try {
    const pick = (key, list) => {
      const v = localStorage.getItem(key);
      return list.some((o) => o.value === v) ? v : null;
    };
    state.tab = pick(KEYS.tab, TABS) || state.tab;
    state.filter = pick(KEYS.filter, FILTERS) || state.filter;
    state.sort = pick(KEYS.sort, SORTS) || state.sort;
  } catch (err) { /* 讀不到就用預設 */ }
}

async function main() {
  restore();
  try {
    const res = await fetch(`${DATA}/revenue.json`);
    if (!res.ok) throw new Error(`revenue.json ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    console.error(err);
    $('#meta').textContent = '載入失敗';
    $('#view').innerHTML = '<p class="hint">資料載不到。這一頁要等 <code>scripts/build_revenue.py</code> 跑過一次才有東西。</p>';
    return;
  }
  bind();
  render();
}

main();
