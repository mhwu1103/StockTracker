/*
 * 川普政策觀點（trump.html）：他在 Truth Social 與 X 上寫的字，依政策主題索引。
 *
 * 回答的問題：**他最近在講什麼政策，而那會先打到台股的哪一族**。
 *
 * 跟 Serenity 那頁（x.js）的差別在索引軸：Serenity 講個股、寫 $代號，所以那頁
 * 是「代號 → 族群」；他講的是關稅、晶片、利率、戰事，而且一個 $ 都不寫 ——
 * 那些話一出來台股是整族一起跳空，所以這一頁是「主題 → 族群」：
 *
 *   最近   他這幾天寫了什麼（時間軸）
 *   主題   關稅、晶片、利率…各講了幾次、最近熱度在哪（點開看每一則）
 *   標的   一檔台股一列：被他的話碰到幾次（點開看每一則），跟 Serenity 的標的軸同一個形狀
 *   族群   族群 → 標的 → 貼文
 *
 * 只收他自己寫的字：影片、純連結、轉發都不在資料裡（理由見 scripts/trump.py）。
 *
 * ## 背書文預設收起來
 *
 * 他有字的貼文約兩成是替候選人背書，每一則都附一段制式政見（汽油、軍隊、關稅…）。
 * 那些不標主題，最近那一軸也預設不列 —— 否則一打開整片都是「X has my Complete
 * and Total Endorsement」，真正講政策的那幾則被擠到下面。
 *
 * 主題的關鍵字表在 scripts/trump.py 的 TOPICS，數字由 build_trump.py 算好。
 */

const DATA = 'data/trump';
// 月檔在哪個目錄：摘要帶著 src，全文要去對應來源的月檔拿
const SRC_DIR = { truth: 'truth', x: 'tweets' };
const SRC_LABEL = { truth: 'Truth Social', x: 'X' };

const VIEWS = [
  { value: 'recent', label: '最近' },
  { value: 'topic', label: '主題' },
  { value: 'stock', label: '標的' },
  { value: 'group', label: '族群' },
];

// 最近那一軸的篩選
const KINDS = [
  { value: 'policy', label: '不含背書' },
  { value: 'all', label: '全部' },
  { value: 'endorse', label: '只看背書' },
];

const state = {
  data: null,
  view: 'recent',
  kind: 'policy',
  openK: new Set(),     // 展開中的主題
  openG: new Set(),     // 展開中的族群
  openS: new Set(),     // 展開中的標的（台股代號）
  openP: new Set(),     // 展開全文的貼文 id
  shown: new Map(),     // 每個主題目前畫了幾則
  days: '30',           // 標的與族群軸的天數篩選
  gsort: 'count',       // 標的與族群軸的排序
};

const PAGE = 40;

const KEYS = {
  view: 'stocktracker.trumpview',
  kind: 'stocktracker.trumpkind',
  days: 'stocktracker.trumpdays',
  gsort: 'stocktracker.trumpgsort',
};

const topicCache = new Map();
const monthCache = new Map();

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v) => (v === null || v === undefined ? '—' : v.toLocaleString('zh-TW'));

/** 觀看數：他一則影片是幾百萬，照原數字寫會是一長串位數。 */
function compact(v) {
  if (!v) return '—';
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)} 億`;
  if (v >= 1e4) return `${Math.round(v / 1e4).toLocaleString('zh-TW')} 萬`;
  return v.toLocaleString('zh-TW');
}

function when(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

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

const topicOf = (k) => (state.data.topics || []).find((t) => t.k === k);

/** 內文：先 esc 再加連結，理由同 x.js 的 body()。 */
function body(text) {
  return esc(text)
    .replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a class="linky" href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`)
    .replace(/\n/g, '<br>');
}

function groupChips(groups) {
  if (!(groups || []).length) return '<span class="chip">無單一族群</span>';
  return groups.map((g) => `<span class="chip accent">${esc(g)}</span>`).join('');
}

// --------------------------------------------------------------------------
// 一則貼文
// --------------------------------------------------------------------------

