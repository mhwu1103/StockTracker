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

/*
 * 三個軸看同一份資料。
 *
 * 「看美股」問的是「昨晚這一檔在動，台股要盯誰」——一檔對一批，逐檔展開。
 * 「看族群」問的是「這一族昨晚整體在動嗎，台股這一族今天跟上了沒」——
 * 那件事在美股軸上看不出來：AI 伺服器有 28 檔美股，要展開 28 次才拼得回一個印象。
 * 「看並排」把族群軸的那兩個中位數攤開成一張表：一族裡**誰跟上了、誰脫隊了**。
 * 中位數答不出那件事，因為它本來就是拿來蓋掉個別差異的。
 *
 * 三個軸都只讀 index.json，沒有第二份資料——並排軸多的只是同一批標的在同一組期間
 * 上的漲跌幅（build_us.py 的 PAIR_SPANS）。
 */
const VIEWS = [
  { value: 'us', label: '看美股' },
  { value: 'group', label: '看族群' },
  { value: 'pair', label: '看並排' },
];

const state = {
  data: null,
  span: 60,          // 相關性的觀察窗（交易日）
  sort: 'corr',
  view: 'us',        // 'us' 看美股、'group' 看族群、'pair' 看並排
  open: new Set(),   // 展開中的美股代號，重畫之後要留著
  openG: new Set(),  // 展開中的族群名稱。與 open 分開，切換檢視時互不影響
  pairSpan: 1,       // 並排軸的差距欄看哪一段：0 昨夜、1 週、2 月、3 季
  closedP: new Set(),  // 並排軸收起來的族群。預設全部展開——那一張表是拿來掃的
};

const SPAN_KEY = 'stocktracker.usspan';
const SORT_KEY = 'stocktracker.ussort';
const VIEW_KEY = 'stocktracker.usview';
const PAIR_KEY = 'stocktracker.uspairspan';

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
// 一列的長相是 [code, name, label, s, r20, x20, lo20, hi20, r60, …, n]：每個觀察窗
// 四欄（原始、超額、滾動相關的最低與最高）。
//
// **照名字查位置，不要照算式算**。第一版是 `4 + spans.indexOf(span) * 2`，後來一個
// 觀察窗從兩欄變四欄，那個 2 就散在前後端各一份 —— build_us.py 裡的同一個算式當時
// 正好漏改了一處。改成讀 cols 這份自帶的欄名表，加欄位時兩邊都不必動。
// --------------------------------------------------------------------------
let colIdx = new Map();
const colAt = (kind, span = state.span) => colIdx.get(`${kind}${span}`);
const cellOf = (row, kind) => {
  const at = colAt(kind);
  return at === undefined ? null : row[at];
};
const corrOf = (row, kind = 'r') => cellOf(row, kind);

// 這兩欄不隨觀察窗變，但也要照欄名查：以前寫成 row[row.length - 1]，
// 列尾一多欄（twchg）就整個錯位，而且錯得很安靜——天數會變成漲跌幅。
const daysOf = (row) => row[colIdx.get('n')];
const twChgOf = (row) => row[colIdx.get('twchg')];

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

/**
 * 相關性那一格底下的小圖：**擺盪範圍是主體，現在的值是一根豎標**。
 *
 * 淡帶是滾動相關的範圍（把觀察窗從資料起點一路滑到今天，最低與最高到過哪裡）。
 * 同樣是 +50%，一路都在 40~60 之間，與半年前還是 −20%、最近才衝上來，是完全不同的
 * 兩件事，而單一個數字分不出來。豎標落在帶子的哪裡，就是現在在自己的歷史區間哪裡。
 *
 * 第一版是把現值畫成「從 0 拉到現值」的長條、帶子墊在底下 —— 實測是**看不見的**：
 * 這批資料的最低點大多接近 0、而現值又常常就是最高點，於是兩個矩形幾乎重合
 * （量到帶子 [27,14]px、長條 [26,15]px）。長度在這一格沒有意義，位置才有，
 * 所以現值改成一根豎標，長條退場。數值本來就印在正上方，不必再用長度講一次。
 */
// --------------------------------------------------------------------------
// 族群軸
//
// 族群名稱本來就在資料裡：labels 是「族群」或「族群 › 子群」，每一筆台股連結都帶著
// 它的索引。這裡只取頂層那一段重新分組，不需要任何新資料。
//
// 一族給三個數字，回答三個不同的問題：
//   中位相關  這一族綁得緊不緊（所有配對在目前觀察窗下的相關性中位數）
//   美股昨夜  這一族的因動了沒（族裡每一檔美股 d1 漲跌的中位數）
//   台股今天  果跟上了沒（族裡每一檔台股當日漲跌的中位數）
//
// 用中位數不用平均：一族裡常有一兩檔暴衝（軍工那族只有 6 檔台股），
// 平均會被它拉著走，中位數講的才是「這一族大致上怎麼樣」。
// --------------------------------------------------------------------------

/** 「AI 伺服器 › 散熱」-> 「AI 伺服器」。子群在族群軸上併回母族。 */
const topGroup = (label) => String(label || '').split(' › ')[0];

/**
 * 依族群重新分組。回傳每一族的美股、台股與三個中位數，已照目前的排序排好。
 *
 * 台股會在好幾檔美股底下重複出現（穩懋同時對 AAOI 與 CRDO），所以這裡用 Map 去重，
 * 留相關性最高的那一組當代表——列出來的是「這一檔台股在這一族裡最強的連動」。
 */
