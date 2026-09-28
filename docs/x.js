/*
 * Serenity 供應鏈觀點（x.html）：X 上 @aleabitoreddit 的貼文，依標的索引。
 *
 * 回答的問題：**他最近在講哪幾檔、講了什麼，而那接到台股的哪一族**。
 *
 * 他寫的是 AI 與半導體供應鏈上「還沒被看到的瓶頸」，六千多則貼文裡提過七百個
 * 代號。整包讀完是不可能的，所以這一頁的入口不是時間，是標的：
 *
 *   最近   他這幾天在講什麼（時間軸，掃一眼用）
 *   標的   哪幾檔被講最多、最近熱度在誰身上（點開看他對那一檔說過的每一句）
 *   族群   照台股族群分組 —— 他講的東西落在我本來就在追的哪一族
 *
 * ## 為什麼「未追蹤」要獨立標出來
 *
 * 他提的 700 檔裡只有 78 檔在 docs/data/us_link.json 上。那份對照表是照台股
 * 供應鏈整理的，本來就不會有 SIVE、NBIS、AXTI、IREN 這些還沒進台股視野的名字
 * —— 而那正是看這個帳號的理由。所以「未追蹤」不是資料的缺漏，是這一頁的產出：
 * 它是一份「可能值得加進對照表」的候選名單。
 *
 * ## 摘要在索引裡，全文在月檔
 *
 * ticker/<代號>.json 每則只有 240 字的摘要（最大的 SIVE 有 691 則，整包存全文
 * 就是 400 KB）。點「全文」時才去載那一則所屬的月檔，而同一個月的其他則會跟著
 * 一起到手，所以連著展開同一段時間的貼文只會載那一次。理由完整版在
 * scripts/build_x.py 的 docstring。
 *
 * 這一頁不做任何統計與翻譯 —— 數字由 build_x.py 算好，文字是原樣的貼文。
 */

const DATA = 'data';
const APP_VERSION = (() => {
  const src = document.currentScript?.src || '';
  return new URL(src, location.href).searchParams.get('v') || '?';
})();

const VIEWS = [
  { value: 'recent', label: '最近' },
  { value: 'ticker', label: '標的' },
  { value: 'group', label: '族群' },
];

/*
 * 標的軸的篩選。
 *
 * 「未追蹤」排在「已對照」前面：已對照的那 78 檔在美股頁上本來就看得到，
 * 來這一頁多半是為了另外那 622 檔。
 */
const FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'new', label: '未追蹤' },
  { value: 'linked', label: '已對照' },
];

const SORTS = [
  { value: 'hot', label: '近期熱度' },
  { value: 'count', label: '總提及' },
  { value: 'last', label: '最後提及' },
];

const state = {
  data: null,
  view: 'recent',
  filter: 'all',
  sort: 'hot',
  openT: new Set(),     // 展開中的標的（已載進 tickers 的那幾個）
  openP: new Set(),     // 展開全文的貼文 id
  openG: new Set(),     // 展開中的族群
};

const KEYS = {
  view: 'stocktracker.xview',
  filter: 'stocktracker.xfilter',
  sort: 'stocktracker.xsort',
};

// 載過的 ticker 檔與月檔。展開／收合會重畫整頁，沒有快取的話每次都要重抓。
const tickerCache = new Map();
const monthCache = new Map();

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v) => (v === null || v === undefined ? '—' : v.toLocaleString('zh-TW'));

/** 貼文時間一律顯示台北時間；資料裡存的是 UTC。 */
function when(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 「3 天前」這種相對時間。掃時間軸時它比絕對日期好讀。 */
function ago(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return '';
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min} 分鐘前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小時前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  const mon = Math.floor(day / 30);
  return mon < 12 ? `${mon} 個月前` : `${Math.floor(mon / 12)} 年前`;
}

function pills(name, options, current) {
  return `<div class="pills">${options
    .map((o) => `<button class="pill ${o.value === current ? 'active' : ''}" data-${name}="${o.value}">${esc(o.label)}</button>`)
    .join('')}</div>`;
}

/**
 * 把貼文內文畫成 HTML。
 *
 * 一律先 esc 再加標記 —— 這些字是別人在 X 上寫的，原樣塞進 innerHTML 就是
 * 把這一頁交給對方。順序反過來（先做連結再 esc）會把剛加的標籤也跳脫掉，
 * 看起來像壞掉但其實是安全的；先 esc 再處理才是對的那一邊。
 *
 * cashtag 做成可點：點 $NVDA 就跳到那一檔的貼文，這是這一頁最常用的動作。
 */