/** 原文連結只接受 https，其餘一律不畫 —— 網址來自別人的站，不能原樣塞進 href。 */
const safeUrl = (u) => (/^https:\/\//.test(u || '') ? u : null);

function tweetCard(p, { showTopics = true } = {}) {
  const open = state.openP.has(p.id);
  const full = open ? fullTextOf(p) : null;
  const text = full === null ? p.s : full;

  const more = p.more && !open ? `<button class="pill" data-open="${esc(p.id)}">展開全文</button>` : '';
  const less = open ? `<button class="pill" data-close="${esc(p.id)}">收合</button>` : '';
  const pending = open && full === null ? '<span class="hint">載入全文中…</span>' : '';

  const tags = showTopics && (p.k || []).length
    ? `<div class="conds">${p.k.map((k) => {
      const t = topicOf(k);
      return `<button class="ustag" data-jump="${esc(k)}">#${esc(t ? t.label : k)}</button>`;
    }).join('')}</div>`
    : '';

  const link = (url, label) => (safeUrl(url)
    ? `<a class="linky" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label} ↗</a>` : '');

  // 互動數只有 X 有，Truth Social 的存檔不提供 —— 沒有就整排不畫，不要畫一排「—」
  const stats = [
    p.likes ? `<span>♥ ${num(p.likes)}</span>` : '',
    p.replies ? `<span>↩ ${num(p.replies)}</span>` : '',
    p.views ? `<span>👁 ${compact(p.views)}</span>` : '',
  ].join('');

  return `<article class="card x-post">
    <header class="x-post__head">
      <time datetime="${esc(p.ts || '')}">${esc(when(p.ts))}</time>
      <span class="x-post__ago">${esc(ago(p.ts))}</span>
      <span class="chip">${esc(SRC_LABEL[p.src] || p.src)}</span>
      ${p.e ? '<span class="chip">背書</span>' : ''}
      ${link(p.url, '原文')}
      ${p.xurl ? link(p.xurl, 'X') : ''}
    </header>
    <div class="x-post__body">${body(text)}</div>
    ${tags}
    ${stats || more || less || pending ? `<footer class="x-post__foot">${stats}${more}${less}${pending}</footer>` : ''}
  </article>`;
}

// 月檔快取的鍵是「來源/月份」：兩個來源的同一個月是不同的檔
const monthKey = (p) => `${SRC_DIR[p.src] || 'truth'}/${p.m}`;

function fullTextOf(p) {
  const key = monthKey(p);
  const month = monthCache.get(key);
  if (month === undefined) {
    loadMonth(key);
    return null;
  }
  if (month === null) return p.s;
  return month.get(p.id) || p.s;
}

async function loadMonth(key) {
  if (monthCache.has(key)) return;
  monthCache.set(key, undefined);
  try {
    const res = await fetch(`${DATA}/${key}.json`);
    if (!res.ok) throw new Error(res.status);
    const payload = await res.json();
    monthCache.set(key, new Map((payload.items || []).map((r) => [r.id, r.text])));
  } catch (err) {
    console.warn('載不到月檔', key, err);
    monthCache.set(key, null);
  }
  render();
}

async function loadTopic(k) {
  if (topicCache.has(k)) return;
  topicCache.set(k, undefined);
  try {
    const res = await fetch(`${DATA}/topic/${encodeURIComponent(k)}.json`);
    if (!res.ok) throw new Error(res.status);
    topicCache.set(k, await res.json());
  } catch (err) {
    console.warn('載不到主題', k, err);
    topicCache.set(k, null);
  }
  render();
}

// --------------------------------------------------------------------------
// 三個軸
// --------------------------------------------------------------------------

function recentView(data) {
  const rows = data.recent.filter((p) => (state.kind === 'policy' ? !p.e
    : state.kind === 'endorse' ? p.e : true));
  return `<section class="card">
      <p class="lede">他最近 ${data.recent.length} 則貼文，新的在上面。貼文底下的 #主題 點得動。</p>
      <div class="controls">${pills('kind', KINDS, state.kind)}</div>
    </section>
    ${rows.length ? rows.map((p) => tweetCard(p)).join('') : '<p class="hint">這個條件下沒有貼文。</p>'}`;
}

/** 主題與族群兩軸的前言：說清楚背書文不在統計裡。 */
function coverage(data) {
  return `<p class="x-cover">${num(data.total)} 則貼文裡有 ${num(data.endorse || 0)} 則是替候選人背書，
    那些都附一段制式政見（汽油、軍隊、關稅…），不算進主題 —— 否則次數會跟著他背書了幾個人走。</p>`;
}

function sortedTopics(data) {
  return (data.topics || []).slice()
    .sort((a, b) => b.hot - a.hot || b.c - a.c || String(b.last).localeCompare(String(a.last)));
}

/**
 * 相關台股：一個子族群一行，股票點了進個股頁。
 *
 * 清單來自 themes.json（人工維護的題材族群），對照的粒度是**子族群**：「汽車」只列
 * 汽車零件與功率半導體，不會把整個傳產（塑化、水泥、零售）一起倒出來。
 * 股票是按鈕：點了跳到標的軸展開那一檔，往個股頁的連結在那裡。
 */
function stockBlock(blocks, title = '相關台股') {
  const seen = new Set();
  const rows = (blocks || []).filter((b) => {
    const key = `${b.g}/${b.sub}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!rows.length) return '';
  const total = new Set(rows.flatMap((b) => b.c.map(([code]) => code))).size;
  return `<section class="x-stocks">
    <h3>${esc(title)} <span>${num(total)} 檔</span></h3>
    ${rows.map((b) => `<div class="x-stocks__row">
      <span class="x-stocks__sub">${esc(b.sub)}</span>
      <span class="x-stocks__list">${b.c.map(([code, name]) => `<button class="x-stock"
        data-jumpstock="${esc(code)}">${esc(name || code)}<span>${esc(code)}</span></button>`).join('')}</span>
    </div>`).join('')}
  </section>`;
}