function groupsOf(items) {
  const labels = state.data.labels || [];
  const byName = new Map();
  for (const item of items) {
    for (const row of item.links) {
      const name = topGroup(labels[row[2]]);
      if (!name) continue;
      let g = byName.get(name);
      if (!g) {
        g = { name, us: new Map(), tw: new Map(), corrs: [], pairs: 0 };
        byName.set(name, g);
      }
      g.pairs += 1;
      const r = corrOf(row);
      if (r !== null && r !== undefined) g.corrs.push(r);

      let u = g.us.get(item.t);
      if (!u) {
        u = { t: item.t, n: item.n, chg: item.chg?.d1 ?? null, corrs: [] };
        g.us.set(item.t, u);
      }
      if (r !== null && r !== undefined) u.corrs.push(r);

      const code = row[0];
      const prev = g.tw.get(code);
      if (!prev || (r ?? -Infinity) > (prev.r ?? -Infinity)) {
        g.tw.set(code, { code, name: row[1], chg: twChgOf(row), r, via: item.t, s: row[3] });
      }
    }
  }

  const out = [...byName.values()].map((g) => ({
    ...g,
    us: [...g.us.values()].map((u) => ({ ...u, mid: median(u.corrs) }))
      .sort((a, b) => (b.mid ?? -Infinity) - (a.mid ?? -Infinity)),
    tw: [...g.tw.values()].sort((a, b) => (b.r ?? -Infinity) - (a.r ?? -Infinity)),
    corr: median(g.corrs),
    usChg: median([...g.us.values()].map((u) => u.chg).filter((v) => v !== null && v !== undefined)),
    twChg: null,   // 下面補：要等 tw 去重之後才算得準
  }));
  for (const g of out) {
    g.twChg = median(g.tw.map((t) => t.chg).filter((v) => v !== null && v !== undefined));
  }

  if (state.sort === 'chg') {
    return out.sort((a, b) => (b.usChg ?? -Infinity) - (a.usChg ?? -Infinity));
  }
  if (state.sort === 'code') return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  return out.sort((a, b) => (b.corr ?? -Infinity) - (a.corr ?? -Infinity));
}

/** 展開後的美股那一列：這一族裡它對到幾檔、它自己昨夜走多少。 */
const groupUsRow = (u) => `<div class="row">
    <div class="rank"><span class="no sm ${trend(u.mid)}">${corrText(u.mid)}</span>
      <span class="delta">中位</span></div>
    <div class="ident"><span class="name">${esc(u.t)} ${esc(u.n)}</span>
      <span class="code">${u.corrs.length} 組配對在這一族</span></div>
    <div class="figures"><span class="value ${trend(u.chg)}">${signedPct(u.chg)}</span>
      <span class="price">昨夜</span></div>
  </div>`;

/** 展開後的台股那一列：它今天走多少，以及它在這一族裡最強的那一組連動。 */
const groupTwRow = (t) => `<a class="row" href="index.html#/stock/${esc(t.code)}">
    <div class="rank"><span class="no sm ${trend(t.r)}">${corrText(t.r)}</span>
      <span class="delta">${esc(t.via)}</span></div>
    <div class="ident"><span class="name">${esc(t.name)}</span>
      <span class="code">${esc(t.code)} · 標註 ${STARS[t.s] || ''}</span></div>
    <div class="figures"><span class="value ${trend(t.chg)}">${signedPct(t.chg)}</span>
      <span class="price">今天</span></div>
  </a>`;

function groupRow(g) {
  const summary = `<div class="rank"><span class="no sm ${trend(g.corr)}">${corrText(g.corr)}</span>
        <span class="delta">中位</span></div>
      <div class="ident"><span class="name">${esc(g.name)}</span>
        <span class="code">${g.us.length} 檔美股 · ${g.tw.length} 檔台股
          · ${g.pairs} 組配對</span></div>
      <div class="figures"><span class="value ${trend(g.usChg)}">${signedPct(g.usChg)}</span>
        <span class="price">台股今天 ${tint(g.twChg, signedPct(g.twChg))}</span></div>`;
  return `<details class="sector" ${state.openG.has(g.name) ? 'open' : ''}>
    <summary class="row">${summary}</summary>
    <div class="sector__body" data-group="${esc(g.name)}"></div>
  </details>`;
}

function groupCard(groups) {
  return `<section class="card">
    <h2>族群 <small>${groups.length} 族 · 點一列展開它兩邊各有誰</small></h2>
    ${groups.map(groupRow).join('')}
    <p class="note">左邊是這一族<b>所有配對的相關性中位數</b>——它回答「這一族到底綁得
      緊不緊」，跟任何單一檔都無關。右邊上面是<b>昨夜美股</b>這一族的漲跌中位數，
      下面是<b>今天台股</b>這一族的。兩個數字並排，才看得出因動了、果有沒有跟上。</p>
    <p class="note">都用中位數，不用平均：一族裡常有一兩檔暴衝，平均會被它拉著走。
      台股在好幾檔美股底下會重複出現（穩懋同時對 AAOI 與 CRDO），這裡去重後只留
      相關性最高的那一組，左邊那個小標就是它從哪一檔美股來的。</p>
    <p class="note">⚠️ 台股那一邊是<b>對照表裡的那些</b>，不是這一族的全部成員——
      人工標註只挑得出代表性的幾檔。要看整族的資金流向，去排行榜的
      <a class="accent" href="index.html#/sector">族群</a>分頁。</p>
  </section>`;
}

// --------------------------------------------------------------------------
// 並排軸
//
// 與日股頁（jp.html）是同一張表——連 CSS 都是同一份（.pair-* 與 table.pair）。
// 分塊的單位是「族群 › 子族群」，那正好是 labels 本來的形狀，所以不需要新資料：
// 一族裡的美股其實分屬不同環節（AI 伺服器那一族，SMCI 對的是伺服器組裝、
// VRT 對的是機房電力與散熱），堆成一排美股、一排台股就讀不出誰對誰。
//
// 這個軸上**沒有相關係數**，理由跟日股頁不一樣：那裡是算不出有意義的數字
// （同一盤，沒有因果方向），這裡是**另外兩個軸已經整頁在講它**。同一張表上並排
// 擺相關性與漲跌幅，會被讀成「相關性高所以今天會跟」——而這一頁自己的散點圖
// 正好在說那件事沒有那麼牢靠。
//
// 期間也與相關性的觀察窗無關：那一組是 20／60／120 日的窗，這一組是「這一段各走了
// 多少」。兩邊的天數完全一樣（build_us.py 的 PAIR_SPANS），差距那一欄才是同一段
// 時間的比較。
// --------------------------------------------------------------------------

/*
 * 窄螢幕只擺「當期 · 差距」，四個期間並排是桌面才放得下的東西。
 *
 * 欄位的增減在產生 HTML 的時候就決定，不是用 CSS 把欄 display: none——族群那一列
 * 是 colspan，CSS 藏掉欄之後 colspan 仍然按原本的欄數要空間，表格不但沒變窄，
 * 反而更寬（jp.js 踩過這一個，那邊多撐出 73px）。
 */
const NARROW_MQ = '(max-width: 767px)';
const narrow = () => window.matchMedia(NARROW_MQ).matches;
const pairSpans = () => state.data.pairSpans || [];
const pairCols = () => (narrow() ? [state.pairSpan] : pairSpans().map((_, i) => i));
const pairLabel = () => pairSpans()[state.pairSpan] || '';

/** 沒有落進任何子族群的那一塊。不是子族群的名字，是「對到整族」的意思。 */
const REST_NAME = '對到整族';

