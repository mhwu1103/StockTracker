/*
 * 四市題材（cross.html）：美、日、韓、台同一段時間的題材漲跌。
 *
 * 回答的問題：**現在什麼題材在漲**，而且要四個市場一起回答。
 *
 * 同一個題材在四個市場同時走強，跟只有一個市場在動，是完全不同的兩件事：前者後面
 * 多半有真的需求，後者多半是單一市場的資金或消息。所以這一頁的主角不是任何一欄，
 * 是**最弱的那一欄**——四個市場裡跑最慢的那一個也在漲，這個題材才叫「在漲」。
 *
 * ## 與另外三頁的分工
 *
 *   美股頁   一對一：這一檔美股與那一檔台股綁得緊不緊（相關係數）
 *   日股頁   一族對一族：日本這一段在動，台股這一族跟上了沒
 *   韓股頁   同上，但韓股多半是對手不是上游
 *   這一頁   一個題材在四個市場各自的溫度，橫著比
 *
 * 前三頁都是「外國 vs 台灣」的兩欄比較，這一頁是四欄並列，所以它不共用 pair.js：
 * 資料形狀不一樣（一格是一個市場的中位數，不是一列一檔個股）。共用的是 style.css
 * 的 .pair-* 與 table.pair 那一套版面。
 *
 * ## 日曆視窗，不是各自回推 N 個交易日
 *
 * 每個市場的假日不一樣，「回推 63 個交易日」在四份日曆上會落到四個不同的日期，
 * 而且愈往回推差愈多。所以 build_cross.py 拿台股的交易日軸算出每一段的起訖**日期**，
 * 四個市場各自取「那個日期或之前最後一筆」。完整理由在那一支的 docstring。
 *
 * 代價是各市場的最後一場可能差一兩天（韓股中秋休兩天就會停在前一天）。那擋不掉，
 * 但看得見：每個市場自己的最後一場印在標頭上。
 *
 * 數字全部由 scripts/build_cross.py 算好，這裡只負責顯示與排序——前端不做統計。
 * 唯一的算術是「超額」那個模式的減法與「最弱」取最小值，兩者都只是把已經給好的
 * 數字擺在一起。
 */

const DATA = 'data';
const APP_VERSION = (() => {
  const src = document.currentScript?.src || '';
  return new URL(src, location.href).searchParams.get('v') || '?';
})();

const state = {
  data: null,
  span: 1,            // 0 昨日、1 週、2 月、3 季
  mode: 'raw',        // 'raw' 原始漲跌、'ex' 扣掉各自大盤
  sort: 'weak',       // 'weak' 最弱的一市、'mid' 四市中位、'tw' 台股
  open: new Set(),    // 展開子題材的族群
  /*
   * 展開個股的那幾格，鍵是「列 | 市場」。
   *
   * 展開的單位是**一格**不是一列：一列有四個市場，四邊全攤開就是上百列，而且
   * 一檔個股只屬於一個市場，四欄裡有三欄一定是空的。點哪一格就看哪一個市場的
   * 成分股，列數也就停在那一格的檔數上（子題材多半 2～5 檔）。
   *
   * 族群列那一格也點得動，而且點它才看得到「只標在族群層、沒有落進任何子題材」的
   * 那 33 檔外股 —— 只讓子題材展開的話，它們會從畫面上整個消失。
   */
  cells: new Set(),
};

const KEYS = { span: 'stocktracker.crossspan', mode: 'stocktracker.crossmode', sort: 'stocktracker.crosssort' };

const SORTS = [
  { value: 'weak', label: '最弱的一市' },
  { value: 'mid', label: '四市中位' },
  { value: 'tw', label: '台股' },
];
const MODES = [
  { value: 'raw', label: '原始漲跌' },
  { value: 'ex', label: '扣掉各自大盤' },
];