/**
 * 一個主題列。`since` 有給的時候（族群軸的天數篩選）次數與展開的貼文都只算
 * 那一段 —— 標頭寫「7 天內 3 則」、點開卻列出 177 則，兩個數字對不起來。
 */
function topicRow(t, since = null) {
  const open = state.openK.has(t.k);
  const empty = !t.c;
  const num_ = since !== null
    ? `${esc(dayLabel())} ${num(t.c)} 則`
    : `${t.hot ? `近 ${state.data.hotDays} 天 ${t.hot} 則 · ` : ''}共 ${num(t.c)} 則`;
  return `<article class="card x-tick ${open ? 'is-open' : ''} ${empty ? 'is-empty' : ''}">
    <button class="x-tick__head" data-topic="${esc(t.k)}" ${empty ? 'disabled' : ''}>
      <span class="x-tick__sym">${empty ? '·' : open ? '▾' : '▸'} ${esc(t.label)}</span>
      <span class="x-tick__name"></span>
      <span class="x-tick__chips">${groupChips(t.g)}</span>
      <span class="x-tick__num">${empty ? '還沒提到' : num_}</span>
      <span class="x-tick__ago">${esc(ago(t.last))}</span>
    </button>
    ${open ? topicDetail(t.k, since, since === null ? t.tw : null) : ''}
  </article>`;
}

// stocks：主題軸才傳（貼文上面先列該看的台股）；族群軸的台股已經畫在族群那一層，不重複
function topicDetail(k, since = null, stocks = null) {
  const payload = topicCache.get(k);
  if (payload === undefined) return '<p class="hint">載入中…</p>';
  if (payload === null) return '<p class="hint">這個主題的貼文載不到，重新整理看看。</p>';
  const items = since !== null ? payload.items.filter((p) => (p.ts || '') >= since) : payload.items;
  // 一個主題可能有上百則（戰事），一次全畫會卡住捲動。先給最近的，要更早的再按。
  const shown = items.slice(0, state.shown.get(k) || PAGE);
  const rest = items.length - shown.length;
  return `<div class="x-tick__body">
    ${stockBlock(stocks)}
    ${shown.map((p) => tweetCard(p, { showTopics: false })).join('')}
    ${rest > 0 ? `<button class="pill x-more" data-more="${esc(k)}">再看 ${num(Math.min(rest, PAGE))} 則更早的（還有 ${num(rest)} 則）</button>` : ''}
  </div>`;
}