/*
 * 收盤價一定要帶單位：美股是美元、台股是台幣，430.26 與 2,460 擺在同一欄卻不能
 * 互相比較。單位是給人分辨的標記，不是數字的一部分。
 */
const priceCell = (v, unit) => (v === null || v === undefined ? '—'
  : `${num(v, 2)}${unit ? `<span class="cur">${esc(unit)}</span>` : ''}`);

const pairMeds = (rows) => pairSpans().map((_, i) => median(
  rows.map((r) => (r.chg || [])[i]).filter((v) => v !== null && v !== undefined)));

/** 同一檔會被同一族的兩個子族用到，族群層的中位數不能算它兩次。 */
function uniqBy(rows) {
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.t) ? false : seen.add(r.t)));
}

/**
 * 依「族群 › 子族群」重新分組，回傳已排好序的族群。
 *
 * 星等同一檔在兩個層級可能不同（族群層的標註套到子族群時會降一級，見 us.py），
 * 這裡取最高的：那是對照表自己該修的事，不是這裡要調解的。台股在好幾檔美股底下會
 * 重複出現（穩懋同時對 AAOI 與 CRDO），同一塊裡只留一列。
 */
function pairGroups(items) {
  const labels = state.data.labels || [];
  const twAll = state.data.tw || {};
  const byName = new Map();

  for (const item of items) {
    if (!item.pchg) continue;
    for (const row of item.links) {
      const label = labels[row[2]] || '';
      if (!label) continue;
      const [top, sub = ''] = label.split(' › ');
      let g = byName.get(top);
      if (!g) { g = { name: top, blocks: new Map() }; byName.set(top, g); }
      let b = g.blocks.get(sub);
      if (!b) { b = { name: sub, us: new Map(), tw: new Map() }; g.blocks.set(sub, b); }

      const u = b.us.get(item.t);
      if (u) u.s = Math.max(u.s, row[3]);
      else b.us.set(item.t, { t: item.t, n: item.n, px: item.ppx, chg: item.pchg, s: row[3] });

      // 沒有 kline、或最後一個交易日停牌的那幾檔，build 端就不給數字：整列不出現。
      // 留一列空的比較糟——它會跟其他檔並排，看起來像「今天沒動」。
      const tw = twAll[row[0]];
      if (!tw) continue;
      const prev = b.tw.get(row[0]);
      if (prev) prev.s = Math.max(prev.s, row[3]);
      else b.tw.set(row[0], { t: row[0], n: row[1], px: tw.px, chg: tw.chg, s: row[3] });
    }
  }

  const i = state.pairSpan;
  const byChg = (a, b) => ((b.chg || [])[i] ?? -Infinity) - ((a.chg || [])[i] ?? -Infinity);
  const groups = [];
  for (const g of byName.values()) {
    // 子族群在前、「對到整族」最後：那一塊裝的是只標在族群層的美股，
    // 它是這一族的其餘，不是又一個子族。
    const ordered = [...g.blocks.values()].sort((a, b) => (a.name ? 0 : 1) - (b.name ? 0 : 1));

    /*
     * 「對到整族」要扣掉子族群已經列過的。
     *
     * 對照表把族群層的美股配給**整族每一檔**台股（us.py 的 pairs_of），所以不扣的話
     * 那一塊就是整族再抄一次：功率元件那一族的第一版，三個子族列完 17 檔台股，
     * 「對到整族」把同樣 17 檔又列了一遍，整張表長了一倍而且沒有多講任何事。
     *
     * 扣完沒剩台股就整塊不要。美股那一邊也扣，但扣光時留著原本的——那幾檔正是
     * 「標在族群層」的意思，剩下的台股需要一個對照才算得出差距。
     */
    const rest = ordered.find((b) => !b.name);
    if (rest && ordered.length > 1) {
      const usedTw = new Set();
      const usedUs = new Set();
      for (const b of ordered) {
        if (b === rest) continue;
        for (const c of b.tw.keys()) usedTw.add(c);
        for (const u of b.us.keys()) usedUs.add(u);
      }
      for (const c of usedTw) rest.tw.delete(c);
      if ([...rest.us.keys()].some((u) => !usedUs.has(u))) {
        for (const u of usedUs) rest.us.delete(u);
      }
    }

    const blocks = ordered
      .map((b) => {
        const us = [...b.us.values()].sort((x, y) => (y.s - x.s) || byChg(x, y));
        const tw = [...b.tw.values()].sort((x, y) => (y.s - x.s) || byChg(x, y));
        return { name: b.name, us, tw, usMed: pairMeds(us), twMed: pairMeds(tw) };
      })
      // 只剩美股或只剩台股的那一塊沒有對照可看，不要在表上留半排孤兒
      .filter((b) => b.us.length && b.tw.length);
    if (!blocks.length) continue;
    // 整族只有一塊時不必替它取名：那個標題列會跟族群列講同一件事
    if (blocks.length > 1) blocks.forEach((b) => { if (!b.name) b.name = REST_NAME; });
    else blocks[0].name = '';

    const us = uniqBy(blocks.flatMap((b) => b.us));
    const tw = uniqBy(blocks.flatMap((b) => b.tw));
    groups.push({
      name: g.name, blocks, usN: us.length, twN: tw.length,
      usMed: pairMeds(us), twMed: pairMeds(tw),
    });
  }

  // 依台股這一段的漲跌排序：這個軸問的是「台股跟上了沒」，跌最多的排最後
  return groups.sort((a, b) => (b.twMed[i] ?? -Infinity) - (a.twMed[i] ?? -Infinity));
}

/*
 * 背離橫條的滿格基準：全表絕對差距的第 90 百分位，不是最大值。
 *
 * 用最大值的話尺會被離群值吃掉，其餘的全部擠在幾個 px 以內，橫條等於沒畫。代價是
 * 最極端的那一成會一起頂到滿格——它們之間要比大小得看數字。掃的是「誰脫隊」，
 * 那一成本來就都脫隊了。
 *
 * 每次重畫依當下的期間重算（昨夜與季的波動差一個量級，共用一把尺會讓「昨夜」那一欄
 * 全部縮成看不見的一點），但不隨族群收合變動：收起一族就讓其他族的橫條跟著伸縮，
 * 會被讀成數字變了。
 */
let pairGapMax = 1;

