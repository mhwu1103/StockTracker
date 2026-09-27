/*
 * 日股 × 台股族群（jp.html）。
 *
 * 與 us.html 一樣是獨立頁面，不是排行榜那支 SPA 的分頁：只讀 data/jp/index.json
 * 一份檔案，不吃交易日與範圍那一整套狀態。共用的只有 style.css 與 nav.js。
 *
 * 頁面回答的問題：日本這一段在動，台股這一族跟上了沒。
 *
 * ## 一族拆成子族群區塊
 *
 * 一族十幾檔日股堆成一排、台股再堆成一排，看不出誰對誰——半導體設備那一族裡，
 * 愛德萬對的是鴻勁與穎崴，東京威力科創對的是弘塑與辛耘，兩組人擠在同一段名單裡。
 *
 * 所以表格的單位是 group.blocks 裡的**區塊**（一個子族群）：日股在上、它的台股
 * 緊接在下，差距減的也是同一塊的日股中位數。切分在 build_jp.py 就做完了，
 * 這裡只照著畫。
 *
 * ## 為什麼是表格，不是 .row
 *
 * 全站的清單都用 .row（名次｜名稱｜一個數字，三欄格線）。這一頁不行：它要
 * **一次並排四個期間**再加一欄差距，七欄硬塞進三欄的格線，長字串會掉進
 * 3.4rem 那一欄被壓成一個字寬的直排——第一版就是這樣壞掉的。
 *
 * 並排比較的東西就該用表格。樣式在 style.css 的「日股頁」那一節。
 *
 * ## 這一頁沒有相關係數，是故意的
 *
 * 美股那一頁有，因為美股收在台股開盤之前，D → D+1 的對齊本身就是一個因果方向。
 * 日股沒有這個方向：東京 8:00（台北時間）開盤、台股 9:00，兩邊同一天同一盤。
 * 同日的相關係數分不出「日股領先一小時」與「兩邊都在反映昨夜美股」，而真正
 * 可交易的那一小時，日線資料量不到。
 *
 * 2026-09 實測過：同日原始相關普遍 +26~+70%，兩邊各自扣掉自己大盤後多數掉到
 * +5% 以內。放一個那樣的數字上來，只會被當成訊號用。所以這一頁只擺漲跌幅。
 * 完整的理由寫在 scripts/jp.py 的 docstring。
 *
 * 數字全部由 scripts/build_jp.py 算好，這裡只負責顯示——前端不做任何統計。
 */

const DATA = 'data';
const APP_VERSION = (() => {
  const src = document.currentScript?.src || '';
  return new URL(src, location.href).searchParams.get('v') || '?';
})();

const state = {
  data: null,
  span: 1,             // 差距與排序看哪一段：0 昨日、1 週、2 月、3 季
  closed: new Set(),   // 收起來的族群。預設全部展開——這一頁是拿來掃的
};

const SPAN_KEY = 'stocktracker.jpspan';

/*
 * 窄螢幕只擺「當期 · 差距」，四個期間並排是桌面才放得下的東西。
 *
 * 欄位的增減在產生 HTML 的時候就決定，不是用 CSS 把欄 display: none——跟 app.js
 * 的 WIDE_MQ 同一個理由。這裡還多一層：族群那一列是 colspan，CSS 藏掉欄之後
 * colspan 仍然按原本的欄數要空間，表格不但沒變窄，反而多撐出 73px。
 */
const NARROW_MQ = '(max-width: 767px)';
const narrow = () => window.matchMedia(NARROW_MQ).matches;

