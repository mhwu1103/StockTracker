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
 *   族群   照台股族群分：哪一族最近被他的哪幾個主題碰到
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
  openP: new Set(),     // 展開全文的貼文 id
  shown: new Map(),     // 每個主題目前畫了幾則
};

const PAGE = 40;

const KEYS = { view: 'stocktracker.trumpview', kind: 'stocktracker.trumpkind' };

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

function topicRow(t) {
  const open = state.openK.has(t.k);
  const empty = !t.c;
  return `<article class="card x-tick ${open ? 'is-open' : ''} ${empty ? 'is-empty' : ''}">
    <button class="x-tick__head" data-topic="${esc(t.k)}" ${empty ? 'disabled' : ''}>
      <span class="x-tick__sym">${empty ? '·' : open ? '▾' : '▸'} ${esc(t.label)}</span>
      <span class="x-tick__name"></span>
      <span class="x-tick__chips">${groupChips(t.g)}</span>
      <span class="x-tick__num">${empty ? '還沒提到'
        : `${t.hot ? `近 ${state.data.hotDays} 天 ${t.hot} 則 · ` : ''}共 ${num(t.c)} 則`}</span>
      <span class="x-tick__ago">${esc(ago(t.last))}</span>
    </button>
    ${open ? topicDetail(t.k) : ''}
  </article>`;
}

function topicDetail(k) {
  const payload = topicCache.get(k);
  if (payload === undefined) return '<p class="hint">載入中…</p>';
  if (payload === null) return '<p class="hint">這個主題的貼文載不到，重新整理看看。</p>';
  // 一個主題可能有上百則（戰事），一次全畫會卡住捲動。先給最近的，要更早的再按。
  const shown = payload.items.slice(0, state.shown.get(k) || PAGE);
  const rest = payload.items.length - shown.length;
  return `<div class="x-tick__body">
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
    ${sortedTopics(data).map(topicRow).join('')}`;
}

function groupView(data) {
  // 一個主題可以對到好幾族，一族也會被好幾個主題碰到。從族群找過來的人要看到
  // 的是「這一族最近被他的哪些話碰到」，所以每一族底下列主題，主題再展開貼文。
  const byGroup = new Map();
  for (const t of data.topics || []) {
    if (!t.c) continue;
    for (const g of t.g || []) {
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(t);
    }
  }
  const intro = `<section class="card">
      <p class="lede">他講的政策落在台股的哪一族。一則貼文碰到兩個主題時兩邊都算，
      所以同一族底下的次數加起來會比實際貼文多。</p>
      ${coverage(data)}
    </section>`;
  if (!byGroup.size) return `${intro}<p class="hint">目前還沒有任何貼文對得上台股族群。</p>`;

  const groups = [...byGroup.entries()]
    .map(([name, topics]) => ({
      name,
      topics: topics.sort((a, b) => b.hot - a.hot || b.c - a.c),
      hot: topics.reduce((n, t) => n + t.hot, 0),
      count: topics.reduce((n, t) => n + t.c, 0),
    }))
    .sort((a, b) => b.hot - a.hot || b.count - a.count);

  return `${intro}
    ${groups.map((g) => {
      const open = state.openG.has(g.name);
      return `<article class="card x-tick ${open ? 'is-open' : ''}">
        <button class="x-tick__head" data-group="${esc(g.name)}">
          <span class="x-tick__sym">${open ? '▾' : '▸'} ${esc(g.name)}</span>
          <span class="x-tick__name">${esc(g.topics.map((t) => t.label).join('、'))}</span>
          <span class="x-tick__chips"></span>
          <span class="x-tick__num">近 ${state.data.hotDays} 天 ${g.hot} 則 · 共 ${num(g.count)} 則</span>
        </button>
        ${open ? `<div class="x-tick__body">${g.topics.map(topicRow).join('')}</div>` : ''}
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