function topicView(data) {
  return `<section class="card">
      <p class="lede">他碰過的政策主題，照最近 ${data.hotDays} 天的次數排。右邊的族群是
      「這個主題一出來，台股先動的那幾族」，名稱與美股頁、四市題材同一套。</p>
      ${coverage(data)}
    </section>
    ${sortedTopics(data).map((t) => topicRow(t)).join('')}`;
}

/** 標的與族群軸的天數篩選。0 是「全部」。 */
const DAYS = [
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
  { value: '0', label: '全部' },
];

/*
 * 標的與族群軸的排序。「最新」照這一族最後一次被碰到的時間 —— 看「他剛剛講到哪一族」；
 * 「最早」反過來，看這段期間裡哪一族是先被碰到的。
 */
const GSORTS = [
  { value: 'count', label: '則數' },
  { value: 'new', label: '最新' },
  { value: 'old', label: '最早' },
];

const dayLabel = () => (state.days === '0' ? '全部' : `${state.days} 天內`);

/** 天數篩選的起點（UTC ISO）。「全部」回 null。 */
function sinceOf() {
  const n = Number(state.days);
  if (!n) return null;
  return new Date(Date.now() - n * 86400000).toISOString().replace(/\.\d+Z$/, 'Z');
}

/** 某個主題在篩選範圍內的樣子：次數、最後一次與第一次被提到的時間。 */
function windowed(t, since) {
  const ts = since ? (t.ts || []).filter((x) => x >= since) : (t.ts || []);
  return { ...t, c: ts.length, last: ts[0] || null, first: ts[ts.length - 1] || null };
}

const newer = (a, b) => String(b || '').localeCompare(String(a || ''));

/** 族群軸與標的軸共用的排序：則數、最新（最後一次被碰到）、最早（第一次被碰到）。 */
function orderBy() {
  return {
    count: (a, b) => b.count - a.count || newer(a.last, b.last),
    new: (a, b) => newer(a.last, b.last) || b.count - a.count,
    old: (a, b) => newer(b.first, a.first) || b.count - a.count,
  }[state.gsort] || ((a, b) => b.count - a.count);
}

// --------------------------------------------------------------------------
// 標的：一檔台股 ← 對到它的那幾個主題 ← 那些主題的貼文
// --------------------------------------------------------------------------

/**
 * 從各主題的 tw（子族群 → 代號）反推「每一檔被哪幾個主題、哪幾個子族群碰到」。
 *
 * 一檔的貼文是它那幾個主題的貼文**聯集**，用貼文 id 去重：同一則碰到「關稅」
 * 又碰到「汽車」的話，東陽只算一次。直接把主題次數相加的話，跨主題的熱門股
 * 會被灌水，排序也跟著錯。
 */
function stockIndex(data) {
  if (data._stocks) return data._stocks;
  const map = new Map();
  for (const t of data.topics || []) {
    for (const b of t.tw || []) {
      for (const [code, name] of b.c) {
        if (!map.has(code)) map.set(code, { code, name, topics: new Set(), subs: [], groups: new Set() });
        const s = map.get(code);
        s.topics.add(t.k);
        s.groups.add(b.g);
        if (!s.subs.includes(b.sub)) s.subs.push(b.sub);
      }
    }
  }
  data._stocks = map;
  return map;
}

/** 一檔在篩選範圍內的樣子：去重後的則數、最後一次與第一次被碰到的時間。 */
function stockWindow(s, since) {
  const seen = new Map();
  for (const k of s.topics) {
    const t = topicOf(k);
    (t.ids || []).forEach((id, i) => {
      const ts = t.ts[i];
      if (!since || ts >= since) seen.set(id, ts);
    });
  }
  const ts = [...seen.values()].sort().reverse();
  return { ...s, count: ts.length, last: ts[0] || null, first: ts[ts.length - 1] || null };
}