/** 這次要畫哪幾個期間欄，回傳的是 spans 的索引。 */
const spanCols = () => (narrow() ? [state.span] : state.data.spans.map((_, i) => i));

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v, digits = 1) => (v === null || v === undefined
  ? '—'
  : v.toLocaleString('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const trend = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const signedPct = (v, digits = 2) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${num(v, digits)}%`);
const STARS = { 3: '★★★', 2: '★★☆', 1: '★☆☆' };

/*
 * 收盤價一定要帶單位：日股是日圓、台股是台幣，13,075 円與 944 元擺在同一欄
 * 卻不能互相比較。單位與小數位數都由 build_jp.py 決定，前端不猜——指數與匯率
 * 的單位是空字串（那是點數不是錢），而日圓報價 156.13 四捨五入成整數就看不出
 * 當天的變化。
 */
const price = (r) => (r.px === null || r.px === undefined ? '—'
  : `${num(r.px, r.dp ?? 0)}${r.cur ? `<span class="cur">${esc(r.cur)}</span>` : ''}`);

const spanLabel = () => state.data.spans[state.span] || '';

function pills(name, options, current) {
  return `<div class="pills">${options
    .map((o) => `<button class="pill ${o.value === current ? 'active' : ''}" data-${name}="${o.value}">${esc(o.label)}</button>`)
    .join('')}</div>`;
}

/** 差距：台股中位 − 日股中位。正值代表台股走得比它的日本對照強。 */
function gapOf(g) {
  const j = g.jpMed[state.span];
  const t = g.twMed[state.span];
  return (j === null || j === undefined || t === null || t === undefined) ? null : t - j;
}

/*
 * 背離橫條的滿格基準：全表絕對差距的第 90 百分位，不是最大值。
 *
 * 用最大值的話尺會被離群值吃掉：某一週有一檔差距 31%，其餘 113 檔就全部擠在
 * 10px 以內（中位數 7px），橫條等於沒畫。改成 p90 之後中位數回到 20px 上下，
 * 代價是最極端的那一成會一起頂到滿格——它們之間要比大小得看數字。掃的是
 * 「誰脫隊」，那一成本來就都脫隊了。
 *
 * 不放進 state，因為它不是使用者選的東西，是這一次繪製的比例尺——每次 render
 * 依當下的期間重算。隨期間變是刻意的：昨日與季的波動差一個量級，共用一把尺
 * 會讓「昨日」那一欄的橫條全部縮成看不見的一點。
 *
 * 但不隨族群收合變動：收起一族就讓其他族的橫條跟著伸縮，會被讀成數字變了。
 */
const GAP_PCTL = 0.9;
let gapMax = 1;

function computeGapMax() {
  const mags = [];
  for (const g of state.data.groups) {
    for (const b of g.blocks) {
      const jm = b.jpMed[state.span];
      if (jm === null || jm === undefined) continue;
      for (const r of b.tw) {
        const v = (r.chg || [])[state.span];
        if (v === null || v === undefined) continue;
        mags.push(Math.abs(v - jm));
      }
    }
  }
  mags.sort((a, b) => a - b);
  // 下限 1%：全表都貼在一起的那一天，尺不該把 0.1% 的差距放大成滿格。
  gapMax = mags.length ? Math.max(1, mags[Math.floor(mags.length * GAP_PCTL)]) : 1;
}

function sortedGroups() {
  return state.data.groups.slice().sort((a, b) => {
    const [x, y] = [a.twMed[state.span], b.twMed[state.span]];
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    return y - x;
  });
}

// --------------------------------------------------------------------------
// 版面
// --------------------------------------------------------------------------

/*
 * 開頭那一段：固定的說明，不是算出來的導讀。
 *
 * 這一頁最容易被誤讀的地方是「日股領先台股」，那要在看到任何數字之前就講掉——
 * 講在下面的方法說明裡就太晚了，人會先看表。
 */
function intro(data) {
  return `<p class="jp-sub">供應鏈上對得起來的日股與台股，並排看漲跌幅。
    日股在台北時間 8:00 開盤，比台股早一小時——<b>同一天、同一盤，不是隔夜領先</b>。
    兩邊資料都到 ${esc(data.asof)}。</p>`;
}

/*
 * 控制列：pills 上面掛一個小標籤。
 *
 * 這一組 pills 決定的是最右邊那一欄與排序，不是整頁的期間——沒有標籤的話，
 * 它看起來像在切換整張表，但中間四欄不管選哪個都在。
 */
function controls(data) {
  const spanOpts = data.spans.map((label, i) => ({ value: String(i), label }));
  return `<div class="jp-controls">
    <label class="ctl">
      <span>差距欄看哪個期間</span>
      ${pills('span', spanOpts, String(state.span))}
    </label>
  </div>`;
}

/*
 * 大盤：三層格——名稱、價位、四個期間串成一行。
 *
 * 四個期間一次全排出來，不跟著上面的 pills 走：族群表已經有一欄在強調當下那一段，
 * 大盤是拿來當底的，要一眼看完整條時間線才知道「這一族比的是什麼」。
 */
function benchCard(data) {
  if (!data.bench || !data.bench.length) return '';
  const cells = data.bench.map((b) => {
    const spans = data.spans.map((s, i) => {
      const v = (b.chg || [])[i];
      return `${esc(s)} <span class="${trend(v)}">${signedPct(v, 1)}</span>`;
    }).join(' · ');
    return `<div>
      <div class="bname">${esc(b.n)}</div>
      <div class="bval">${price(b)}</div>
      <div class="bspans">${spans}</div>
    </div>`;
  }).join('');
  return `<div class="bench">${cells}</div>
    <p class="jp-hint">族群漲得比自己的大盤多才叫強。<b>美元日圓</b>那一格要反過來讀：
      它上漲＝日圓變弱，日廠報價競爭力上升，被動元件與工具機容易出現
      「日股漲、台股不跟」——紅色在那一格不代表好消息。</p>`;
}

const chgCells = (row) => spanCols().map((i) => {
  const v = (row.chg || [])[i];
  return `<td class="${trend(v)}${i === state.span ? ' on' : ''}">${signedPct(v, 1)}</td>`;
}).join('');

/*
 * 差距欄：數字後面跟一條橫條，長度是這一檔在全表裡的相對強弱。
 *
 * 一欄七十幾個帶正負號的百分比，要比大小得一個一個唸過去；橫條讓「誰特別脫隊」
 * 用掃的就看得到。顏色用 currentColor 跟著漲跌走，不另外配色——這一欄已經有
 * 紅綠了，橫條再挑一個顏色只會多一個要解讀的維度。
 */
function gapCell(v) {
  if (v === null || v === undefined) return '<td class="gap flat">—</td>';
  const w = Math.min(72, Math.max(2, Math.round((Math.abs(v) / gapMax) * 72)));
  return `<td class="gap ${trend(v)}">${signedPct(v, 1)}<span class="bar" style="width:${w}px"></span></td>`;
}

/*
 * 國別標籤只放一個字。
 *
 * 「日股」「台股」兩個字擺在每一列的最前面，一頁三百列就是三百次「股」——那個字
 * 從來不是在分辨什麼，分辨的是「日」與「台」。縮成一個字之後名稱往左收 14px，
 * 窄螢幕上剛好把被擠掉的名字放回來。顏色照舊由 .tag 的 CSS 給。
 */
const jpRow = (r) => `<tr class="s">
    <td><span class="tag">日</span><span class="nm">${esc(r.n)}</span>
      <span class="cd">${esc(r.t)} · ${STARS[r.s] || ''}</span></td>
    <td class="px">${price(r)}</td>
    ${chgCells(r)}
    <td class="gap flat">·</td>
  </tr>`;

const twRow = (r, jpMed) => {
  const v = (r.chg || [])[state.span];
  const gap = (v === null || v === undefined || jpMed === null || jpMed === undefined)
    ? null : v - jpMed;
  return `<tr class="s t">
    <td><a href="index.html#/stock/${esc(r.t)}"><span class="tag">台</span><span class="nm">${esc(r.n)}</span>
      <span class="cd">${esc(r.t)}${r.val ? ` · ${num(r.val / 1e8, 0)} 億` : ''}</span></a></td>
    <td class="px">${price(r)}</td>
    ${chgCells(r)}
    ${gapCell(gap)}
  </tr>`;
};

/*
 * 一個區塊：子族群的名字一列，接著這一塊的日股，再接著這一塊的台股。
 *
 * 區塊列的差距是兩邊中位數的差，跟族群列一樣不給橫條——橫條那把尺量的是個股，
 * 中位數擺上去會被當成同一個量級來比。
 *
 * 名字是空字串代表這一族沒切出任何子族群，整族就是一塊；那時不畫標題列，
 * 否則畫面上會多一條跟族群列講同一件事的空行。
 */
function blockRows(b, cols) {
  const jm = b.jpMed[state.span];
  const tm = b.twMed[state.span];
  const gap = (jm === null || jm === undefined || tm === null || tm === undefined)
    ? null : tm - jm;
  const head = b.name
    ? `<tr class="b">
        <td colspan="${cols}">${esc(b.name)}
          <span class="sub">日 ${signedPct(jm)} · 台 ${signedPct(tm)}</span></td>
        <td class="gap ${trend(gap)} on">${signedPct(gap, 1)}</td>
      </tr>`
    : '';
  return head + b.jp.map(jpRow).join('')
    + b.tw.map((r) => twRow(r, jm)).join('');
}

function groupRows(g) {
  const gap = gapOf(g);
  const open = !state.closed.has(g.name);
  const cols = 2 + spanCols().length;
  const head = `<tr class="g" data-group="${esc(g.name)}">
      <td colspan="${cols}"><span class="caret">${open ? '▾' : '▸'}</span>${esc(g.name)}
        <span class="sub">日股 ${signedPct(g.jpMed[state.span])}
          · 台股 ${signedPct(g.twMed[state.span])}
          · ${g.jpN} 檔日股、${g.twN} 檔台股</span></td>
      <td class="gap ${trend(gap)} on"><b>${signedPct(gap, 1)}</b></td>
    </tr>`;
  if (!open) return head;
  return head + g.blocks.map((b) => blockRows(b, cols)).join('');
}

function table(groups) {
  const head = ['<th>標的</th>', '<th>收盤</th>']
    .concat(spanCols().map((i) => `<th${i === state.span ? ' class="on"' : ''}>${esc(state.data.spans[i])}</th>`))
    .join('') + '<th class="on">差距</th>';

  return `<div class="scroller">
    <table class="jp">
      <thead><tr>${head}</tr></thead>
      <tbody>${groups.map(groupRows).join('')}</tbody>
    </table>
  </div>`;
}

/*
 * 怎麼讀：原本散在表格下方的兩段 note。
 *
 * 改成條列是因為它們回答的是彼此無關的六件事（單位、期間、顏色、差距、橫條、排序），
 * 寫成兩段連續的散文，要找「橫條是什麼意思」得整段讀過去。
 */
function howToRead(groups) {
  return `<div class="jp-note">
    <h2>怎麼讀</h2>
    <ul>
      <li><b>收盤</b>是股價不是百分比——日股是日圓、台股是台幣，兩邊不能互相比較。
        右邊四欄才是漲跌幅 %。</li>
      <li>期間用<b>交易日</b>回推：昨日 1 日、週 5 日、月 21 日、季 63 日。</li>
      <li><b>紅漲綠跌</b>，照台股與日股的慣例。名稱左邊的色條與那一個字是國別不是漲跌：
        磚紅是<b>日</b>、藍是<b>台</b>。</li>
      <li>每一族按<b>子族群</b>分塊：一塊是「這幾檔日股 → 對得上的這幾檔台股」，
        日股在上、它的台股緊接在下。「<b>對到整族</b>」那一塊裝的是對照表只標在族群層、
        沒有指定子族的日股。</li>
      <li><b>差距</b>是這一檔台股減去<b>同一塊裡日股的中位數</b>：正值代表它走得比
        那一段日股強，負值代表落後。減的是自己那一塊，不是整族。</li>
      <li><b>橫條</b>的長度是它在整張表裡的相對大小。尺以第 90 百分位為滿格，
        所以最極端的那一成會一起頂到底——要分它們得看數字。</li>
      <li>族群列與區塊列上的是兩邊中位數的差，<b>不給橫條</b>：那跟個股那一欄不是同一把尺。
        ${groups.length} 個族群依台股的漲跌排序，跌最多的在最下面；
        <b>點族群那一列可以收起來</b>。</li>
    </ul>
  </div>`;
}

function methodNote(data) {
  return `<div class="jp-note">
    <h2>這一頁怎麼算的</h2>
    <p><b>日股不是隔夜領先，是同一盤。</b>東京 9:00–15:30（日本時間）
      ＝台北 8:00–14:30，比台股早開一小時、晚收一小時。所以這裡是<b>同一天</b>的
      漲跌幅並排，不是美股那頁的「昨夜 → 今天」。日股比台股早開的那一小時，
      日線資料量不到。</p>
    <p><b>為什麼沒有相關係數。</b>同日的相關數字分不出「日股領先一小時」
      與「兩邊都在反映昨夜美股」。2026-09 實測 122 個交易日：同日原始相關普遍
      +26~+70%，但兩邊各自扣掉自己大盤之後多數掉到 +5% 以內——那些數字大半是
      「亞股一起動」。放上來只會被當成訊號用，所以不放。</p>
    <p><b>角色跟美股不一樣。</b>美股多半是需求端（客戶的財報決定訂單），
      日股多半是設備材料的<b>上游</b>或正面<b>競爭者</b>。缺料時是台廠受害而不是同漲，
      搶單時是此消彼長。星等 ${STARS[3]} 是「同一條供應鏈的上下游」、
      ${STARS[2]} 是「同業或同一景氣循環」、${STARS[1]} 是「題材情緒」——
      那是供應鏈上的假說，不是漲跌幅的預測。</p>
    <p><b>期間最長只到季。</b>台股的日 K 線從 ${esc(data.from)} 才開始，
      湊不出一年。這是資料的限制，不是參數可以調的。漲跌幅沒有還原除權息，
      台股多在 7–8 月配息，跨過那一段的區間會被低估。</p>
    <p>日股會被<b>裁到台股的最後一個交易日</b>（${esc(data.twAsof)}）：
      兩邊要量同一段時間，差距那一欄才有意義。每一塊的台股最多列 <b>10 檔</b>，依<b>最近一個
      交易日的成交值</b>排；多數子族群的成員不到 10 檔，等於全部列出，超過的才會被砍。
      要看整族的資金流向，去排行榜的
      <a class="accent" href="index.html#/sector">族群</a>分頁。</p>
  </div>`;
}

function render() {
  const data = state.data;
  computeGapMax();
  const groups = sortedGroups();

  $('#meta').textContent = `日股與台股都到 ${data.asof}`
    + ` · ${groups.length} 個族群 · 差距看${spanLabel()}`;

  $('#view').innerHTML = `
    ${intro(data)}
    ${controls(data)}
    ${benchCard(data)}
    ${table(groups)}
    ${howToRead(groups)}
    ${methodNote(data)}`;
}

// --------------------------------------------------------------------------
// 啟動
// --------------------------------------------------------------------------
document.addEventListener('click', (ev) => {
  const pill = ev.target.closest('.pill');
  if (pill && pill.dataset.span) {
    state.span = Number(pill.dataset.span);
    try { localStorage.setItem(SPAN_KEY, String(state.span)); } catch (err) { /* 無痕模式 */ }
    render();
    return;
  }
  const grp = ev.target.closest('tr.g');
  if (grp) {
    const name = grp.dataset.group;
    state.closed.has(name) ? state.closed.delete(name) : state.closed.add(name);
    render();
  }
});

window.matchMedia(NARROW_MQ).addEventListener('change', () => {
  if (state.data) render();
});

async function start() {
  try {
    const res = await fetch(`${DATA}/jp/index.json`, { cache: 'reload' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    $('#meta').textContent = '載入失敗';
    $('#view').innerHTML = `<p class="hint">讀不到 <code>data/jp/index.json</code>（${esc(err.message)}）。
      正常情況下每日排程會產生它；本機環境請先執行
      <code>python scripts/fetch_jp.py</code> 與 <code>python scripts/build_jp.py</code>。
      前端版本 ${esc(APP_VERSION)}。</p>`;
    return;
  }
  try {
    /*
     * 沒存過要走 state 的預設值（週），所以空值必須先擋掉：Number(null) 與
     * Number('') 都是 0，會一路通過下面三個檢查把期間設成「昨日」——第一次進
     * 這一頁的人看到的就不是我們選的那一欄，而畫面完全正常，不會有人回報。
     *
     * 用 truthy 判斷剛好：要保留的 '0' 是非空字串，擋掉的是 null 與 ''。
     */
    const saved = localStorage.getItem(SPAN_KEY);
    const span = saved ? Number(saved) : NaN;
    if (Number.isInteger(span) && span >= 0 && span < state.data.spans.length) state.span = span;
  } catch (err) {
    /* 無痕模式讀不到，就用預設值 */
  }
  render();
}

start();