function computePairGapMax(groups) {
  const mags = [];
  for (const g of groups) {
    for (const b of g.blocks) {
      const um = b.usMed[state.pairSpan];
      if (um === null || um === undefined) continue;
      for (const r of b.tw) {
        const v = (r.chg || [])[state.pairSpan];
        if (v !== null && v !== undefined) mags.push(Math.abs(v - um));
      }
    }
  }
  mags.sort((a, b) => a - b);
  // 下限 1%：全表都貼在一起的那一天，尺不該把 0.1% 的差距放大成滿格
  pairGapMax = mags.length ? Math.max(1, mags[Math.floor(mags.length * 0.9)]) : 1;
}

const pairChgCells = (row) => pairCols().map((i) => {
  const v = (row.chg || [])[i];
  return `<td class="${trend(v)}${i === state.pairSpan ? ' on' : ''}">${signedPct(v, 1)}</td>`;
}).join('');

/*
 * 差距欄：數字後面跟一條橫條，長度是這一檔在全表裡的相對強弱。
 *
 * 一欄七十幾個帶正負號的百分比，要比大小得一個一個唸過去；橫條讓「誰特別脫隊」
 * 用掃的就看得到。顏色用 currentColor 跟著漲跌走，不另外配色——這一欄已經有紅綠了。
 */
function pairGapCell(v) {
  if (v === null || v === undefined) return '<td class="gap flat">—</td>';
  const w = Math.min(72, Math.max(2, Math.round((Math.abs(v) / pairGapMax) * 72)));
  return `<td class="gap ${trend(v)}">${signedPct(v, 1)}<span class="bar" style="width:${w}px"></span></td>`;
}

/* 國別標籤只放一個字：要分辨的是「美」與「台」，那個「股」字一頁要念三百次。 */
const pairUsRow = (u, n) => `<tr class="s">
    <td><span class="tag">美</span><span class="nm">${esc(u.t)} ${esc(u.n)}</span>
      <span class="cd">對到這一塊的 ${n} 檔 · ${STARS[u.s] || ''}</span></td>
    <td class="px">${priceCell(u.px, '美元')}</td>
    ${pairChgCells(u)}
    <td class="gap flat">·</td>
  </tr>`;

const pairTwRow = (r, usMed) => {
  const v = (r.chg || [])[state.pairSpan];
  const gap = (v === null || v === undefined || usMed === null || usMed === undefined)
    ? null : v - usMed;
  return `<tr class="s t">
    <td><a href="index.html#/stock/${esc(r.t)}"><span class="tag">台</span><span class="nm">${esc(r.n)}</span>
      <span class="cd">${esc(r.t)} · 標註 ${STARS[r.s] || ''}</span></a></td>
    <td class="px">${priceCell(r.px, '元')}</td>
    ${pairChgCells(r)}
    ${pairGapCell(gap)}
  </tr>`;
};

/*
 * 一個區塊：子族群的名字一列，接著這一塊的美股，再接著這一塊的台股。
 *
 * 區塊列的差距是兩邊中位數的差，跟族群列一樣不給橫條——橫條那把尺量的是個股，
 * 中位數擺上去會被當成同一個量級來比。
 */
function pairBlockRows(b, cols) {
  const um = b.usMed[state.pairSpan];
  const tm = b.twMed[state.pairSpan];
  const gap = (um === null || um === undefined || tm === null || tm === undefined)
    ? null : tm - um;
  const head = b.name
    ? `<tr class="b">
        <td colspan="${cols}">${esc(b.name)}
          <span class="sub">美 ${signedPct(um, 1)} · 台 ${signedPct(tm, 1)}</span></td>
        <td class="gap ${trend(gap)} on">${signedPct(gap, 1)}</td>
      </tr>`
    : '';
  return head + b.us.map((u) => pairUsRow(u, b.tw.length)).join('')
    + b.tw.map((r) => pairTwRow(r, um)).join('');
}

function pairGroupRows(g) {
  const i = state.pairSpan;
  const um = g.usMed[i];
  const tm = g.twMed[i];
  const gap = (um === null || um === undefined || tm === null || tm === undefined)
    ? null : tm - um;
  const open = !state.closedP.has(g.name);
  const cols = 2 + pairCols().length;
  const head = `<tr class="g" data-group="${esc(g.name)}">
      <td colspan="${cols}"><span class="caret">${open ? '▾' : '▸'}</span>${esc(g.name)}
        <span class="sub">美股 ${signedPct(um, 1)} · 台股 ${signedPct(tm, 1)}
          · ${g.usN} 檔美股、${g.twN} 檔台股</span></td>
      <td class="gap ${trend(gap)} on"><b>${signedPct(gap, 1)}</b></td>
    </tr>`;
  if (!open) return head;
  return head + g.blocks.map((b) => pairBlockRows(b, cols)).join('');
}

function pairTable(groups) {
  const head = ['<th>標的</th>', '<th>收盤</th>']
    .concat(pairCols().map((i) => `<th${i === state.pairSpan ? ' class="on"' : ''}>${esc(pairSpans()[i])}</th>`))
    .join('') + '<th class="on">差距</th>';
  return `<div class="scroller">
    <table class="pair">
      <thead><tr>${head}</tr></thead>
      <tbody>${groups.map(pairGroupRows).join('')}</tbody>
    </table>
  </div>`;
}

/*
 * 開頭那一段：固定的說明，不是算出來的導讀。
 *
 * 這一張表最容易被誤讀的是「兩欄是同一天」，那要在看到任何數字之前就講掉——
 * 講在下面的方法說明裡就太晚了，人會先看表。
 */
function pairIntro(data) {
  return `<p class="pair-sub">同一族的美股與台股，並排看漲跌幅。最右邊那一欄是<b>差距</b>：
    台股減掉<b>同一塊</b>美股的中位數，正值代表它走得比那一段美股強。
    兩欄<b>不是同一天</b>——美股停在 ${esc(data.pairAsof || data.asof)} 收盤，台股停在
    下一個交易日 ${esc(data.twAsof)}，<b>因在前、果在後</b>，與這一頁的相關性是同一種對齊。</p>`;
}

function pairControls() {
  const opts = pairSpans().map((label, i) => ({ value: String(i), label }));
  return `<div class="pair-controls">
    <label class="ctl">
      <span>差距欄看哪個期間</span>
      ${pills('pairspan', opts, String(state.pairSpan))}
    </label>
  </div>`;
}

/*
 * 大盤：四個期間一次全排出來，不跟著上面的 pills 走。族群表已經有一欄在強調當下
 * 那一段，大盤是拿來當底的，要一眼看完整條時間線才知道「這一族比的是什麼」。
 */