const showKey = (code) => `s:${code}`;

function stockRow(s, since) {
  const open = state.openS.has(s.code);
  const topics = [...s.topics].map((k) => topicOf(k)?.label || k).join('、');
  return `<article class="card x-tick ${open ? 'is-open' : ''}" data-stockrow="${esc(s.code)}">
    <button class="x-tick__head" data-stock="${esc(s.code)}">
      <span class="x-tick__sym">${open ? '▾' : '▸'} ${esc(s.name || s.code)}</span>
      <span class="x-tick__name">${esc(s.code)} · ${esc(topics)}</span>
      <span class="x-tick__chips">${s.subs.map((x) => `<span class="chip accent">${esc(x)}</span>`).join('')}</span>
      <span class="x-tick__num">${esc(dayLabel())} ${num(s.count)} 則</span>
      <span class="x-tick__ago">${esc(ago(state.gsort === 'old' ? s.first : s.last))}</span>
    </button>
    ${open ? stockDetail(s, since) : ''}
  </article>`;
}

/** 展開一檔：它那幾個主題檔都載到之後，合併、去重、照時間新到舊。 */
function stockDetail(s, since) {
  const payloads = [...s.topics].map((k) => topicCache.get(k));
  const stock = `<p class="x-stocklink"><a class="linky" href="index.html#/stock/${encodeURIComponent(s.code)}">
    ${esc(s.name || s.code)} ${esc(s.code)} 個股頁 ↗</a></p>`;
  if (payloads.some((p) => p === undefined)) return `<div class="x-tick__body">${stock}<p class="hint">載入中…</p></div>`;

  const byId = new Map();
  for (const p of payloads) {
    for (const item of (p && p.items) || []) {
      if (!since || (item.ts || '') >= since) byId.set(item.id, item);
    }
  }
  const items = [...byId.values()].sort((a, b) => newer(a.ts, b.ts));
  const shown = items.slice(0, state.shown.get(showKey(s.code)) || PAGE);
  const rest = items.length - shown.length;
  // 貼文底下留著 #主題：一檔股票被列進來的理由就是那幾個主題，要看得出是哪一個
  return `<div class="x-tick__body">
    ${stock}
    ${shown.map((p) => tweetCard(p)).join('')}
    ${rest > 0 ? `<button class="pill x-more" data-more="${esc(showKey(s.code))}">再看 ${num(Math.min(rest, PAGE))} 則更早的（還有 ${num(rest)} 則）</button>` : ''}
  </div>`;
}

function openStock(code) {
  const s = stockIndex(state.data).get(code);
  if (!s) return;
  state.openS.add(code);
  for (const k of s.topics) loadTopic(k);
}

/** 篩選與排序的那一排，族群軸與標的軸共用。 */
const windowControls = () => `<div class="controls">
    ${pills('days', DAYS, state.days)}
    ${pills('gsort', GSORTS, state.gsort)}
  </div>`;

function stockView(data) {
  const since = sinceOf();
  const rows = [...stockIndex(data).values()]
    .map((s) => stockWindow(s, since))
    .filter((s) => s.count)
    .sort(orderBy());
  const intro = `<section class="card">
      <p class="lede">他講的政策碰到哪幾檔台股，一檔一列。一檔是從「主題 → 子族群」對過來的
      （對照表是 <code>themes.json</code>），點開看碰到它的每一則貼文，貼文底下的 #主題 就是它被列進來的理由。</p>
      ${coverage(data)}
      ${windowControls()}
    </section>`;
  if (!rows.length) return `${intro}<p class="hint">${esc(dayLabel())}沒有任何貼文對得上台股，把天數放寬看看。</p>`;
  // 一次列 60 檔；展開中的那幾檔不管排第幾都要在（從主題的台股跳過來的就是這種）
  const limit = state.shown.get('stocks') || 60;
  const shown = rows.filter((s, i) => i < limit || state.openS.has(s.code));
  const rest = rows.length - shown.length;
  return `${intro}
    ${shown.map((s) => stockRow(s, since)).join('')}
    ${rest > 0 ? `<button class="pill x-more" data-more="stocks">再列 ${num(Math.min(rest, 60))} 檔（還有 ${num(rest)} 檔）</button>` : ''}`;
}