const NARROW_MQ = '(max-width: 767px)';
const narrow = () => window.matchMedia(NARROW_MQ).matches;

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v, digits = 1) => (v === null || v === undefined
  ? '—'
  : v.toLocaleString('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const trend = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const signedPct = (v, digits = 1) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${num(v, digits)}%`);
const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  if (!s.length) return null;
  const h = s.length / 2;
  return s.length % 2 ? s[Math.floor(h)] : (s[h - 1] + s[h]) / 2;
};

const markets = () => state.data.markets;
const spanLabel = () => state.data.spans[state.span] || '';
const modeLabel = () => (MODES.find((m) => m.value === state.mode) || MODES[0]).label;

/*
 * 一格的值。
 *
 * 原始模式就是中位數本身；超額模式扣掉**那個市場自己的大盤**——美股整體漲 2% 的時候，
 * 一個漲 2% 的美股題材其實什麼也沒說。兩個數字都由 build 給好，這裡只做減法。
 */
function valueOf(g, mk) {
  const cell = g.cells[mk.k];
  if (!cell) return null;
  const v = cell.med[state.span];
  if (v === null || v === undefined) return null;
  if (state.mode === 'raw') return v;
  const base = mk.chg[state.span];
  return (base === null || base === undefined) ? null : v - base;
}

/** 這一族在各市場的值（有資料的才進來）。 */
const valuesOf = (g) => markets().map((mk) => valueOf(g, mk)).filter((v) => v !== null);

/**
 * 排序鍵。
 *
 * weak 取最小值，那是整頁的主張：四個市場裡跑最慢的那一個也在漲，才算這個題材在漲。
 * 只有一個市場有資料時不給 weak 值——一個市場的「最弱」不是最弱，是全部。
 */
function sortKey(g) {
  const vals = valuesOf(g);
  if (!vals.length) return null;
  if (state.sort === 'tw') return valueOf(g, markets().find((m) => m.k === 'tw'));
  if (state.sort === 'mid') return median(vals);
  return vals.length >= 2 ? Math.min(...vals) : null;
}

const sortedGroups = () => state.data.groups.slice().sort((a, b) => {
  const [x, y] = [sortKey(a), sortKey(b)];
  if (x === null) return 1;
  if (y === null) return -1;
  return y - x;
});

/*
 * 「最弱」那一欄的橫條：滿格基準是全表絕對值的第 90 百分位，不是最大值。
 * 與日股頁同一個理由與同一個百分位——用最大值的話尺會被離群值吃掉。
 * 隨期間與模式重算（昨日與季差一個量級，原始與超額也是），但不隨展開收合變動。
 */
let barMax = 1;
function computeBarMax() {
  const mags = [];
  for (const g of state.data.groups) {
    const k = sortKey(g);
    if (k !== null) mags.push(Math.abs(k));
  }
  mags.sort((a, b) => a - b);
  barMax = mags.length ? Math.max(1, mags[Math.floor(mags.length * 0.9)]) : 1;
}

// --------------------------------------------------------------------------
// 版面
// --------------------------------------------------------------------------

function intro(data) {
  const asof = markets().map((m) => `${esc(m.label)} ${esc(m.asof)}`).join('、');
  return `<p class="pair-sub">同一個題材在美、日、韓、台四個市場的溫度，橫著比。
    <b>同時走強，跟只有一個市場在動，是完全不同的兩件事</b>——前者後面多半有真的需求，
    後者多半是單一市場的資金或消息。所以預設排的是<b>最弱的那一市</b>：跑最慢的那一個
    也在漲，這個題材才算在漲。四欄量的是同一段日曆時間，各市場最後一場：${asof}。</p>`;
}

/*
 * 這一頁所有展得開的東西：每一個族群（展開它的子題材），以及每一個有資料的
 * 「列 | 市場」格子（展開那一格的成分股）——族群列的四格與子題材列的四格都算。
 *
 * 全開會重複：族群那一格給的是整族的成分股，子題材那幾格是它的子集合，同一檔
 * 因此在兩個區塊各出現一次。那是這一頁本來的結構（手動把兩層都點開也是這樣），
 * 「全部展開」的定義就是「每一個 ▸ 都變成 ▾」，不在這裡偷偷少開幾格。
 */
function expandable() {
  const groups = [];
  const cells = [];
  for (const g of state.data.groups) {
    groups.push(g.name);
    markets().forEach((mk) => { if (g.cells[mk.k]) cells.push(`${g.name}|${mk.k}`); });
    for (const s of g.subs) {
      const rowId = `${g.name}|${s.name}`;
      markets().forEach((mk) => { if (s.cells[mk.k]) cells.push(`${rowId}|${mk.k}`); });
    }
  }
  return { groups, cells };
}

/** 全開了沒有。全開的時候那顆按鈕要變成「全部收起」，不然它按下去沒有任何事發生。 */
function allExpanded() {
  const { groups, cells } = expandable();
  return groups.length > 0
    && groups.every((n) => state.open.has(n))
    && cells.every((k) => state.cells.has(k));
}

/** 全開之後會多出幾列個股——按鈕的 title 要先講，一千多列不該是按下去才知道。 */
function expandedRows() {
  let n = 0;
  for (const g of state.data.groups) {
    markets().forEach((mk) => { n += g.cells[mk.k] ? g.cells[mk.k].codes.length : 0; });
    for (const s of g.subs) {
      markets().forEach((mk) => { n += s.cells[mk.k] ? s.cells[mk.k].codes.length : 0; });
    }
  }
  return n;
}

function controls(data) {
  const pills = (name, options, current) => `<div class="pills">${options
    .map((o) => `<button class="pill ${o.value === current ? 'active' : ''}" data-${name}="${o.value}">${esc(o.label)}</button>`)
    .join('')}</div>`;
  const spanOpts = data.spans.map((label, i) => ({ value: String(i), label }));
  const all = allExpanded();
  // 一顆按鈕輪流當兩個動作：展開／收起是同一件事的兩個方向，擺成兩顆永遠有一顆是死的。
  const expand = `<div class="pills"><button class="pill wide" data-expand="${all ? 'none' : 'all'}"
    title="${all ? '收掉所有展開的族群、子題材與個股' : `展開所有族群、子題材與四市成分股（約 ${expandedRows()} 列個股）`}"
    >${all ? '全部收起' : '全部展開'}</button></div>`;
  return `<div class="pair-controls">
    <label class="ctl"><span>看哪一段</span>${pills('span', spanOpts, String(state.span))}</label>
    <label class="ctl"><span>怎麼比</span>${pills('mode', MODES, state.mode)}</label>
    <label class="ctl"><span>排序</span>${pills('sort', SORTS, state.sort)}</label>
    <label class="ctl"><span>整頁</span>${expand}</label>
  </div>`;
}

function benchCard(data) {
  if (!data.bench || !data.bench.length) return '';
  const cells = data.bench.map((b) => {
    const spans = data.spans.map((s, i) => {
      const v = (b.chg || [])[i];
      return `${esc(s)} <span class="${trend(v)}">${signedPct(v)}</span>`;
    }).join(' · ');
    return `<div>
      <div class="bname">${esc(b.n)}</div>
      <div class="bval">${num(b.px, 0)}</div>
      <div class="bspans">${spans}</div>
    </div>`;
  }).join('');
  return `<div class="bench">${cells}</div>
    <p class="pair-hint">大盤是各市場的底，也是<b>扣掉各自大盤</b>那個模式減掉的東西。
      <b>費城半導體</b>不是任何一個市場的底（超額不拿它減），它擺在這裡是因為這一頁
      多數題材真正的景氣指標是它，不是那斯達克。</p>`;
}

/** 一格：值 + 該市場算了幾檔（檔數少的那一格要打折扣，一檔的中位數就是那一檔）。 */
function cell(g, mk, rowId) {
  const v = valueOf(g, mk);
  if (v === null) return '<td class="flat">—</td>';
  const n = g.cells[mk.k].codes.length;
  const on = state.cells.has(`${rowId}|${mk.k}`);
  return `<td class="hit ${trend(v)}${n === 1 ? ' thin' : ''}${on ? ' open' : ''}"`
    + ` data-row="${esc(rowId)}" data-mk="${esc(mk.k)}"`
    + ` title="${esc(mk.label)} ${n} 檔的中位數，點開看是哪幾檔">${signedPct(v)}</td>`;
}

/** 個股那一列的值。與上面同一個模式：超額就扣掉那個市場自己的大盤。 */
function stockValue(row, mk) {
  const v = (row.chg || [])[state.span];
  if (v === null || v === undefined) return null;
  if (state.mode === 'raw') return v;
  const base = mk.chg[state.span];
  return (base === null || base === undefined) ? null : v - base;
}

/*
 * 一格展開之後的個股列。
 *
 * 四欄裡只填它自己那一欄 —— 一檔個股只屬於一個市場，把數字塞到別欄會讓人以為
 * 那是跨市場的東西。空著的三欄同時也是縮排，一眼看得出這幾列屬於哪一國。
 *
 * 依當下那一段排序，領先的在上面：問的是「誰在推這個中位數」。
 */
function stockRows(cells, mk, rowId, label) {
  const c = cells[mk.k];
  if (!c) return '';
  const pool = state.data.stocks[mk.k] || {};
  const rows = c.codes.map((t) => ({ t, ...pool[t] })).filter((r) => r.chg);
  rows.sort((a, b) => {
    const [x, y] = [stockValue(a, mk), stockValue(b, mk)];
    if (x === null) return 1;
    if (y === null) return -1;
    return y - x;
  });
  const med = valueOf({ cells }, mk);
  // 台股那幾列的色條與那一個字要換成藍的。class 用 tw 不是並排表的 t —— 那邊的
  // tr.t 還帶著 .nm 與 .cd 的縮排，沿用會把這裡的對齊一起繼承走。
  const cls = mk.k === 'tw' ? ' tw' : '';
  const head = `<tr class="pc${cls}"><td colspan="${markets().length + 2}">
      <b>${esc(mk.label)}</b>的${esc(label)} ${rows.length} 檔
      · 中位 ${signedPct(med)} · 依${esc(spanLabel())}排序</td></tr>`;
  const body = rows.map((r) => {
    const v = stockValue(r, mk);
    const px = r.px === null || r.px === undefined ? '' : ` · ${num(r.px, mk.dp)} ${esc(mk.cur)}`;
    const ident = `<span class="tag">${esc(mk.tag)}</span><span class="nm">${esc(r.n || r.t)}</span>`
      + `<span class="cd">${esc(r.t)}${px}</span>`;
    // 台股點得進個股頁；外股沒有對應的頁面，就不要做成看起來點得動的樣子
    const name = mk.k === 'tw'
      ? `<a href="index.html#/stock/${esc(r.t)}">${ident}</a>` : ident;
    const cols = markets().map((m) => (m.k === mk.k
      ? `<td class="${trend(v)}">${signedPct(v)}</td>` : '<td></td>')).join('');
    return `<tr class="p${cls}"><td>${name}</td>${cols}<td></td></tr>`;
  }).join('');
  return head + body;
}

/** 這一列底下所有展開了的市場，照市場順序排。 */
const openStocks = (cells, rowId, label) => markets()
  .filter((mk) => state.cells.has(`${rowId}|${mk.k}`))
  .map((mk) => stockRows(cells, mk, rowId, label)).join('');

function weakCell(g) {
  const k = sortKey(g);
  if (k === null) return '<td class="gap flat">—</td>';
  const w = Math.min(72, Math.max(2, Math.round((Math.abs(k) / barMax) * 72)));
  return `<td class="gap ${trend(k)}">${signedPct(k)}<span class="bar" style="width:${w}px"></span></td>`;
}

/** 四個市場都有資料而且都在漲——這一頁真正要找的東西，值得一個記號。 */
function badge(g) {
  const vals = markets().map((mk) => valueOf(g, mk));
  const have = vals.filter((v) => v !== null);
  if (have.length < 3 || !have.every((v) => v > 0)) return '';
  return `<span class="all">${have.length} 市全漲</span>`;
}

const counts = (g) => markets()
  .map((mk) => (g.cells[mk.k] ? `${esc(mk.tag)}${g.cells[mk.k].codes.length}` : ''))
  .filter(Boolean).join(' · ');

/*
 * 子題材那一列。
 *
 * 名字點下去＝**把四個市場的成分股一次攤開**，格子點下去＝只開那一個市場。
 *
 * 一開始只做了後者，而族群列的名字是點得動的（展開子題材）——同樣一列的名字，
 * 上面一層點得動、下面一層點不動，而且下面一層連個 ▸ 都沒有，看起來就是最底層。
 * 使用者做了最自然的動作（點名字）然後什麼都沒發生。
 *
 * 「一次攤開四市」在這一層才可行：子題材四市合計中位 12 檔、最多 41 檔。族群層
 * 不給這個動作，那裡光台股就可能 65 檔（AI 伺服器），所以族群的名字留給子題材，
 * 要看個股就點它的格子。
 */
function subRow(s, gname) {
  const rowId = `${gname}|${s.name}`;
  const mks = markets().filter((mk) => s.cells[mk.k]).map((mk) => mk.k);
  const open = mks.some((k) => state.cells.has(`${rowId}|${k}`));
  return `<tr class="s" data-row="${esc(rowId)}" data-mks="${esc(mks.join(','))}">
      <td><span class="caret">${open ? '▾' : '▸'}</span><span class="nm">${esc(s.name)}</span>
        <span class="cd">${counts(s)}</span></td>
      ${markets().map((mk) => cell(s, mk, rowId)).join('')}
      ${weakCell(s)}
    </tr>` + openStocks(s.cells, rowId, s.name);
}

function groupRows(g) {
  const open = state.open.has(g.name);
  const head = `<tr class="g" data-group="${esc(g.name)}">
      <td><span class="caret">${open ? '▾' : '▸'}</span>${esc(g.name)}${badge(g)}
        <span class="sub">${counts(g)}${g.subs.length ? ` · ${g.subs.length} 個子題材` : ''}</span></td>
      ${markets().map((mk) => cell(g, mk, g.name)).join('')}
      ${weakCell(g)}
    </tr>`;
  // 族群那一格展開的個股擺在子題材前面：剛點的東西要在看得到的地方
  return head + openStocks(g.cells, g.name, g.name)
    + (open ? g.subs.map((s) => subRow(s, g.name)).join('') : '');
}

function table(groups) {
  const head = '<th>題材</th>'
    + markets().map((m) => `<th>${esc(m.tag)}</th>`).join('')
    + `<th class="on">${state.sort === 'weak' ? '最弱' : state.sort === 'mid' ? '中位' : '台股'}</th>`;
  return `<div class="scroller">
    <table class="pair cross">
      <thead><tr>${head}</tr></thead>
      <tbody>${groups.map(groupRows).join('')}</tbody>
    </table>
  </div>`;
}

function howToRead(data) {
  return `<div class="pair-note">
    <h2>怎麼讀</h2>
    <ul>
      <li>每一格是那個市場、那一族<b>成分股漲跌幅的中位數</b>，不是加權也不是平均——
        一族裡常有一兩檔暴衝，用平均會被它拉著走。滑過去看得到那一格算了幾檔；
        <b>只有一檔的那一格會淡一階</b>，那不是中位數，就是那一檔。</li>
      <li><b>最弱</b>是四個市場裡最小的那一個值，也是預設的排序。它是這一頁的主張：
        跑最慢的那一個市場也在漲，這個題材才算在漲。只有一個市場有資料時不給值。</li>
      <li><b>扣掉各自大盤</b>那個模式是每一格減去它自己市場的指數（美股減那斯達克、
        日股減日經、韓股減 KOSPI、台股減加權）。美股整體漲 2% 的時候，一個漲 2% 的
        美股題材其實什麼也沒說。</li>
      <li>期間用<b>台股的交易日</b>回推（昨日 1 日、週 5 日、月 21 日、季 63 日），
        算出起訖<b>日期</b>之後四個市場各自取那一天或之前最後一筆。所以四欄量的是
        同一段日曆時間，不是各自回推 N 天——那在四份日曆上會落到四個不同的日期。</li>
      <li><b>${esc(data.spans[state.span])}</b>這一段是 ${esc(data.starts[state.span])}
        到 ${esc(data.end)}。</li>
      <li>點族群那一列可以<b>展開子題材</b>。子題材只列至少兩個市場有東西的，
        單一市場的那些在排行榜的<a class="accent" href="index.html#/sector">族群</a>分頁看。</li>
      <li><b>點任何一格數字，就會列出那個市場、那一族的成分股</b>，依當下這一段排序，
        領先的在上面——中位數答不出「是誰在推」。族群那一格與子題材那一格都點得動，
        而<b>只標在族群層、沒有落進任何子題材的外股，只有點族群那一格才看得到</b>。
        台股那幾列點得進個股頁。</li>
      <li><b>點子題材的名字，四個市場的成分股會一次攤開</b>（合計多半十幾檔）。
        族群的名字不給這個動作，它留給展開子題材——族群層光台股就可能六十幾檔。</li>
    </ul>
  </div>`;
}

function methodNote(data) {
  const asof = markets().map((m) => `${esc(m.label)} ${esc(m.asof)}`).join('、');
  return `<div class="pair-note">
    <h2>這一頁怎麼算的</h2>
    <p><b>四欄的時間不完全對齊，而且擋不掉。</b>四個市場<b>共同</b>有開盤的交易日，
      最後一天會被假期拖得很遠——2026 年 9 月那一次是日本 21～23 休、韓國中秋 24～25 休，
      共同的最後一天停在 09-18。一頁叫做「現在什麼題材在漲」的東西落後六天就沒有意義了，
      所以這裡不取交集，改用同一段日曆視窗，各市場用自己最新的那一場：${asof}。
      差的那一兩天看得見，就印在上面。</p>
    <p><b>美股那一欄比其他三欄晚收一輪。</b>美股 ${esc(data.end)} 那一場收在台北時間隔天
      清晨，台股 ${esc(data.end)} 收盤時還沒發生；日股與韓股則是台北時間 8:00–14:30，
      與台股同一場。所以美股那一欄含的是<b>台股還沒反映的那一夜</b>——對「現在什麼題材
      在漲」來說那是最新的資訊不是誤差，但「昨日」那一段要知道它領先一輪。</p>
    <p><b>與站上另外三頁的數字不一樣，三邊都沒錯。</b>日股頁與韓股頁的台股那一欄是
      每個子族群取<b>成交值前十檔</b>（那兩頁要的是配對），這一頁取整族<b>全部有 K 線的
      成分股</b>（要的是整族的體溫）。排行榜的<a class="accent" href="index.html#/sector">族群</a>
      分頁則是當日的<b>成交值加權</b>漲跌，問的是「今天錢往哪一族去」。</p>
    <p><b>期間最長只到季</b>，台股的日 K 線從 ${esc(data.from)} 才開始，湊不出一年。
      漲跌幅沒有還原除權息，台股多在 7–8 月配息，跨過那一段的區間會被低估。
      外國那三欄的成分股來自三份人工對照表，是<b>代表性的幾檔不是全部成員</b>；
      台股那一欄才是整族。所以四欄的檔數差很多，滑過每一格看得到。</p>
  </div>`;
}

function render() {
  const data = state.data;
  computeBarMax();
  const groups = sortedGroups();

  $('#meta').textContent = `${groups.length} 個題材 · 看${spanLabel()} · ${modeLabel()}`
    + ` · 到 ${data.end}`;

  $('#view').innerHTML = `
    ${intro(data)}
    ${controls(data)}
    ${benchCard(data)}
    ${table(groups)}
    ${howToRead(data)}
    ${methodNote(data)}`;
}

// --------------------------------------------------------------------------
// 啟動
// --------------------------------------------------------------------------
document.addEventListener('click', (ev) => {
  /*
   * 全部展開／全部收起。要排在 .pill 前面判斷：它自己也是一顆 .pill（長相與那三組
   * 一樣），掉進下面那一段的話 span／mode／sort 三個都是 undefined，等於白畫一次。
   */
  const expand = ev.target.closest('[data-expand]');
  if (expand) {
    if (expand.dataset.expand === 'all') {
      const { groups, cells } = expandable();
      groups.forEach((n) => state.open.add(n));
      cells.forEach((k) => state.cells.add(k));
    } else {
      state.open.clear();
      state.cells.clear();
    }
    render();
    return;
  }
  const pill = ev.target.closest('.pill');
  if (pill) {
    const { span, mode, sort } = pill.dataset;
    if (span !== undefined) state.span = Number(span);
    if (mode !== undefined) state.mode = mode;
    if (sort !== undefined) state.sort = sort;
    try {
      localStorage.setItem(KEYS.span, String(state.span));
      localStorage.setItem(KEYS.mode, state.mode);
      localStorage.setItem(KEYS.sort, state.sort);
    } catch (err) { /* 無痕模式 */ }
    render();
    return;
  }
  /*
   * 格子要排在族群列前面判斷：族群列上的格子點下去應該是「展開這一格的個股」，
   * 不是「收合整族」—— 兩個動作疊在同一個元素上，先判斷小的那一個。
   */
  const hit = ev.target.closest('td.hit');
  if (hit) {
    const key = `${hit.dataset.row}|${hit.dataset.mk}`;
    state.cells.has(key) ? state.cells.delete(key) : state.cells.add(key);
    render();
    return;
  }
  /*
   * 子題材那一列：名字（或那一列上任何不是數字格的地方）點下去，把它四個市場的
   * 成分股一起開或一起收。已經全開就收起來，否則補齊 —— 先點過單一格子再點名字，
   * 結果會是「其餘的也跟著開」，那比「全部收掉」合理。
   */
  const sub = ev.target.closest('tr.s[data-row]');
  if (sub) {
    const keys = (sub.dataset.mks || '').split(',').filter(Boolean)
      .map((k) => `${sub.dataset.row}|${k}`);
    const all = keys.length > 0 && keys.every((k) => state.cells.has(k));
    keys.forEach((k) => (all ? state.cells.delete(k) : state.cells.add(k)));
    render();
    return;
  }
  const grp = ev.target.closest('tr.g');
  if (grp) {
    const name = grp.dataset.group;
    state.open.has(name) ? state.open.delete(name) : state.open.add(name);
    render();
  }
});

window.matchMedia(NARROW_MQ).addEventListener('change', () => {
  if (state.data) render();
});

async function start() {
  try {
    const res = await fetch(`${DATA}/cross/index.json`, { cache: 'reload' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    $('#meta').textContent = '載入失敗';
    $('#view').innerHTML = `<p class="hint">讀不到 <code>data/cross/index.json</code>（${esc(err.message)}）。
      正常情況下每日排程會產生它；本機環境請先執行
      <code>python scripts/build_cross.py</code>（它吃的是 us／jp／kr 三份 market.json
      與台股的 kline/，都要先有）。前端版本 ${esc(APP_VERSION)}。</p>`;
    return;
  }
  try {
    /*
     * 沒存過要走 state 的預設值（週），所以空值必須先擋掉：Number(null) 與
     * Number('') 都是 0，會一路通過檢查把期間設成「昨日」。與 pair.js 同一段。
     */
    const saved = localStorage.getItem(KEYS.span);
    const span = saved ? Number(saved) : NaN;
    if (Number.isInteger(span) && span >= 0 && span < state.data.spans.length) state.span = span;
    const mode = localStorage.getItem(KEYS.mode);
    if (MODES.some((m) => m.value === mode)) state.mode = mode;
    const sort = localStorage.getItem(KEYS.sort);
    if (SORTS.some((s) => s.value === sort)) state.sort = sort;
  } catch (err) {
    /* 無痕模式讀不到，就用預設值 */
  }
  render();
}

start();