function body(text) {
  return esc(text)
    .replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a class="linky" href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`)
    .replace(/\$([A-Za-z]{1,5})(?![A-Za-z0-9])/g, (m, t) => `<button class="ustag" data-jump="${esc(t.toUpperCase())}">$${esc(t.toUpperCase())}</button>`)
    .replace(/\n/g, '<br>');
}

/** 標的的中文名與台股族群，沒有對照的就標成未追蹤。 */
function linkChips(row) {
  const groups = row.g || [];
  if (!groups.length) return '<span class="chip">未追蹤</span>';
  return groups.map((g) => `<span class="chip accent">${esc(g)}</span>`).join('');
}

// --------------------------------------------------------------------------
// 一則貼文
// --------------------------------------------------------------------------

function tweetCard(p, { showTickers = true } = {}) {
  const open = state.openP.has(p.id);
  const full = open ? fullTextOf(p) : null;
  const text = full === null ? p.s : full;

  // 付費訂閱的貼文未登入只拿得到開頭那幾十個字。要說出來 —— 不然它看起來
  // 就只是一則很短的貼文，而不是「這裡有東西你沒看到」。
  const locked = p.locked
    ? '<p class="pair-note">這是付費訂閱貼文，公開頁只給得出開頭這一段。</p>' : '';

  const more = p.more && !open
    ? `<button class="pill" data-open="${esc(p.id)}">展開全文</button>` : '';
  const less = open
    ? `<button class="pill" data-close="${esc(p.id)}">收合</button>` : '';
  const pending = open && full === null
    ? '<span class="hint">載入全文中…</span>' : '';

  const tags = showTickers && (p.t || []).length
    ? `<div class="conds">${p.t.map((t) => `<button class="ustag" data-jump="${esc(t)}">$${esc(t)}</button>`).join('')}</div>`
    : '';

  return `<article class="card x-post">
    <header class="x-post__head">
      <time datetime="${esc(p.ts || '')}">${esc(when(p.ts))}</time>
      <span class="x-post__ago">${esc(ago(p.ts))}</span>
      ${p.reply ? '<span class="chip">回覆</span>' : ''}
      ${p.locked ? '<span class="chip">付費</span>' : ''}
      <a class="linky" href="https://x.com/aleabitoreddit/status/${esc(p.id)}"
         target="_blank" rel="noopener noreferrer">原文 ↗</a>
    </header>
    <div class="x-post__body">${body(text)}</div>
    ${locked}
    ${tags}
    <footer class="x-post__foot">
      <span>♥ ${num(p.likes)}</span>
      <span>↩ ${num(p.replies)}</span>
      ${p.views ? `<span>👁 ${num(p.views)}</span>` : ''}
      ${more}${less}${pending}
    </footer>
  </article>`;
}

/** 已經載到月檔的話就給全文，否則回 null 並把那個月檔排進載入。 */
function fullTextOf(p) {
  const month = monthCache.get(p.m);
  if (month === undefined) {
    loadMonth(p.m);
    return null;
  }
  if (month === null) return p.s;      // 那個月檔載不到，先用摘要頂著
  return month.get(p.id) || p.s;
}

async function loadMonth(month) {
  if (monthCache.has(month)) return;
  monthCache.set(month, undefined);
  try {
    const res = await fetch(`${DATA}/x/tweets/${month}.json`);
    if (!res.ok) throw new Error(res.status);
    const payload = await res.json();
    monthCache.set(month, new Map((payload.items || []).map((r) => [r.id, r.text])));
  } catch (err) {
    console.warn('載不到月檔', month, err);
    monthCache.set(month, null);
  }
  render();
}

async function loadTicker(ticker) {
  if (tickerCache.has(ticker)) return;
  tickerCache.set(ticker, undefined);
  try {
    const res = await fetch(`${DATA}/x/ticker/${encodeURIComponent(ticker)}.json`);
    if (!res.ok) throw new Error(res.status);
    tickerCache.set(ticker, await res.json());
  } catch (err) {
    console.warn('載不到標的', ticker, err);
    tickerCache.set(ticker, null);
  }
  render();
}

// --------------------------------------------------------------------------
// 三個軸
// --------------------------------------------------------------------------

function recentView(data) {
  return `<section class="card">
      <p class="lede">他最近 ${data.recent.length} 則貼文，新的在上面。點 $ 代號可以跳到那一檔的全部貼文。</p>
    </section>
    ${data.recent.map((p) => tweetCard(p)).join('')}`;
}

function filtered(items) {
  if (state.filter === 'new') return items.filter((s) => !(s.g || []).length);
  if (state.filter === 'linked') return items.filter((s) => (s.g || []).length);
  return items;
}

function sortedTickers(items) {
  const rows = filtered(items).slice();
  if (state.sort === 'count') rows.sort((a, b) => b.c - a.c || a.t.localeCompare(b.t));
  else if (state.sort === 'last') rows.sort((a, b) => String(b.last).localeCompare(String(a.last)));
  else rows.sort((a, b) => b.hot - a.hot || b.c - a.c || a.t.localeCompare(b.t));
  return rows;
}

function tickerRow(row) {
  const open = state.openT.has(row.t);
  const detail = open ? tickerDetail(row.t) : '';
  return `<article class="card x-tick ${open ? 'is-open' : ''}">
    <button class="x-tick__head" data-ticker="${esc(row.t)}">
      <span class="x-tick__sym">${open ? '▾' : '▸'} $${esc(row.t)}</span>
      <span class="x-tick__name">${esc(row.n || '')}</span>
      <span class="x-tick__chips">${linkChips(row)}</span>
      <span class="x-tick__num">${row.hot ? `近 ${state.data.hotDays} 天 ${row.hot} 則 · ` : ''}共 ${num(row.c)} 則</span>
      <span class="x-tick__ago">${esc(ago(row.last))}</span>
    </button>
    ${detail}
  </article>`;
}

function tickerDetail(ticker) {
  const payload = tickerCache.get(ticker);
  if (payload === undefined) return '<p class="hint">載入中…</p>';
  if (payload === null) return '<p class="hint">這一檔的貼文載不到，重新整理看看。</p>';
  // 一檔可能有幾百則，一次全畫會卡住捲動。先給最近的，要更早的再按。
  const shown = payload.items.slice(0, 40);
  const rest = payload.items.length - shown.length;
  return `<div class="x-tick__body">
    ${shown.map((p) => tweetCard(p, { showTickers: false })).join('')}
    ${rest > 0 ? `<p class="hint">還有 ${num(rest)} 則更早的，到 X 上看：
      <a class="linky" href="https://x.com/search?q=%24${esc(ticker)}%20from%3Aaleabitoreddit&f=live"
         target="_blank" rel="noopener noreferrer">$${esc(ticker)} 的全部貼文 ↗</a></p>` : ''}
  </div>`;
}

function tickerView(data) {
  const rows = sortedTickers(data.tickers || []);
  const note = state.filter === 'new'
    ? `<p class="lede">他提過、但 <code>us_link.json</code> 上還沒有的 ${num(rows.length)} 檔。
       這一份是「可能值得加進對照表」的候選名單 —— 他的主題就是還沒被看到的瓶頸。</p>`
    : state.filter === 'linked'
      ? '<p class="lede">他提過、而且已經在台股對照表上的那幾檔。點開看他對那一檔說過什麼。</p>'
      : `<p class="lede">他提過的 ${num(rows.length)} 檔，預設照最近 ${data.hotDays} 天的提及次數排。</p>`;

  return `<section class="card">
      ${note}
      <div class="controls">
        ${pills('filter', FILTERS, state.filter)}
        ${pills('sort', SORTS, state.sort)}
      </div>
    </section>
    ${rows.length ? rows.map(tickerRow).join('') : '<p class="hint">這個條件下沒有標的。</p>'}`;
}

function groupView(data) {
  // 照台股族群把他提過的標的分組。一檔橫跨多族的就每一族都出現 ——
  // 使用者是從族群找過來的，那一族裡少了一檔比重複出現更難發現。
  const byGroup = new Map();
  for (const row of data.tickers || []) {
    for (const g of row.g || []) {
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(row);
    }
  }
  if (!byGroup.size) return '<p class="hint">沒有任何標的對得上台股族群。</p>';

  const groups = [...byGroup.entries()]
    .map(([name, rows]) => ({
      name,
      rows: rows.sort((a, b) => b.hot - a.hot || b.c - a.c),
      hot: rows.reduce((n, r) => n + r.hot, 0),
      count: rows.reduce((n, r) => n + r.c, 0),
    }))
    .sort((a, b) => b.hot - a.hot || b.count - a.count);

  return `<section class="card">
      <p class="lede">他提過的標的落在台股的哪一族。族群名稱與美股頁、四市題材是同一套，
      點開看那一族他講過哪幾檔。</p>
    </section>
    ${groups.map((g) => {
      const open = state.openG.has(g.name);
      return `<article class="card x-tick ${open ? 'is-open' : ''}">
        <button class="x-tick__head" data-group="${esc(g.name)}">
          <span class="x-tick__sym">${open ? '▾' : '▸'} ${esc(g.name)}</span>
          <span class="x-tick__num">${g.rows.length} 檔 · 近 ${state.data.hotDays} 天 ${g.hot} 則 · 共 ${num(g.count)} 則</span>
        </button>
        ${open ? `<div class="x-tick__body">${g.rows.map(tickerRow).join('')}</div>` : ''}
      </article>`;
    }).join('')}`;
}

// --------------------------------------------------------------------------

function render() {
  const data = state.data;
  const [from, to] = data.span || [];
  const gap = data.checked ? `　抓取於 ${when(data.checked)}` : '';
  $('#meta').textContent = `${num(data.total)} 則貼文 · ${num((data.tickers || []).length)} 個標的`
    + ` · ${String(from).slice(0, 10)} ~ ${String(to).slice(0, 10)}${gap}`;

  const view = state.view === 'ticker' ? tickerView(data)
    : state.view === 'group' ? groupView(data)
      : recentView(data);

  $('#view').innerHTML = `
    <section class="card">
      <div class="controls">${pills('view', VIEWS, state.view)}</div>
    </section>
    ${view}
    ${sourceNote(data)}`;
}

function sourceNote(data) {
  return `<section class="card note">
    <h2>這份資料怎麼來的</h2>
    <p>來源是 X 上 <a class="linky" href="https://x.com/aleabitoreddit" target="_blank"
      rel="noopener noreferrer">@aleabitoreddit</a> 的公開貼文，每 3 小時抓一次首屏。
      內容原樣保存，沒有翻譯也沒有改寫。</p>
    <p>2025-07 到 2026-09-17 的 6592 則是從社群維護的公開存檔一次灌進來的（標記為
      <code>archive</code>），那一段沒辦法逐則回頭核對；之後的是這裡自己抓的。
      首屏一次只有 5 則而他日均約 15 則，所以排程頻率就是資料完整性本身 ——
      漏掉的貼文沒有第二個地方拿得到。</p>
    <p>他的貼文是一個人的判斷，而且多半是還沒被市場確認的推論。這一頁只負責讓你
      查得到他說過什麼、什麼時候說的，不對內容做任何背書。</p>
  </section>`;
}

function bind() {
  $('#view').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;

    if (btn.dataset.view) {
      state.view = btn.dataset.view;
      save(KEYS.view, state.view);
      return render();
    }
    if (btn.dataset.filter) {
      state.filter = btn.dataset.filter;
      save(KEYS.filter, state.filter);
      return render();
    }
    if (btn.dataset.sort) {
      state.sort = btn.dataset.sort;
      save(KEYS.sort, state.sort);
      return render();
    }
    if (btn.dataset.ticker) {
      const t = btn.dataset.ticker;
      if (state.openT.has(t)) state.openT.delete(t);
      else {
        state.openT.add(t);
        loadTicker(t);
      }
      return render();
    }
    if (btn.dataset.group) {
      const g = btn.dataset.group;
      if (state.openG.has(g)) state.openG.delete(g);
      else state.openG.add(g);
      return render();
    }
    if (btn.dataset.open) {
      state.openP.add(btn.dataset.open);
      return render();
    }
    if (btn.dataset.close) {
      state.openP.delete(btn.dataset.close);
      return render();
    }
    if (btn.dataset.jump) {
      // 從內文的 $代號 跳到那一檔：切到標的軸、展開它、捲過去。
      const t = btn.dataset.jump;
      if (!(state.data.tickers || []).some((s) => s.t === t)) return;
      state.view = 'ticker';
      state.filter = 'all';
      state.openT.add(t);
      loadTicker(t);
      render();
      const row = [...document.querySelectorAll('[data-ticker]')]
        .find((el) => el.dataset.ticker === t);
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
}

function save(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    /* 記不住就算了，下次回到預設 */
  }
}

function restore() {
  try {
    const view = localStorage.getItem(KEYS.view);
    if (VIEWS.some((v) => v.value === view)) state.view = view;
    const filter = localStorage.getItem(KEYS.filter);
    if (FILTERS.some((f) => f.value === filter)) state.filter = filter;
    const sort = localStorage.getItem(KEYS.sort);
    if (SORTS.some((s) => s.value === sort)) state.sort = sort;
  } catch (err) {
    /* 讀不到就用預設 */
  }
}

async function main() {
  restore();
  try {
    // 兩份一起載：index.json 是首頁與近期流，tickers.json 是完整的標的清單
    // （index 裡只有前 40 名，標的軸要全部）。
    const [index, tickers] = await Promise.all([
      fetch(`${DATA}/x/index.json`).then((r) => {
        if (!r.ok) throw new Error(`index.json ${r.status}`);
        return r.json();
      }),
      fetch(`${DATA}/x/tickers.json`).then((r) => (r.ok ? r.json() : null)),
    ]);
    state.data = index;
    state.data.tickers = (tickers && tickers.items) || index.hot || [];
  } catch (err) {
    console.error(err);
    $('#meta').textContent = '載入失敗';
    $('#view').innerHTML = `<p class="hint">資料載不到。這一頁要等
      <code>scripts/fetch_x.py</code> 與 <code>scripts/build_x.py</code> 跑過一次才有東西。</p>`;
    return;
  }
  bind();
  render();
}

main();