function groupView(data) {
  // 族群 → 標的 → 貼文，與 Serenity 那頁的族群軸同一個層次。一族的則數是底下
  // 那幾個主題的貼文**去重後**的則數：一則碰到兩個主題、兩個主題又都對到這一族的話，
  // 只算一次。
  const since = sinceOf();
  const index = stockIndex(data);
  const byGroup = new Map();
  for (const raw of data.topics || []) {
    const t = windowed(raw, since);
    if (!t.c) continue;
    for (const g of t.g || []) {
      if (!byGroup.has(g)) byGroup.set(g, { topics: [], codes: new Set() });
      const slot = byGroup.get(g);
      slot.topics.push(raw);
      for (const b of raw.tw || []) if (b.g === g) b.c.forEach(([code]) => slot.codes.add(code));
    }
  }
  const intro = `<section class="card">
      <p class="lede">他講的政策落在台股的哪一族。點開一族看底下的標的，再點開一檔看碰到它的貼文。</p>
      ${coverage(data)}
      ${windowControls()}
    </section>`;
  if (!byGroup.size) return `${intro}<p class="hint">${esc(dayLabel())}沒有任何貼文對得上台股族群，把天數放寬看看。</p>`;

  const order = orderBy();
  const groups = [...byGroup.entries()]
    .map(([name, slot]) => {
      const w = stockWindow({ topics: new Set(slot.topics.map((t) => t.k)) }, since);
      return { name, topics: slot.topics, codes: slot.codes, count: w.count, last: w.last, first: w.first };
    })
    .sort(order);

  return `${intro}
    ${groups.map((g) => {
      const open = state.openG.has(g.name);
      const labels = g.topics.map((t) => t.label).join('、');
      let body = '';
      if (open) {
        // 族群底下的標的跟著同一個排序走，不然外層照時間、裡面照則數，讀起來是亂的
        const rows = [...g.codes].map((c) => index.get(c)).filter(Boolean)
          .map((s) => stockWindow(s, since)).filter((s) => s.count).sort(order);
        body = `<div class="x-tick__body">${rows.map((s) => stockRow(s, since)).join('')}</div>`;
      }
      return `<article class="card x-tick ${open ? 'is-open' : ''}">
        <button class="x-tick__head" data-group="${esc(g.name)}">
          <span class="x-tick__sym">${open ? '▾' : '▸'} ${esc(g.name)}</span>
          <span class="x-tick__name">${esc(labels)} · ${num(g.codes.size)} 檔</span>
          <span class="x-tick__chips"></span>
          <span class="x-tick__num">${esc(dayLabel())} ${num(g.count)} 則</span>
          <span class="x-tick__ago">${esc(ago(state.gsort === 'old' ? g.first : g.last))}</span>
        </button>
        ${body}
      </article>`;
    }).join('')}`;
}

// --------------------------------------------------------------------------

