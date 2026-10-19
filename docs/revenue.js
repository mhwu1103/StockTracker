/*
 * 營收（rev.html）：月營收速報。
 *
 * 回答的問題：**這個月誰的營收剛公布、創了新高？股價反應了沒？同一族的其他家呢？**
 *
 * 月份（最近 24 個月）用下拉選單切，每個月一個檔、切到才抓。
 *
 *   速報   當月已公布的每一家：年增、月增、新高、連續年增，與公布後的股價反應
 *   族群   題材子族群裡已公布幾家、年增中位數、幾家創新高
 *   自選   排行榜那邊加的自選股（同一份 localStorage），公布了沒、數字如何
 *   公告   財報（單季淨利年增 × 開盤反應的訊號）與法說會日曆，不分月份；資料是 events/page.json
 *          （scripts/build_events.py），切到這一頁才抓
 *
 * 全部在 scripts/build_revenue.py 算好，這裡只畫。「營收 12 個月新高 ＋ 股價 60 日新高」是策略頁的
 * 進場條件，這裡把它標出來，但不重算策略（策略另外要流動性，見策略頁）。
 */

const DATA = 'data';
const TABS = [
  { value: 'flash', label: '速報' },
  { value: 'group', label: '族群' },
  { value: 'watch', label: '自選' },
  { value: 'events', label: '公告' },
];
const EV_FILTERS = [
  { value: 'live', label: '訊號進行中' },
  { value: 'good', label: '好財報＋開高' },
  { value: 'bad', label: '壞財報＋開低' },
  { value: 'watch', label: '自選股' },
  { value: 'all', label: '全部財報' },
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
const KEYS = { tab: 'stocktracker.revtab', filter: 'stocktracker.revfilter', sort: 'stocktracker.revsort',
  evf: 'stocktracker.revevf' };
const WATCH_KEY = 'stocktracker.watch';     // 跟排行榜（app.js）同一份自選股

const state = { data: null, tab: 'flash', month: 0, filter: 'hi', sort: 'pub', evf: 'live', q: '', more: 1, open: new Set() };

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

// 每個月一個檔（build_revenue.py），切到那個月才抓。null = 載不到
const monthData = {};

function block() {
  const meta = state.data.months[state.month];
  const got = monthData[meta.m];
  return got ? { ...meta, ...got } : null;
}

async function loadMonth(m) {
  if (m in monthData) return;
  monthData[m] = undefined;
  try {
    const res = await fetch(`${DATA}/revenue/${m}.json`);
    if (!res.ok) throw new Error(`${m} ${res.status}`);
    monthData[m] = await res.json();
  } catch (err) {
    console.error(err);
    monthData[m] = null;
  }
}
const subName = (k) => state.data.subs[k][1];

// 一家公司的一列：主數字是年增，右下是公布後的股價
function revRow(r, B) {
  const tags = [
    r.hiAll ? '<span class="val-good">2019 起新高</span>' : r.hi ? '<span class="val-good">12 個月新高</span>' : '',
    r.nh ? '<span class="val-good">股價 60 日新高</span>' : '',
    r.low ? '<span class="val-trap" title="去年同月營收不到它前 12 個月平均的三成、或不到 1,000 萬，年增率是小分母灌大的">低基期</span>' : '',
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

// 建設公司完工交屋才一次認列營收，沒交屋的月份幾乎是零：年增率動輒幾千幾萬 %、「新高」只是交屋的時間點。
// 跟其他產業擺在一起會霸佔年增排序與新高清單，所以速報分開放，統計數字也不算它們。
const LUMPY = '建材營造';
const isLumpy = (r) => r.ind === LUMPY;

function filtered(B) {
  const f = state.filter;
  let rows = B.rows.filter((r) => !isLumpy(r)).filter((r) => (f === 'hi' ? r.hi
    : f === 'all' ? r.hiAll
      : f === 'both' ? r.hi && r.nh
        : f === 'yoy30' ? r.yoy >= 30
          : true));
  const key = { yoy: 'yoy', react: 'react', rev: 'rev' }[state.sort];
  if (key) rows = [...rows].sort((a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity));
  // 依年增排的時候，低基期的放到最後：它們的年增率是小分母灌大的，擺在最前面會蓋掉真的成長
  if (key === 'yoy') rows = [...rows.filter((r) => !r.low), ...rows.filter((r) => r.low)];
  return rows;   // 公布日：build 已經排好（新到舊，同一天年增大的在前）
}

function more(rows, render, empty) {
  const shown = rows.slice(0, PAGE * state.more);
  const rest = rows.length - shown.length;
  return `${shown.length ? shown.map(render).join('') : `<p class="hint">${empty}</p>`}
    ${rest > 0 ? `<button class="cyc-morebtn" data-more="1">再列 ${Math.min(PAGE, rest)} 家（還有 ${rest}）</button>` : ''}`;
}

// 十二個月攤成藥丸在手機上要三排，所以用下拉選單；兩邊各一顆按鈕一次跳一個月。
// months[0] 是最新的，所以「上個月」是索引 +1、「下個月」是 −1；到頭的那一顆停用。
function monthPills() {
  const n = state.data.months.length;
  const step = (d, label, title) => {
    const k = state.month + d;
    return `<button class="pill rev-step" data-step="${d}" title="${title}" aria-label="${title}" ${k < 0 || k >= n ? 'disabled' : ''}>${label}</button>`;
  };
  return `<div class="rev-months">${step(1, '‹ 上個月', '看上一個月的營收')}
    <select class="rev-month" aria-label="月份">${state.data.months
    .map((B, k) => `<option value="${k}" ${k === state.month ? 'selected' : ''}>${ym(B.m)}營收${k === 0 ? '（最新）' : ''}</option>`)
    .join('')}</select>
    ${step(-1, '下個月 ›', '看下一個月的營收')}</div>`;
}

// --------------------------------------------------------------------------
function flashView() {
  const B = block();
  const rows = filtered(B);
  const main = B.rows.filter((r) => !isLumpy(r));
  const lumpy = B.rows.filter(isLumpy).sort((a, b) => b.rev - a.rev);
  const hi = main.filter((r) => r.hi).length;
  const both = main.filter((r) => r.hi && r.nh).length;
  const yoyMed = median(main.map((r) => r.yoy));
  const up = main.filter((r) => r.yoy > 0).length;
  const today = state.data.today;
  const fresh = today ? B.rows.filter((r) => r.pub === today).length : 0;
  const R = state.data.rules;
  const pending = state.month === 0 ? B.prevCount - B.count : 0;   // 過去的月份早就報齊，差的是下市或停報
  return `<section class="card">
    <div class="controls">${monthPills()}</div>
    <div class="stat-grid">
      <div class="stat"><b>${B.count}</b><span>已公布${pending > 0 ? `（上月 ${B.prevCount} 家，還差約 ${pending}）` : ''}</span></div>
      <div class="stat"><b class="${dir(yoyMed)}">${pct(yoyMed, 1)}</b><span>年增中位數 · ${Math.round((up / Math.max(1, main.length)) * 100)}% 年增為正</span></div>
      <div class="stat"><b>${hi}</b><span>創 12 個月新高</span></div>
      <div class="stat"><b>${both}</b><span>營收＋股價都新高</span></div>
    </div>
    <p class="note">${fresh ? `${md(today)} 新公布 ${fresh} 家。` : ''}年增中位數與新高家數不含${LUMPY}（${lumpy.length} 家，放在最下面）。</p>
  </section>
  <section class="card">
    <h2>${ym(B.m)}營收 <small>${rows.length} 家</small></h2>
    <div class="controls">${pills('filter', FILTERS, state.filter)}</div>
    <div class="controls">${pills('sort', SORTS, state.sort)}</div>
    <p class="note">右邊大字是年增率；下面是${B.known ? '公布後' : `申報期限 ${md(B.deadline)} 起`}到 ${md(B.end)} 收盤的股價漲跌（還原除權息）${state.month ? '——過去的月份算到下一次營收申報期限為止，數字固定不再變' : ''}。
      「低基期」是去年同月營收不到它前 12 個月平均的 ${Math.round((R.lowBase || 0.3) * 100)}%、或不到 1,000 萬，依年增排時放在最後。
      「12 個月新高」比前 ${R.hiPrev} 個月都高；「2019 起新高」比 ${esc(R.since)} 以來每個月都高（前面至少 ${R.allMin} 個月）。
      ${B.known < B.count ? `${B.count - B.known} 家在本站開始記公布日之前就已公布，從申報期限（${md(B.deadline)}）算起。` : ''}</p>
    ${more(rows, (r) => revRow(r, B), '沒有符合的公司。')}
  </section>
  ${lumpy.length ? `<section class="card">
    <details class="rev-lumpy">
      <summary><h2>${LUMPY} <small>${lumpy.length} 家 · 依營收規模排</small></h2></summary>
      <p class="note">建設公司要等完工交屋，營收才一次入帳，沒交屋的月份幾乎是零。所以年增率常是幾千、幾萬 %，
        「新高」反映的是交屋的時間點，不是生意變好——這裡只看這個月入帳多少，不跟其他產業一起排。</p>
      ${lumpy.map((r) => revRow(r, B)).join('')}
    </details>
  </section>` : ''}`;
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
// 公告：events/page.json（build_events.py）。undefined = 還沒抓、false = 抓取中、null = 載不到
let events;

async function loadEvents() {
  if (events !== undefined) return;
  events = false;
  try {
    const res = await fetch(`${DATA}/events/page.json`);
    if (!res.ok) throw new Error(`events/page.json ${res.status}`);
    events = await res.json();
  } catch (err) {
    console.error(err);
    events = null;
  }
}

const growth = (g) => (typeof g === 'string' ? g : `單季淨利 ${pct(g)}`);
const live = (r) => r.sig && r.held <= events.rules.hold;
const weekday = (d) => '日一二三四五六'[new Date(`${d}T12:00:00+08:00`).getDay()];

function finRow(r) {
  const H = events.rules.hold;
  const tag = r.sig === 'good' ? '<span class="val-good">好財報＋開高</span>'
    : r.sig === 'bad' ? '<span class="val-trap">壞財報＋開低</span>' : '';
  const when = r.react === undefined ? '明天開盤進場'
    : r.sig ? (r.held <= H ? `第 ${r.held}/${H} 天` : `已滿 ${H} 天`) : '';
  const sub = [
    esc(r.q),
    r.g !== undefined ? growth(r.g) : '去年同季沒得比',
    r.eps !== undefined ? `累計 EPS ${fmt(r.eps)}` : '',
    `${md(r.d)} ${esc(r.t)} 公布`,
  ].filter(Boolean).join(' · ');
  return `<a class="row gy-row" href="index.html#/stock/${esc(r.c)}">
    <span class="ident">
      <span class="name">${esc(r.n || r.c)}</span>
      <span class="code">${esc(r.c)}${tag ? ` · ${tag}` : ''}${when ? ` · ${when}` : ''}</span>
      <span class="rev-sub">${sub}</span>
    </span>
    <span class="figures">
      <span class="value ${dir(r.ret)}">${r.ret === undefined ? '—' : pct(r.ret, 1)}</span>
      <span class="price">開盤 <span class="${dir(r.react)}">${r.react === undefined ? '—' : pct(r.react, 1)}</span></span>
    </span>
  </a>`;
}

function confRow(r) {
  const sub = [
    r.t ? esc(r.t) : '',
    r.end ? `到 ${md(r.end)}` : '',
    r.host,
    r.ann ? `${md(r.ann)} 公告` : '',
  ].filter(Boolean).join(' · ');
  return `<a class="row gy-row" href="index.html#/stock/${esc(r.c)}">
    <span class="ident">
      <span class="name">${esc(r.n || r.c)}</span>
      <span class="code">${esc(r.c)} · ${sub}</span>
      <span class="rev-sub">${esc(r.note || '')}</span>
    </span>
    <span class="figures">
      <span class="value ${dir(r.pre)}">${r.pre === undefined ? '—' : pct(r.pre, 1)}</span>
      <span class="price">會前</span>
    </span>
  </a>`;
}

function finPick(q) {
  const f = state.evf;
  let rows = events.fin;
  if (q) return rows.filter((r) => r.c.startsWith(q) || (r.n || '').toLowerCase().includes(q));
  if (f === 'live') rows = rows.filter(live);
  else if (f === 'good' || f === 'bad') rows = rows.filter((r) => r.sig === f);
  else if (f === 'watch') {
    const watch = new Set(loadWatch());
    rows = rows.filter((r) => watch.has(r.c));
  }
  return rows;
}

function eventsView() {
  if (!events) {
    return `<section class="card"><p class="hint">${events === null
      ? '公告資料載不到。這一頁要等 <code>scripts/build_events.py</code> 跑過一次才有東西。' : '載入中…'}</p></section>`;
  }
  const R = events.rules;
  const q = state.q.trim().toLowerCase();
  const rows = finPick(q);
  const good = events.fin.filter((r) => r.sig === 'good');
  const bad = events.fin.filter((r) => r.sig === 'bad');
  const done = (xs) => xs.filter((r) => r.held >= R.hold);
  const medGood = median(done(good).map((r) => r.ret));
  const medBad = median(done(bad).map((r) => r.ret));
  const today = events.today;
  const conf = q ? events.conf.filter((r) => r.c.startsWith(q) || (r.n || '').toLowerCase().includes(q)) : events.conf;
  const byDay = new Map();
  for (const r of conf) {
    if (!byDay.has(r.d)) byDay.set(r.d, []);
    byDay.get(r.d).push(r);
  }
  return `<section class="card">
    <h2>財報 <small>最近 ${R.recent} 個交易日進場的 ${events.fin.length} 則</small></h2>
    <div class="stat-grid">
      <div class="stat"><b>${good.filter(live).length}</b><span>好財報＋開高 · 進行中</span></div>
      <div class="stat"><b>${bad.filter(live).length}</b><span>壞財報＋開低 · 進行中</span></div>
      <div class="stat"><b class="${dir(medGood)}">${pct(medGood, 1)}</b><span>好的 ${done(good).length} 則滿 ${R.hold} 天 · 中位數</span></div>
      <div class="stat"><b class="${dir(medBad)}">${pct(medBad, 1)}</b><span>壞的 ${done(bad).length} 則滿 ${R.hold} 天 · 中位數</span></div>
    </div>
    ${q ? '' : `<div class="controls">${pills('evf', EV_FILTERS, state.evf)}</div>`}
    <p class="note">「好財報＋開高」：單季歸屬母公司淨利比去年同季多 ${R.grow}% 以上（或轉盈），公布後第一個開盤漲 ${R.react}% 以上；
      「壞財報＋開低」反過來（年減 ${R.grow}% 以上或轉虧、開低 ${R.react}% 以上）。右邊大字是那個開盤進場、抱到第 ${R.hold} 個交易日
      （還沒滿就是到最新收盤）的漲跌，還原除權息。
      回測（2023～2026，跟同一天、近 60 日漲幅相近的股票比）：好的 ${R.hold} 日多 +3.1%（中位數 +2.4%、60% 贏），
      壞的少 2.5%（只有 40% 贏），每一年都同方向。沒扣交易成本。</p>
    ${more(rows, finRow, q ? '找不到這檔的財報。'
    : state.evf === 'live' ? `現在沒有進行中的訊號——兩季財報之間（5/15、8/14、11/14、3/31 是申報期限）。
        上一季的結果看「好財報＋開高」「壞財報＋開低」。` : '沒有符合的財報。')}
  </section>
  <section class="card">
    <h2>法說會 <small>${conf.length} 場${conf.length ? ` · ${md(conf[0].d)}～${md(conf[conf.length - 1].d)}` : ''}</small></h2>
    <p class="note">右邊是<b>會前</b>：重大訊息公告要開法說會的隔天開盤，到召開日收盤（還沒開就是到最新收盤）。回測 2021-10 起
      1 萬多場，平均 8 個交易日、比近 60 日漲幅相近的股票多 1.5%（中位數 0.8%、58% 贏），五年都是正的，
      但扣掉來回成本（約 0.6%）剩不多。會後才買沒有效果。只在法說會一覽表上、沒發重大訊息的，沒有會前數字。</p>
    ${[...byDay].map(([d, xs]) => `<h3 class="ev-day${d < today ? ' ev-day--past' : ''}">${md(d)}（${weekday(d)}）${d === today ? ' · 今天' : ''}
      <small>${xs.length} 場</small></h3>${xs.map(confRow).join('')}`).join('') || '<p class="hint">這段期間沒有法說會。</p>'}
  </section>
  <section class="card">
    <p class="note">公告來自公開資訊觀測站的每日重大訊息（財報、法說會公告）與法說會一覽表，每天收盤後更新。
      自結損益（金融股每月自結盈餘等）、達注意標準而公布的財務資訊也測過，沒有效果，這裡不列。
      代子公司公告的財報不算（數字是子公司的）。</p>
  </section>`;
}

// --------------------------------------------------------------------------
function render() {
  const d = state.data;
  const head = `<section class="card"><div class="controls cyc-tabs">${pills('tab', TABS, state.tab)}</div></section>`;
  if (state.tab === 'events') {
    if (events === undefined) loadEvents().then(render);
    if (events) $('#meta').textContent = `公告 · 收盤 ${events.asof}`;
    $('#view').innerHTML = head + eventsView();
    return;
  }
  const meta = d.months[state.month];
  if (!(meta.m in monthData)) {
    loadMonth(meta.m).then(render);
  }
  const B = block();
  if (!B) {
    $('#view').innerHTML = `<section class="card"><div class="controls">${monthPills()}</div>
      <p class="hint">${monthData[meta.m] === null ? `${ym(meta.m)}的資料載不到。` : '載入中…'}</p></section>`;
    return;
  }
  $('#meta').textContent = `${ym(B.m)}營收 ${B.count} 家 · 收盤 ${d.asof}`;
  if (state.q.trim()) {
    $('#view').innerHTML = searchView();
    return;
  }
  const body = state.tab === 'group' ? groupView() : state.tab === 'watch' ? watchView() : flashView();
  $('#view').innerHTML = head + body;
}

function bind() {
  $('#view').addEventListener('change', (ev) => {
    if (!ev.target.matches('.rev-month')) return;
    state.month = Number(ev.target.value);
    state.more = 1;
    render();
  });
  $('#view').addEventListener('click', (ev) => {
    const el = ev.target.closest('button');
    if (!el) return;
    const ds = el.dataset;
    if (ds.tab) {
      state.tab = ds.tab;
      save(KEYS.tab, ds.tab);
    } else if (ds.step) {
      const k = state.month + Number(ds.step);
      if (k < 0 || k >= state.data.months.length) return;
      state.month = k;
      state.more = 1;
    } else if (ds.filter) {
      state.filter = ds.filter;
      state.more = 1;
      save(KEYS.filter, ds.filter);
    } else if (ds.sort) {
      state.sort = ds.sort;
      state.more = 1;
      save(KEYS.sort, ds.sort);
    } else if (ds.evf) {
      state.evf = ds.evf;
      state.more = 1;
      save(KEYS.evf, ds.evf);
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
    state.evf = pick(KEYS.evf, EV_FILTERS) || state.evf;
  } catch (err) { /* 讀不到就用預設 */ }
}

async function main() {
  restore();
  try {
    const res = await fetch(`${DATA}/revenue/index.json`);
    if (!res.ok) throw new Error(`revenue/index.json ${res.status}`);
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