function pairBench(data) {
  const rows = (data.bench || []).filter((b) => b.pchg);
  if (!rows.length) return '';
  const cells = rows.map((b) => {
    const spans = pairSpans().map((s, i) => {
      const v = (b.pchg || [])[i];
      return `${esc(s)} <span class="${trend(v)}">${signedPct(v, 1)}</span>`;
    }).join(' · ');
    return `<div>
      <div class="bname">${esc(b.n)}</div>
      <div class="bval">${priceCell(b.ppx, '')}</div>
      <div class="bspans">${spans}</div>
    </div>`;
  }).join('');
  return `<div class="bench">${cells}</div>
    <p class="pair-hint">族群漲得比<b>費半</b>多才叫強，否則只是跟著整個半導體走。
      <b>美元指數</b>與<b>十年期公債殖利率</b>那兩格要反過來讀：它們上漲通常是成長股的
      逆風，紅色在那兩格不代表好消息——而且那兩個本身就是指數與百分點，
      那一列的百分比是「它自己變動了幾 %」，不是誰的報酬。</p>`;
}

function pairNotes(data, groups) {
  return `<div class="pair-note">
    <h2>怎麼讀</h2>
    <ul>
      <li><b>收盤</b>是股價不是百分比——美股是美元、台股是台幣，兩邊不能互相比較。
        右邊幾欄才是漲跌幅 %。</li>
      <li>期間用<b>交易日</b>回推，兩邊同一組天數：昨夜／今天 1 日、週 5 日、
        月 20 日、季 63 日。<b>沒有「年」</b>：台股的日 K 線從 ${esc(data.from)} 才開始，
        湊不出 250 個交易日（美股軸上那一欄仍然有，那是美股自己的）。</li>
      <li><b>紅漲綠跌</b>，照台股的慣例——所以美股那幾列也是紅漲，跟它們自己市場的
        配色相反。名稱左邊的色條與那一個字是國別不是漲跌：靛紫是<b>美</b>、藍是<b>台</b>。</li>
      <li>每一族按<b>子族群</b>分塊：一塊是「這幾檔美股 → 對得上的這幾檔台股」。
        「${REST_NAME}」那一塊裝的是對照表只標在族群層、沒有指定子族的美股。</li>
      <li><b>差距</b>減的是<b>自己那一塊</b>的美股中位數，不是整族的：AI 伺服器那一族裡，
        散熱那幾檔要比的是散熱那幾檔美股。</li>
      <li><b>橫條</b>的長度是它在整張表裡的相對大小，以第 90 百分位為滿格，
        所以最極端的那一成會一起頂到底——要分它們得看數字。</li>
      <li>族群列與區塊列上的是兩邊中位數的差，<b>不給橫條</b>：那跟個股那一欄不是
        同一把尺。${groups.length} 個族群依台股的漲跌排序，
        <b>點族群那一列可以收起來</b>。</li>
    </ul>
  </div>
  <div class="pair-note">
    <h2>這一個軸怎麼算的</h2>
    <p><b>兩邊差一場，那是刻意的。</b>美股收在台股開盤之前，所以這裡的「昨夜」是
      ${esc(data.pairAsof || data.asof)} 那一場美股，「今天」是台股 ${esc(data.twAsof)}——
      台股那一天反映的就是那一夜。週、月、季照樣錯開一場往回數同樣的天數。
      這件事很容易做錯：Yahoo 給得出的美股最後一場常常與台股是<b>同一個日期</b>
      （美股 D 日收在台北 D+1 日清晨），直接拿兩邊的最後一天相減就整欄錯開一場，
      而畫面上完全看不出來。所以美股這一邊一律裁到台股最後一天<b>之前</b>的那一場。</p>
    <p><b>這個軸上沒有相關係數，是故意的。</b>相關性是另外兩個軸整頁在講的事。
      並排擺在同一張表上，會被讀成「相關性高，所以今天會跟」——而這一頁的散點圖
      正好在說那件事沒有那麼牢靠：原始相關裡有一大半只是整個市場一起動。要看某一對
      綁得緊不緊，切回<b>看美股</b>。</p>
    <p><b>台股那一邊是對照表裡的那些</b>，不是這一族的全部成員——人工標註只挑得出
      代表性的幾檔。要看整族的資金流向，去排行榜的
      <a class="accent" href="index.html#/sector">族群</a>分頁。漲跌幅沒有還原除權息，
      台股多在 7–8 月配息，跨過那一段的區間會被低估。</p>
  </div>`;
}

function pairView(data, items) {
  // 舊的 index.json（service worker 的快取、或還沒重跑過 build_us.py）沒有這兩個欄位。
  // 畫半張表比整張不畫更糟：那會是一張每一格都是「—」的表，看起來像市場沒動。
  if (!data.pairSpans || !data.tw) {
    return `<p class="hint">這份 <code>data/us/index.json</code> 還沒有並排軸要的欄位
      （<code>pairSpans</code> 與 <code>tw</code>）。重跑一次
      <code>python scripts/build_us.py</code> 就會有。</p>`;
  }
  // 台股落後美股很多天時 build 端不給 pairAsof：那時每一格都會是「—」，
  // 而一張全是破折號的表看起來像市場沒動，不像資料沒到。
  if (!data.pairAsof) {
    return `<p class="hint">台股的資料落後美股太多，找不到對得上的那一場美股
      （台股最後一個交易日是 ${esc(data.twAsof)}）。等下一次排程把台股補上就會回來；
      另外兩個軸不受影響。</p>`;
  }
  const groups = pairGroups(items);
  computePairGapMax(groups);
  return `${pairIntro(data)}
    ${pairControls()}
    ${pairBench(data)}
    ${pairTable(groups)}
    ${pairNotes(data, groups)}`;
}

function corrBar(v, lo, hi) {
  if (v === null || v === undefined) return '<span class="corr-bar"></span>';
  const at = (n) => 50 + Math.max(-100, Math.min(100, n)) / 2;   // 0% 在正中間
  const band = (lo === null || lo === undefined || hi === null || hi === undefined)
    ? ''
    : `<i class="band" style="left:${at(lo)}%;width:${Math.max(at(hi) - at(lo), 2)}%"></i>`;
  return `<span class="corr-bar">${band}<i class="zero"></i>
    <i class="now ${trend(v)}" style="left:${at(v)}%"></i></span>`;
}

/** 中位數。空陣列回 null —— 0 在這一頁是「完全不相關」，不是「沒有資料」。 */
function median(vals) {
  if (!vals.length) return null;
  const s = vals.slice().sort((a, b) => a - b);
  return s[(s.length - 1) >> 1];
}