function render() {
  const data = state.data;
  const [from, to] = data.span || [];
  const gap = data.checked ? `　抓取於 ${when(data.checked)}` : '';
  $('#meta').textContent = `${num(data.total)} 則貼文`
    + ` · ${String(from).slice(0, 10)} ~ ${String(to).slice(0, 10)}${gap}`;

  const view = state.view === 'topic' ? topicView(data)
    : state.view === 'stock' ? stockView(data)
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
    <p>主要來源是他在 Truth Social 上的貼文，經由
      <a class="linky" href="https://www.trumpstruth.org/" target="_blank" rel="noopener noreferrer">trumpstruth.org</a>
      的公開存檔取得（Truth Social 官方 API 被 Cloudflare 擋下）；另外補上 X
      <a class="linky" href="https://x.com/realDonaldTrump" target="_blank" rel="noopener noreferrer">@realDonaldTrump</a>
      上有字的貼文，與 Truth Social 同文的只留一則。每 3 小時更新一次，
      從 ${esc(String((data.span || [])[0] || '').slice(0, 10))} 起共 ${num(data.total)} 則。
      內容原樣保存，沒有翻譯也沒有改寫。</p>
    <p>只收他自己寫的字：純影片、純連結、ReTruth／轉推都不收。Truth Social 的存檔沒有讚數，
      所以那些貼文不顯示互動數。</p>
    <p>主題是照英文關鍵字標的（關鍵字表在 <code>scripts/trump.py</code>），會有誤標與漏標；
      族群對照是「這句話一出來台股哪一族先動」的判斷，不是事實查核，更不是投資建議。</p>
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
    if (btn.dataset.days) {
      state.days = btn.dataset.days;
      save(KEYS.days, state.days);
      return render();
    }
    if (btn.dataset.gsort) {
      state.gsort = btn.dataset.gsort;
      save(KEYS.gsort, state.gsort);
      return render();
    }
    if (btn.dataset.kind) {
      state.kind = btn.dataset.kind;
      save(KEYS.kind, state.kind);
      return render();
    }
    if (btn.dataset.topic) {
      const k = btn.dataset.topic;
      if (state.openK.has(k)) state.openK.delete(k);
      else {
        state.openK.add(k);
        loadTopic(k);
      }
      return render();
    }
    if (btn.dataset.stock) {
      const c = btn.dataset.stock;
      if (state.openS.has(c)) state.openS.delete(c);
      else openStock(c);
      return render();
    }
    if (btn.dataset.jumpstock) {
      // 主題底下的台股點了跳到標的軸、展開那一檔、捲過去（同 Serenity 的 $代號）
      const c = btn.dataset.jumpstock;
      state.view = 'stock';
      state.days = '0';
      openStock(c);
      render();
      const row = [...document.querySelectorAll('[data-stockrow]')].find((el) => el.dataset.stockrow === c);
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (btn.dataset.group) {
      const g = btn.dataset.group;
      if (state.openG.has(g)) state.openG.delete(g);
      else state.openG.add(g);
      return render();
    }
    if (btn.dataset.more) {
      const k = btn.dataset.more;
      state.shown.set(k, (state.shown.get(k) || PAGE) + PAGE);
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
      // 從貼文底下的 #主題 跳到那個主題：切到主題軸、展開、捲過去。
      const k = btn.dataset.jump;
      if (!topicOf(k)) return;
      state.view = 'topic';
      state.openK.add(k);
      loadTopic(k);
      render();
      const row = [...document.querySelectorAll('[data-topic]')].find((el) => el.dataset.topic === k);
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
}

function save(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    /* 記不住就算了 */
  }
}

function restore() {
  try {
    const view = localStorage.getItem(KEYS.view);
    if (VIEWS.some((v) => v.value === view)) state.view = view;
    const days = localStorage.getItem(KEYS.days);
    if (DAYS.some((d) => d.value === days)) state.days = days;
    const gsort = localStorage.getItem(KEYS.gsort);
    if (GSORTS.some((g) => g.value === gsort)) state.gsort = gsort;
    const kind = localStorage.getItem(KEYS.kind);
    if (KINDS.some((k) => k.value === kind)) state.kind = kind;
  } catch (err) {
    /* 讀不到就用預設 */
  }
}

async function main() {
  restore();
  try {
    const res = await fetch(`${DATA}/index.json`);
    if (!res.ok) throw new Error(`index.json ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    console.error(err);
    $('#meta').textContent = '載入失敗';
    $('#view').innerHTML = `<p class="hint">資料載不到。這一頁要等
      <code>scripts/fetch_trump.py</code> 與 <code>scripts/build_trump.py</code> 跑過一次才有東西。</p>`;
    return;
  }
  bind();
  render();
}

main();