/** 攤平成一組一個點：{美股, 台股代號, 名稱, 星等, 原始相關, 超額相關, 天數}。 */
function pairsOf(items) {
  const out = [];
  for (const item of items) {
    for (const row of item.links) {
      const r = corrOf(row, 'r');
      const x = corrOf(row, 'x');
      if (r === null || r === undefined || x === null || x === undefined) continue;
      out.push({ t: item.t, code: row[0], name: row[1], s: row[3], r, x, n: daysOf(row) });
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// 散點圖：原始相關 × 超額相關
//
// 這一頁的兩個問題本來都只用文字講：「標註對不對得上資料」寫在一句話裡，
// 「原始相關會被整個市場一起動灌水」寫在方法那一段。一張圖同時回答兩個 ——
//
//   · 橫軸是原始相關、縱軸是超額相關，兩軸同一個尺度，所以**對角線**就是
//     「市場因子一點貢獻都沒有」。點落在對角線底下多遠，就是有多少相關性
//     是整個市場一起動來的。那件事用文字講要三行，用圖講是一眼。
//   · 顏色是人工標的星等。★★★ 如果散得跟 ★☆☆ 一樣開，那份標註就沒有鑑別力——
//     這正是這一頁存在的理由，而文字版只講得出「最弱的那一組是誰」。
//
// 純 SVG，不依賴任何圖表庫（這一頁本來就沒載）。星等同時用顏色與半徑編碼，
// 不要只靠顏色。
// --------------------------------------------------------------------------
const SCATTER = { side: 460, l: 46, r: 14, t: 14, b: 40 };
const STAR_R = { 3: 5, 2: 4, 1: 3.2 };

/** 兩軸共用的範圍：同一個尺度，對角線才是 45 度，落差才讀得出來。 */
function scatterBound(pairs) {
  const vals = pairs.flatMap((p) => [p.r, p.x]);
  const lo = Math.min(-20, ...vals);
  const hi = Math.max(20, ...vals);
  return [Math.floor(lo / 20) * 20, Math.ceil(hi / 20) * 20];
}

function scatterCard(items) {
  const pairs = pairsOf(items);
  if (pairs.length < 4) return '';

  const [lo, hi] = scatterBound(pairs);
  const { side, l, t, b } = SCATTER;
  const W = l + side + SCATTER.r;
  const H = t + side + b;
  const px = (v) => l + ((v - lo) / (hi - lo)) * side;
  const py = (v) => t + side - ((v - lo) / (hi - lo)) * side;

  const ticks = [];
  for (let v = lo; v <= hi; v += 20) ticks.push(v);

  const grid = ticks.map((v) => `<line class="g" x1="${px(v)}" y1="${t}" x2="${px(v)}" y2="${t + side}"/>`
    + `<line class="g" x1="${l}" y1="${py(v)}" x2="${l + side}" y2="${py(v)}"/>`).join('');
  const labels = ticks.map((v) => `<text class="tk" x="${px(v)}" y="${t + side + 16}" text-anchor="middle">${v}</text>`
    + `<text class="tk" x="${l - 8}" y="${py(v) + 4}" text-anchor="end">${v}</text>`).join('');

  // 兩條零線與那條對角線。對角線是這張圖的判讀基準，所以畫得比零線明顯。
  const axes = `<line class="z" x1="${px(0)}" y1="${t}" x2="${px(0)}" y2="${t + side}"/>
    <line class="z" x1="${l}" y1="${py(0)}" x2="${l + side}" y2="${py(0)}"/>
    <line class="diag" x1="${px(lo)}" y1="${py(lo)}" x2="${px(hi)}" y2="${py(hi)}"/>`;

  // 星等低的先畫。★☆☆ 有一千多組、★★★ 只有一百多，順序反過來的話要看的那一群
  // 會被整片蓋掉 —— 第一版就是這樣，圖上幾乎找不到藍點。
  const dots = pairs.slice().sort((a, b) => a.s - b.s)
    .map((p) => `<circle class="d s${p.s}" cx="${px(p.r).toFixed(1)}" cy="${py(p.x).toFixed(1)}"
      r="${STAR_R[p.s] || 3.2}"><title>${esc(p.t)} × ${esc(p.name)} ${esc(p.code)}
原始 ${corrText(p.r)}　超額 ${corrText(p.x)}　標註 ${STARS[p.s] || ''}　${p.n} 天</title></circle>`).join('');

  const rows = [3, 2, 1].map((s) => {
    const group = pairs.filter((p) => p.s === s);
    if (!group.length) return '';
    return `<tr><td><i class="dot s${s}"></i>${STARS[s]}</td><td>${group.length}</td>
      <td class="${trend(median(group.map((p) => p.r)))}">${corrText(median(group.map((p) => p.r)))}</td>
      <td class="${trend(median(group.map((p) => p.x)))}">${corrText(median(group.map((p) => p.x)))}</td></tr>`;
  }).join('');

  return `<section class="card">
    <h2>標註站不站得住 <small>${pairs.length} 組配對 · 最近 ${state.span} 個交易日</small></h2>
    <div class="scatter">
      <svg viewBox="0 0 ${W} ${H}" role="img"
        aria-label="橫軸原始相關、縱軸超額相關的散點圖，顏色是人工標註的星等">
        ${grid}${axes}${dots}${labels}
        <text class="ax" x="${l + side / 2}" y="${H - 6}" text-anchor="middle">原始相關 %</text>
        <text class="ax" x="${-(t + side / 2)}" y="13" text-anchor="middle"
          transform="rotate(-90)">超額相關 %</text>
      </svg>
      <table class="tbl scatter__sum">
        <thead><tr><th>標註</th><th>組數</th><th>原始中位</th><th>超額中位</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="note">一個點是一組配對。<b>越往右</b>＝一起漲跌的程度越高，
      <b>越往上</b>＝扣掉兩邊各自的大盤之後還剩下的關係。</p>
    <p class="note"><b>那條斜線是判讀的基準</b>：落在線上代表這組的相關性完全不是
      「整個市場一起動」來的；離線越遠（越往右下），就有越多相關性只是共同的市場因子。
      台股電子股彼此本來就有五、六成的相關，所以絕大多數的點都會在線的下方——
      這張圖要看的是<b>離線多遠</b>，不是絕對位置。</p>
    <p class="note">顏色是人工在 <code>us_link.json</code> 標的星等，上面那張表是同一件事的
      數字版。★★★ 如果沒有比 ★☆☆ 更靠右上，那份標註就沒有鑑別力——這一頁存在的理由
      就是讓這件事被看見。</p>
    <p class="note"><b>但兩欄要一起看，不要只看超額那一欄。</b>
      看到 ★★★ 在原始那一欄領先、卻在超額那一欄落後時，先別急著判定標註是亂標的：
      ★★★ 多半標在權值股上，而權值股正是被扣大盤扣得最兇的那一群 ——
      台積電自己就佔台股加權約三成，扣掉大盤等於把它自己扣掉一大半，
      它的點會被壓到右下角。那是算法的限制，不是它跟美股脫鉤，
      更不是標註的人搞錯了。</p>
  </section>`;
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
  const lo = corrOf(row, 'lo');
  const hi = corrOf(row, 'hi');
  const band = (lo === null || lo === undefined)
    ? `${state.span} 日窗的資料還不夠長，算不出擺盪範圍`
    : `這半年間，${state.span} 日窗在 ${corrText(lo)} ~ ${corrText(hi)} 之間擺盪`;
  return `<a class="row" href="index.html#/stock/${esc(code)}" title="${esc(band)}">
      <div class="rank"><span class="no sm ${trend(r)}">${corrText(r)}</span>
        ${corrBar(r, lo, hi)}</div>
      <div class="ident"><span class="name">${esc(name)}</span>
        <span class="code">${esc(code)} · ${esc(labels[label] || '')}</span></div>
      <div class="figures"><span class="value sm">超額 ${tint(x, corrText(x))}</span>
        <span class="price">今 ${tint(twChgOf(row), signedPct(twChgOf(row)))}
          · ${STARS[s] || ''} · ${daysOf(row)} 天</span></div>
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
      抽掉共同的市場因子之後，剩下的<b>比較</b>接近這一對自己的關係——但只是比較接近，
      <b>不是</b>「這一對自己的關係」。大盤扣掉了，<b>產業還沒扣</b>，見下面那一段。
      <b>但權值股要打折看</b>：台積電自己就佔台股加權指數約三成，扣大盤等於把它自己扣掉一大半，
      超額相關會被壓成負的——那是算法的限制，不是它跟美股脫鉤。<br>
      <b>樣本範圍</b>：台股價格取自 <code>data/kline/</code>，只從 ${esc(data.from)} 開始
      （全市場四價是後來才存的），所以最長就到 ${Math.max(...data.spans)} 日，再長沒有資料。
      對齊後少於 ${data.minPoints} 天的配對不給數字。<br>
      <b>配對的範圍</b>：來自人工維護的 <code>data/us_link.json</code>，
      只算那份對照表畫出來的組合，不是拿每一檔美股去掃全市場。
      標 ★★★ 的配對一律列出（不管相關性排第幾），其餘每檔美股最多列前幾名。<br>
      <b>為什麼不讓資料自己找配對</b>：試過了，做不起來，而失敗的方式正好說明上面那個
      「超額」欄該怎麼讀。把 173 檔美股對全市場 1,493 檔台股各算一次，25.8 萬組檢定，
      門檻用 Bonferroni 校正到 |r| ≥ 44%（不校正的話 18% 就「顯著」，那全是雜訊）：<br>
      · <b>原始相關</b>：通過 255 組，前幾名是 ICHR、^SOX、TTMI 配上日月光——
      全是半導體對半導體。那是<b>產業一起動</b>，看得出來也講得通。<br>
      · <b>超額相關（本頁現行的算法）</b>：通過 <b>2,873 組，比什麼都不扣還多</b>，
      而且前 20 名<b>全是 COST 好市多</b>，對象是生技、食品、電機、航運。<br>
      · <b>改成對大盤做迴歸</b>（beta 讓資料決定，而不是寫死成 1）：通過的掉到 <b>6 組</b>。
      再加一個 ^SOX 因子也只有 10 組，而且都是「Hurco × 建材營造」這種語意上毫無道理的
      組合。<b>人工標的 176 組 ★★★ 一組都沒通過</b>，中位數只剩 +6%。<br>
      <b>兩件事要一起讀</b>：一、2,873 掉到 6 是「減 1×大盤」換成「做迴歸」造成的，不是
      多扣了科技因子——<b>減 1× 等於把 beta 寫死成 1</b>，beta 不是 1 的股票，殘差裡會
      留著 (beta − 1) × 大盤；台股加權六成是電子，非科技股減完還帶著一大塊負的大盤，
      美股那邊同理，兩塊互相對上就成了 COST 那種假訊號。二、真的把公司自己的部分抽乾淨
      之後，<b>人工標註聲稱的那種關係也跟著消失</b>——這一頁量到的連動，絕大部分就是
      「同一個產業一起動」，不是「這家公司對那家公司」。<br>
      所以發現式排行沒有東西可以發現，不做。整個實驗可以重跑並推翻：
      <code>python scripts/scan_us.py --method reg1</code>。<br>
      <b>更新</b>：美股日線 <code>scripts/fetch_us.py</code>、相關性 <code>scripts/build_us.py</code>，
      兩支都在每日排程裡（<code>build_us.py</code> 排在 <code>build_history.py</code> 之後，
      台股那一邊要吃它寫的交易日軸與 K 線）。這一份算於
      ${esc(data.updated.slice(0, 16).replace('T', ' '))}。
    </p>
  </section>`;
}

function render() {
  const data = state.data;
  const items = sortedItems();
  const spanOpts = data.spans.map((s) => ({ value: String(s), label: `${s} 日` }));

  // 並排軸是通欄的表，另外兩個軸是 720px 的卡片堆疊。寬度掛在 #view 上而不是 body，
  // 切換時不必碰到 app-bar 與導覽。
  $('#view').classList.toggle('pair-view', state.view === 'pair');

  $('#meta').innerHTML = state.view === 'pair'
    ? `美股 ${esc(data.pairAsof || data.asof)} 收盤 → 台股 ${esc(data.twAsof)}
       · 差距看${esc(pairLabel())}`
    : `美股 ${esc(data.asof)} 收盤 · 台股至 ${esc(data.twAsof)}
       · 相關性取最近 ${state.span} 個交易日`;

  /*
   * 並排軸不擺相關性，所以觀察窗與排序那兩排 pills 在這裡是死的控制項——按了什麼
   * 都不會變。整排收掉，換成它自己那一排（差距欄看哪個期間）。
   */
  if (state.view === 'pair') {
    $('#view').innerHTML = `
      <div class="controls">${pills('view', VIEWS, state.view)}</div>
      ${pairView(data, items)}`;
    return;
  }

  if (state.view === 'group') {
    const groups = groupsOf(items);
    $('#view').innerHTML = `
      ${lede(data, items)}
      <div class="controls">${pills('view', VIEWS, state.view)}</div>
      <div class="controls">${pills('span', spanOpts, String(state.span))}</div>
      <div class="controls">${pills('sort', SORTS, state.sort)}</div>
      ${scatterCard(items)}
      ${benchCard(data)}
      ${groupCard(groups)}
      ${methodNote(data)}`;

    const byName = new Map(groups.map((g) => [g.name, g]));
    const fillG = (el) => {
      const box = $('.sector__body', el);
      if (box.innerHTML) return;
      const g = byName.get(box.dataset.group);
      box.innerHTML = `<p class="note">美股 ${g.us.length} 檔（昨夜）</p>
        ${g.us.map(groupUsRow).join('')}
        <p class="note">台股 ${g.tw.length} 檔（今天，點進去回排行榜的個股頁）</p>
        ${g.tw.map(groupTwRow).join('')}`;
    };
    $('#view').querySelectorAll('details.sector').forEach((el) => {
      if (el.open) fillG(el);
      el.addEventListener('toggle', () => {
        const name = $('.sector__body', el).dataset.group;
        el.open ? state.openG.add(name) : state.openG.delete(name);
        if (el.open) fillG(el);
      });
    });
    return;
  }

  $('#view').innerHTML = `
    ${lede(data, items)}
    <div class="controls">${pills('view', VIEWS, state.view)}</div>
    <div class="controls">${pills('span', spanOpts, String(state.span))}</div>
    <div class="controls">${pills('sort', SORTS, state.sort)}</div>
    ${scatterCard(items)}
    ${benchCard(data)}
    <section class="card">
      <h2>美股 <small>${items.length} 檔 · 點一列展開它對照的台股</small></h2>
      ${items.map(itemRow).join('')}
      <p class="note">左邊的百分比是這一檔美股對它所有對照台股的<b>相關性中位數</b>，
        右邊是它自己的漲跌幅（昨夜／週／月／年）。展開後每一列是一檔台股，
        點進去會回到排行榜的個股頁。</p>
      <p class="note">每一列數字底下那條小圖：淡灰的帶子是<b>擺盪範圍</b>——把
        ${state.span} 日的窗從資料起點一路滑到今天，中間最低與最高到過哪裡；那根豎標是
        <b>現在的值</b>（中間那條細線是 0，右邊為正、左邊為負）。
        <b>豎標貼在帶子右緣</b>＝現在是這半年來最相關的時候，那個數字要打折看；
        <b>帶子很窄</b>＝這組連動一直都這麼強（或這麼弱），數字比較可信。
        滑鼠移上去會顯示區間的數字。</p>
      <p class="note">湊不出 ${data.minWindows} 個窗就不畫帶子。台股 K 線從
        ${esc(data.from)} 才開始，${Math.max(...data.spans)} 日窗只滑得出十來個、
        而且彼此重疊九成以上——那個「範圍」講的是同一段資料被切了幾次，不是它的穩定度，
        寧可留白。K 線的歷史長出來之後，長窗會自己開始有數字。</p>
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
  if (!pill) {
    // 並排軸：點族群那一列收合。整張表是一次畫完的（不像另外兩個軸用 details
    // 延遲填充），所以收合就是重畫一次。
    const grp = ev.target.closest('tr.g');
    if (!grp) return;
    const name = grp.dataset.group;
    state.closedP.has(name) ? state.closedP.delete(name) : state.closedP.add(name);
    render();
    return;
  }
  if (pill.dataset.view) {
    state.view = pill.dataset.view;
    try { localStorage.setItem(VIEW_KEY, state.view); } catch (err) { /* 無痕模式 */ }
  } else if (pill.dataset.span) {
    state.span = Number(pill.dataset.span);
    try { localStorage.setItem(SPAN_KEY, String(state.span)); } catch (err) { /* 無痕模式 */ }
  } else if (pill.dataset.sort) {
    state.sort = pill.dataset.sort;
    try { localStorage.setItem(SORT_KEY, state.sort); } catch (err) { /* 無痕模式 */ }
  } else if (pill.dataset.pairspan) {
    state.pairSpan = Number(pill.dataset.pairspan);
    try { localStorage.setItem(PAIR_KEY, String(state.pairSpan)); } catch (err) { /* 無痕模式 */ }
  } else {
    return;
  }
  render();
});

/* 並排軸的欄數是在產生 HTML 時決定的（見 pairCols），所以換寬度要重畫一次。 */
window.matchMedia(NARROW_MQ).addEventListener('change', () => {
  if (state.data && state.view === 'pair') render();
});

async function start() {
  try {
    const res = await fetch(`${DATA}/us/index.json`, { cache: 'reload' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
    colIdx = new Map((state.data.cols || []).map((c, i) => [c, i]));
  } catch (err) {
    $('#meta').textContent = '載入失敗';
    $('#view').innerHTML = `<p class="hint">讀不到 <code>data/us/index.json</code>（${esc(err.message)}）。
      正常情況下每日排程會產生它；本機環境請先執行
      <code>python scripts/fetch_us.py</code> 與 <code>python scripts/build_us.py</code>。
      前端版本 ${esc(APP_VERSION)}。</p>`;
    return;
  }
  try {
    const span = Number(localStorage.getItem(SPAN_KEY));
    if (state.data.spans.includes(span)) state.span = span;
    const sort = localStorage.getItem(SORT_KEY);
    if (SORTS.some((s) => s.value === sort)) state.sort = sort;
    const view = localStorage.getItem(VIEW_KEY);
    if (VIEWS.some((v) => v.value === view)) state.view = view;
    /*
     * 沒存過要走 state 的預設值（週），所以空值必須先擋掉：Number(null) 與 Number('')
     * 都是 0，會一路通過下面三個檢查把期間設成「昨夜」——第一次進這個軸的人看到的
     * 就不是我們選的那一欄，而畫面完全正常，不會有人回報。（jp.js 有同一段註解。）
     */
    const saved = localStorage.getItem(PAIR_KEY);
    const pairSpan = saved ? Number(saved) : NaN;
    if (Number.isInteger(pairSpan) && pairSpan >= 0
        && pairSpan < (state.data.pairSpans || []).length) state.pairSpan = pairSpan;
  } catch (err) {
    /* 讀不到就用預設值 */
  }
  render();
}

start();
