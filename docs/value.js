/*
 * 價值紀律（value.html）：逢低、看本益比位階的價值派規則，每天照資料機械式地套一次。
 *
 * 回答的問題：**照這套價值規則，今天該不該撿？撿哪一族、哪一檔？**
 *
 * 與同一組的「紀律」頁是兩套相反的派別：那一頁是趨勢派（跌破均線就走），這一頁是價值派
 * （跌下來、本益比回到自己的歷史低檔就撿）。兩頁並排，是為了讓人先決定自己這一筆錢屬於
 * 哪一派，再照那一派的規則做——同一筆錢兩套一起用，停損隨時會被「跌了要加碼」推翻。
 *
 *   大盤   高檔不追、下跌分批撿、台積電下跌是訊號、盤整別碰正 2
 *   題材   子族群的月營收（量）與報價（價），量價齊揚的排前面
 *   估值   每一檔的本益比落在它自己近五年區間的哪一格
 *   存股   金融股的殖利率、5% 殖利率價、股淨比位階
 *   價差   KD 20／80，只給 ETF 與金融股
 *   回測   過去每個月底照同一套規則判的位階，之後 3／6／12 個月真的比較會漲嗎
 *   規則   上面每一條的門檻
 *
 * 最上面的搜尋框跨過這六個軸：打代號、名稱或子族群名，列出符合的每一檔，並把這一頁對它的
 * 所有判斷（本益比位階、營收、存股、KD、題材）攤在同一張卡上——從某一檔出發問「照這套
 * 規則它現在算什麼」，不必在六個軸之間來回找。
 *
 * 所有判斷都在 scripts/build_value.py 算好，門檻也從那裡帶過來（data.rules），這裡只畫。
 * 規則為什麼長這樣，完整版在那支的 docstring。
 */

const DATA = 'data';

const VIEWS = [
  { value: 'market', label: '大盤' },
  { value: 'theme', label: '題材' },
  { value: 'stock', label: '估值' },
  { value: 'income', label: '存股' },
  { value: 'kd', label: '價差' },
  { value: 'backtest', label: '回測' },
  { value: 'rules', label: '規則' },
];

const LEVEL = {
  cheap: '便宜',
  below: '相對便宜',
  above: '偏貴',
  pricey: '昂貴',
};

const LEVEL_FILTERS = [
  { value: 'cheap', label: '便宜' },
  { value: 'below', label: '相對便宜' },
  { value: 'digest', label: '偏貴但成長消化得掉' },
  { value: 'above', label: '偏貴' },
  { value: 'pricey', label: '昂貴' },
];

const STOCK_SORTS = [
  { value: 'pos', label: '位階低到高' },
  { value: 'yoy', label: '營收年增' },
];

const TAG = {
  vol: '量增',
  accel: '加速',
  high: '營收新高',
  price: '價漲',
};

const KD_SIG = {
  addmore: { label: '週 K 也在低檔：續跌可再加碼', tone: 'buy' },
  buy: { label: '日 K < 20：分批買', tone: 'buy' },
  pause: { label: '日 K 20～40：暫停加碼', tone: 'hold' },
  sell: { label: '日 K > 80：分批賣', tone: 'sell' },
};

const state = {
  data: null,
  view: 'market',
  lv: 'cheap',
  sort: 'pos',
  openT: new Set(),
  q: '',
  h: '12',
  bt: undefined,       // 回測資料：undefined 還沒載、null 載不到
};

// 搜尋結果最多列幾檔。打一個字（「電」）就會命中上百檔，全畫出來既慢也不是在找東西
const SEARCH_LIMIT = 30;

const KEYS = {
  view: 'stocktracker.valueview',
  lv: 'stocktracker.valuelv',
  sort: 'stocktracker.valuesort',
  h: 'stocktracker.valueh',
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (v, digits = 2) => (v === null || v === undefined ? '—'
  : Number(v).toLocaleString('zh-TW', { maximumFractionDigits: digits }));
const pct = (v, digits = 1) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`);
const dir = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');

function pills(name, options, current) {
  return `<div class="pills">${options
    .map((o) => `<button class="pill ${o.value === current ? 'active' : ''}" data-${name}="${o.value}">${esc(o.label)}</button>`)
    .join('')}</div>`;
}

const lvChip = (lv) => (lv ? `<span class="val-lv val-lv--${lv}">${LEVEL[lv]}</span>` : '');

/**
 * 本益比在區間裡的位置：一條橫線，三道刻度是平均最低／平均／平均最高，圓點是現在。
 * 圓點落在哪一段，就是那一格的判斷——數字對不上直覺的時候，看這條比看三個數字快。
 */
function bandBar(value, b) {
  if (value === null || value === undefined || !b) return '<span class="val-band val-band--none">不評價</span>';
  const lo = Math.min(b.lo, value) * 0.9;
  const hi = Math.max(b.hi, value) * 1.1;
  const at = (v) => `${((v - lo) / (hi - lo)) * 100}%`;
  return `<span class="val-band" title="平均最低 ${fmt(b.lo)}／平均 ${fmt(b.avg)}／平均最高 ${fmt(b.hi)}">
    <i class="val-band__seg" style="left:${at(b.lo)};width:calc(${at(b.hi)} - ${at(b.lo)})"></i>
    <i class="val-band__tick" style="left:${at(b.lo)}"></i>
    <i class="val-band__tick val-band__tick--avg" style="left:${at(b.avg)}"></i>
    <i class="val-band__tick" style="left:${at(b.hi)}"></i>
    <i class="val-band__dot" style="left:${at(value)}"></i>
  </span>`;
}

function stockLink(code, s, body, figures) {
  return `<a class="row val-row" href="index.html#/stock/${esc(code)}">
    <span class="val-row__band">${body}</span>
    <span class="ident">
      <span class="name">${esc(s.n || code)}</span>
      <span class="code">${esc(code)}${s.subs && s.subs.length ? ` · ${esc(s.subs[0][1])}` : s.ind ? ` · ${esc(s.ind)}` : ''}</span>
    </span>
    <span class="figures">${figures}</span>
  </a>`;
}

// --------------------------------------------------------------------------
// 1. 大盤
// --------------------------------------------------------------------------

const STANCE = {
  crash: { title: '大跌：多買一點，不選股', act: '股災那天直接買市值型 ETF，不花時間挑個股；照下面的份數動用資金，最後一份不動。', tone: 'warn' },
  dip: { title: '下跌：買一點', act: '照離高點的跌幅分批，一次只動一份；沒跌到下一格就不加。', tone: 'warn' },
  high: { title: '高檔：等下跌，別追', act: '相信長期往上，但現在位於高點——等下跌才買，寧可保留現金。', tone: 'ok' },
  wait: { title: '還沒跌到第一份', act: '離高點有一段了，但還不到第一份資金的位置；耐心等。', tone: 'ok' },
};

function marketView(d) {
  const m = d.market;
  const tx = m.taiex;
  const ts = m.tsmc;
  const r = m.rules;
  const st = STANCE[m.stance];
  const t = m.tranches;

  const ladder = t.levels.map((lvl, k) => {
    const on = k < t.used;
    return `<li class="${on ? 'is-on' : ''}">
      <span>第 ${k + 1} 份</span>
      <span>離 ${r.lookback} 日高點跌 ${t.step * (k + 1)}%</span>
      <span class="rule-ladder__now">${fmt(lvl, 0)} 點${on ? ' ✓' : ''}</span>
    </li>`;
  }).join('') + `<li><span>第 ${t.total} 份</span><span>永遠不動：不 All in</span><span class="rule-ladder__now">—</span></li>`;

  const tsCard = ts ? `<section class="card">
      <h2>台積電 <small>佔大盤約四成</small></h2>
      <p class="rule-level rule-level--${m.tsmcSignal ? 'warn' : 'ok'}">
        <b>${m.tsmcSignal ? '台積電下跌：進場訊號' : '台積電沒有明顯下跌'}</b>
        <span>收 ${fmt(ts.c)}（${pct(ts.chg, 2)}），離 ${r.lookback} 日高點 ${pct(ts.dd)}</span>
      </p>
      <p class="note">規則：單日跌 ${Math.abs(r.tsmcDay)}% 以上，或離 ${r.lookback} 日高點跌 ${Math.abs(r.tsmcDd)}% 以上。
        業績好的權值股跌下來會有買盤支撐，而大盤跟著它走——所以它跌的那天，布局的是<b>市值型 ETF</b>，
        勇敢一點才是正 2。</p>
    </section>` : '';

  return `<section class="card">
      <h2>加權指數 <small>${esc(tx.d)} 收盤</small></h2>
      <p class="rule-level rule-level--${st.tone}"><b>${esc(st.title)}</b><span>${esc(st.act)}</span></p>
      <div class="stat-grid">
        <div class="stat"><b>${fmt(tx.c, 0)}</b><span>加權 <em class="${dir(tx.chg)}">${pct(tx.chg, 2)}</em></span></div>
        <div class="stat"><b class="${dir(tx.dd)}">${pct(tx.dd)}</b><span>離 ${r.lookback} 日高點</span></div>
        <div class="stat"><b>${t.used} / ${t.total}</b><span>該動用的資金份數</span></div>
        <div class="stat"><b>${pct(tx.range)}</b><span>${r.lookback} 日高低差</span></div>
      </div>
      <ol class="rule-ladder">${ladder}</ol>
      <p class="note">高點是最近 ${r.lookback} 個交易日的最高收盤 ${fmt(tx.hi, 0)}。單日跌 ${Math.abs(r.dipDay)}% 算下跌、
        ${Math.abs(r.crashDay)}% 算大跌；離高點不到 ${Math.abs(r.nearHigh)}% 算高檔。</p>
    </section>
    ${tsCard}
    <section class="card">
      <h2>正 2 <small>槓桿 ETF</small></h2>
      <p class="rule-level rule-level--${m.box ? 'stop' : 'ok'}">
        <b>${m.box ? '盤整中：正 2 會越盤越低' : '不是區間盤整'}</b>
        <span>${r.lookback} 日高低差 ${pct(tx.range)}（門檻 ${r.boxRange}%）</span>
      </p>
      <p class="note">正 2 每天重設槓桿：漲了加碼、跌了減碼。一路漲會超過兩倍，一路跌也不會歸零，
        最怕的是<b>來回盤整</b>——加碼後碰到下跌多賠、減碼後碰到上漲少賺。預期往上才定期定額買；
        預期盤整或下跌就完全不要買；不會預測的話，只在大跌時分散資金慢慢買。</p>
    </section>`;
}

// --------------------------------------------------------------------------
// 2. 題材
// --------------------------------------------------------------------------

function themeView(d) {
  const r = d.rules;
  const rows = d.themes.map((t) => {
    const key = `${t.g}|${t.s}`;
    const open = state.openT.has(key);
    const tags = t.tags.map((k) => `<span class="chip accent">${TAG[k]}</span>`).join('');
    const both = t.tags.includes('vol') && t.tags.includes('price');
    const lv = ['cheap', 'below', 'above', 'pricey']
      .filter((k) => t.lv[k]).map((k) => `${LEVEL[k]} ${t.lv[k]}`).join('・');

    let body = '';
    if (open) {
      const members = t.codes.filter((c) => d.stocks[c]).map((c) => [c, d.stocks[c]])
        .sort((a, b) => pos(a[1]) - pos(b[1]));
      body = `<div class="val-theme__body">${members.map(([c, s]) => valuationRow(c, s)).join('')}</div>`;
    }

    return `<article class="val-theme ${open ? 'is-open' : ''} ${both ? 'is-hot' : ''}">
      <button class="val-theme__head" data-t="${esc(key)}">
        <span class="val-theme__name">${open ? '▾' : '▸'} ${esc(t.s)} <small>${esc(t.g)}</small></span>
        <span class="val-theme__tags">${both ? '<span class="chip val-hot">量價齊揚</span>' : ''}${tags}</span>
        <span class="val-theme__nums">
          營收年增中位數 <b class="${dir(t.yoy)}">${pct(t.yoy)}</b>（上月 ${pct(t.yoyPrev)}）
          ・創一年新高 ${t.high}/${t.revN}
          ${t.quotes ? `・報價三個月 <b class="${dir(t.qm3)}">${pct(t.qm3)}</b>` : ''}
        </span>
        <span class="val-theme__lv">${lv || '沒有可評價的成分股'}${t.digest ? `・成長消化得掉 ${t.digest}` : ''}</span>
      </button>
      ${body}
    </article>`;
  }).join('');

  return `<section class="card">
      <p class="lede">找題材的順序是：<b>哪裡在漲價、缺貨</b> → 往上下游找受惠股 → 看獲利成長 → 最後才看本益比。
      這裡把「漲價、缺貨」換成抓得到的兩個訊號：<b>量</b>是子族群 ${esc(d.revMonth)} 月營收年增率的中位數
      （≥ ${r.volUp}% 量增、比上月多 ${r.volAccel} 個百分點加速、過半公司創一年新高），
      <b>價</b>是報價頁裡對到這一族的報價近三個月漲跌（≥ ${r.priceUp}% 價漲）。量價齊揚的排最前面。
      點開看成分股在自己歷史區間的哪一格。</p>
    </section>
    <section class="card">${rows}</section>`;
}

// --------------------------------------------------------------------------
// 3. 估值
// --------------------------------------------------------------------------

/** 本益比相對平均的位置，排序用：越小越便宜；不評價的排最後。 */
function pos(s) {
  if (s.pe === null || !s.peBand || !s.peLv) return Infinity;
  return s.pe / s.peBand.avg;
}

function valuationRow(code, s) {
  const rev = s.rev;
  const growth = rev ? `營收年增 <span class="${dir(rev.yoy)}">${pct(rev.yoy)}</span>${rev.high ? '・新高' : ''}` : '沒有營收';
  const fwd = s.fwd ? `<span class="val-fwd" title="若獲利跟近三月營收同速成長的粗估">粗估明年 ${fmt(s.fwd, 1)} 倍</span>` : '';
  return stockLink(code, s, bandBar(s.pe, s.peBand), `
      <span class="value">${s.pe ? `${fmt(s.pe, 1)} 倍` : '虧損'} ${lvChip(s.peLv)}</span>
      <span class="price">${growth}</span>
      ${s.digest ? '<span class="price val-digest">成長消化得掉</span>'
    : s.trap ? '<span class="price val-trap">營收衰退，小心是陷阱</span>'
      : fwd ? `<span class="price">${fwd}</span>` : ''}`);
}

function stockView(d) {
  const all = Object.entries(d.stocks);
  const rows = all.filter(([, s]) => (state.lv === 'digest' ? s.digest : s.peLv === state.lv));
  if (state.sort === 'yoy') rows.sort((a, b) => ((b[1].rev || {}).yoy ?? -999) - ((a[1].rev || {}).yoy ?? -999));
  else rows.sort((a, b) => pos(a[1]) - pos(b[1]));
  const count = (k) => all.filter(([, s]) => (k === 'digest' ? s.digest : s.peLv === k)).length;
  const rated = all.filter(([, s]) => s.peLv).length;
  const r = d.rules;

  return `<section class="card">
      <p class="lede">本益比只跟<b>它自己</b>的歷史比。近 ${r.bandYears} 年每一年各取最低、平均、最高，
      平均起來是三道門檻：≤ 平均最低叫<b>便宜</b>、≤ 平均叫<b>相對便宜</b>、再往上是偏貴、≥ 平均最高是昂貴。
      題材族群與金融股共 ${all.length} 檔，${rated} 檔評得出來（虧損、歷史不滿 ${r.minYears} 年的不評價）。
      便宜的前提是<b>業績沒問題</b>：本益比低、但近三個月營收平均負成長的，標成「小心是陷阱」。</p>
      <div class="controls">
        ${pills('lv', LEVEL_FILTERS.map((o) => ({ ...o, label: `${o.label} ${count(o.value)}` })), state.lv)}
        ${pills('sort', STOCK_SORTS, state.sort)}
      </div>
      ${state.lv === 'digest' ? `<p class="note">「現在的昂貴，可能是未來的便宜」：本益比偏貴或昂貴，但近三個月營收年增 ${r.growthMin}%～${r.growthMax}%，
        如果獲利跟營收同速成長，明年的本益比會回到平均以下。這是<b>粗估</b>——營收成長不等於獲利成長，
        毛利率一變就不成立。</p>` : ''}
    </section>
    <section class="card">
      ${rows.length ? rows.map(([c, s]) => valuationRow(c, s)).join('') : '<p class="hint">這一格今天沒有標的。</p>'}
    </section>`;
}

// --------------------------------------------------------------------------
// 4. 存股
// --------------------------------------------------------------------------

function incomeView(d) {
  const r = d.rules;
  const fin = Object.entries(d.stocks).filter(([, s]) => s.ind === '金融保險' && s.pb)
    .sort((a, b) => (b[1].yld || 0) - (a[1].yld || 0));
  const row = ([code, s]) => {
    const under = s.yldPrice && s.price ? s.price <= s.yldPrice : false;
    return stockLink(code, { ...s, subs: [] }, bandBar(s.pb, s.pbBand), `
      <span class="value">殖利率 ${s.yld ? `${fmt(s.yld, 2)}%` : '—'} ${s.state ? '<span class="chip accent">官股</span>' : ''}</span>
      <span class="price">股淨比 ${fmt(s.pb, 2)} ${lvChip(s.pbLv)}</span>
      <span class="price">5% 價 ${s.yldPrice ? fmt(s.yldPrice, 2) : '—'}${under ? '・<b class="val-good">股價在下面</b>' : ''}</span>`);
  };
  return `<section class="card">
      <p class="lede">存股的前提是<b>不會倒</b>：往下攤平只對不會歸零的東西有意義。金融股用比較保守的<b>股淨比</b>
      看位階（門檻算法同估值），<b>5% 殖利率價 = 現金股利 × ${r.yieldPrice}</b>，股價在它下面，殖利率就有 5%。
      官股銀行另外標出來。照殖利率由高到低排。</p>
      <p class="note">殖利率是證交所與櫃買用最近一次的股利算的；配股（股票股利）不在裡面，愛配股的金融股會被低估。</p>
    </section>
    <section class="card">${fin.map(row).join('')}</section>`;
}

// --------------------------------------------------------------------------
// 5. 價差
// --------------------------------------------------------------------------

function kdView(d) {
  const r = d.rules;
  const groups = ['addmore', 'buy', 'pause', 'sell'].map((sig) => {
    const list = d.kd.filter((k) => k.sig === sig);
    if (!list.length) return '';
    return `<section class="card">
      <h2>${esc(KD_SIG[sig].label)} <small>${list.length} 檔</small></h2>
      ${list.map((k) => `<a class="row val-row" href="index.html#/stock/${esc(k.c)}">
        <span class="val-row__band"><span class="val-k val-k--${KD_SIG[sig].tone}">K ${fmt(k.k, 0)}</span></span>
        <span class="ident">
          <span class="name">${esc(k.n || k.c)}</span>
          <span class="code">${esc(k.c)} · ${k.etf ? 'ETF' : '金融股'}</span>
        </span>
        <span class="figures">
          <span class="value">${fmt(k.price)}</span>
          <span class="price">D ${fmt(k.d, 0)}・週 K ${k.wk === null ? '—' : fmt(k.wk, 0)}</span>
        </span>
      </a>`).join('')}
    </section>`;
  }).join('');

  return `<section class="card">
      <p class="lede">做價差只用 KD：日 K &lt; ${r.kdLow} 分批買、到 ${r.kdPause} 暫停加碼、&gt; ${r.kdHigh} 分批賣；
      日 K 已低、週 K 也 &lt; ${r.kdLow} 的，是「續跌還可以再加碼」。<b>只用在不會歸零的東西上</b>——
      名單只有近 20 個交易日進過成交值前 300 名的原型 ETF（不含債券、槓桿、反向——後兩者長期會被磨耗）與金融股。</p>
      <p class="note">股價不可能每次猜對：分批進、分批出，有賺就好，再等下一次。借錢買的部位不要長抱。</p>
    </section>
    ${groups || '<p class="hint">今天沒有 KD 訊號。</p>'}`;
}

// --------------------------------------------------------------------------
// 6. 規則
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// 7. 回測
// --------------------------------------------------------------------------

const HORIZONS = [
  { value: '3', label: '持有 3 個月' },
  { value: '6', label: '持有 6 個月' },
  { value: '12', label: '持有 12 個月' },
];

// 回測的組。後三組是把前兩格再依業績切開，或把偏貴那兩格挑出成長夠的——
// 驗證的是頁面上那兩條補充規則，所以跟四格並列、但用縮排標出它們是子集合。
const BT_GROUPS = [
  { key: 'cheap', label: '便宜' },
  { key: 'below', label: '相對便宜' },
  { key: 'above', label: '偏貴' },
  { key: 'pricey', label: '昂貴' },
  { key: 'solid', label: '便宜＋營收沒衰退', sub: true },
  { key: 'trap', label: '便宜＋營收衰退（陷阱）', sub: true },
  { key: 'digest', label: '偏貴＋成長消化得掉', sub: true },
];

async function loadBacktest() {
  if (state.bt !== undefined) return;
  state.bt = null;
  try {
    const res = await fetch(`${DATA}/value_backtest.json`);
    if (!res.ok) throw new Error(res.status);
    state.bt = await res.json();
  } catch (err) {
    console.warn('載不到回測', err);
    state.bt = false;
  }
  render();
}

/** 一句話的結論：只講資料說了什麼，並且把「說不了什麼」接在後面。 */
function btVerdict(g) {
  const c = g.cheap;
  const p = g.pricey;
  if (!c || !p || !c.n || !p.n) return '樣本不足，下不了結論。';
  const gap = c.medEx - p.medEx;
  const lead = gap >= 1
    ? `便宜那一格的超額中位數比昂貴那一格多 <b>${gap.toFixed(1)}</b> 個百分點，這把尺在這段期間<b>有用</b>。`
    : gap <= -1
      ? `便宜那一格反而比昂貴那一格少 <b>${(-gap).toFixed(1)}</b> 個百分點，這把尺在這段期間<b>不管用</b>——多頭裡漲最多的常常本來就貴。`
      : '便宜與昂貴兩格的差距不到 1 個百分點，這段期間<b>看不出差別</b>。';
  const s = g.solid;
  const t = g.trap;
  const trap = s && t && s.n && t.n
    ? (s.medEx - t.medEx >= 1
      ? `便宜而營收沒衰退的，比營收衰退的多 ${(s.medEx - t.medEx).toFixed(1)} 個百分點：「便宜的前提是業績沒問題」站得住。`
      : `便宜而營收沒衰退的，沒有比營收衰退的好（差 ${(s.medEx - t.medEx).toFixed(1)} 個百分點）：陷阱這條在這段期間沒有幫上忙。`)
    : '';
  return `${lead}${trap}`;
}

function backtestView() {
  if (state.bt === undefined || state.bt === null) {
    loadBacktest();
    return '<p class="hint">載入回測中…</p>';
  }
  if (state.bt === false) {
    return `<p class="hint">回測資料載不到。要先跑 <code>scripts/build_value_backtest.py</code>。</p>`;
  }
  const bt = state.bt;
  const g = bt.groups[state.h];
  const per = bt.periods[state.h];
  const cell = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
  const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const rows = BT_GROUPS.map(({ key, label, sub }) => {
    const x = g[key] || { n: 0 };
    return `<tr class="${sub ? 'val-bt-sub' : ''}">
      <th>${sub ? '└ ' : ''}${esc(label)}</th>
      <td><b>${x.n ? x.n.toLocaleString('zh-TW') : '—'}</b></td>
      <td><b class="${cls(x.med)}">${cell(x.med)}</b></td>
      <td><b class="${cls(x.medEx)}">${cell(x.medEx)}</b></td>
      <td><b>${x.n ? `${x.up}%` : '—'}</b></td>
      <td><b>${x.n ? `${x.beat}%` : '—'}</b></td>
    </tr>`;
  }).join('');

  const years = [...new Set(Object.values(bt.byYear[state.h] || {}).flatMap((y) => Object.keys(y)))].sort();
  const yearRows = BT_GROUPS.filter(({ key }) => (bt.byYear[state.h] || {})[key]).map(({ key, label, sub }) => `<tr class="${sub ? 'val-bt-sub' : ''}">
      <th>${sub ? '└ ' : ''}${esc(label)}</th>
      ${years.map((y) => {
        const v = bt.byYear[state.h][key][y];
        return `<td><b class="${cls(v)}">${cell(v)}</b></td>`;
      }).join('')}
    </tr>`).join('');

  return `<section class="card">
      <p class="lede">把「今天」換成過去的每一個月底：用<b>那時候</b>看得到的本益比區間與營收，照這一頁同一套規則判位階，
      再看之後的報酬。報酬含當時殖利率換算的現金股利；<b>超額</b>是減掉同一個月底全市場普通股的報酬中位數（等權）。
      範圍是全市場，不是題材清單——題材清單是今天挑的，拿它回測等於先挑了贏家。</p>
      <div class="controls">${pills('h', HORIZONS, state.h)}</div>
      <p class="rule-level rule-level--${(g.cheap && g.pricey && g.cheap.medEx - g.pricey.medEx >= 1) ? 'ok' : 'warn'}">
        <span>${btVerdict(g)}</span></p>
      <div class="tbl-wrap"><table class="tbl val-bt">
        <thead><tr><th>當時的位階</th><th>樣本（檔×月）</th><th>報酬中位數</th><th>超額中位數</th><th>上漲比例</th><th>贏市場比例</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <p class="note">起點是 ${esc(per.from || '—')} 到 ${esc(per.to || '—')} 的 ${per.n} 個月底。本益比資料從 ${esc(bt.dataFrom)} 開始，
        區間要滿三年才評價，所以最早只能從 ${esc(bt.firstRated || '—')} 起算。</p>
    </section>
    <section class="card">
      <h2>逐年的超額中位數 <small>一年贏、一年輸的話，平均起來的數字不可信</small></h2>
      <div class="tbl-wrap"><table class="tbl val-bt">
        <thead><tr><th>起點年份</th>${years.map((y) => `<th>${esc(y)}</th>`).join('')}</tr></thead>
        <tbody>${yearRows}</tbody>
      </table></div>
    </section>
    <section class="card note">
      <h2>這組數字不能說明的</h2>
      <p><b>整段幾乎都是 AI 多頭。</b>多頭裡漲最多的常常本來就貴，「便宜」輸很正常；便宜真正的價值是空頭裡跌得少，
        這一段資料回答不了。</p>
      <p><b>樣本數看起來比實際可靠。</b>每個月重判一次、持有期又重疊，同一檔會連續好幾個月被算進同一組，樣本是「檔 × 月」，
        不是獨立的次數。</p>
      <p><b>股票股利與分割補不回來。</b>收盤價沒有還原權息，現金股利用殖利率補了，配股與分割沒有；配股多的金融股、營建股
        會被低估。只看中位數，就是為了不讓幾檔分割把數字拉走。</p>
      <p><b>存活者偏誤。</b>下市、合併的公司在期末沒有價格，被排除在外，每一組都偏高一點。</p>
    </section>`;
}

function rulesView(d) {
  const r = d.rules;
  const m = d.market.rules;
  const items = [
    ['前提', '台股長期往上、權值股帶著大盤走。所以大跌是撿便宜的時候，不是逃命的時候。'],
    ['高檔不追', `離 ${m.lookback} 日高點不到 ${Math.abs(m.nearHigh)}%：等下跌才買，寧可保留現金。`],
    ['分批、不 All in', `資金分 ${d.market.tranches.total} 份，離高點每多跌 ${d.market.tranches.step}% 動用一份，最後一份永遠不動。`],
    ['股災不選股', `單日跌 ${Math.abs(m.crashDay)}%：直接買市值型 ETF，不花時間挑個股。`],
    ['台積電是訊號', `台積電單日跌 ${Math.abs(m.tsmcDay)}% 或離高點跌 ${Math.abs(m.tsmcDd)}%：布局市值型 ETF。`],
    ['盤整別碰正 2', `${m.lookback} 日高低差 ≤ ${m.boxRange}%：每日重設與複利會磨耗槓桿 ETF。`],
    ['題材先看量價', `營收年增中位數 ≥ ${r.volUp}%、報價三個月 ≥ ${r.priceUp}%：量價齊揚的族群才往下找個股。`],
    ['本益比只跟自己比', `近 ${r.bandYears} 年的平均最低／平均／平均最高是三道門檻；低於平均才叫不貴。`],
    ['昂貴可能是未來的便宜', `近三月營收年增 ${r.growthMin}%～${r.growthMax}% 的，粗估明年本益比；回到平均以下就還能看。金融股與年增超過一倍的景氣循環股不做。`],
    ['不追高昂貴的股票', '需求降、供給增、估值又不便宜的，一點利空就回檔——保命比賺錢重要。'],
    ['存股要不會倒', `往下攤平只對不會歸零的東西；金融股看股淨比，5% 殖利率價 = 股利 × ${r.yieldPrice}。`],
    ['價差用 KD', `K < ${r.kdLow} 買、${r.kdPause} 暫停、> ${r.kdHigh} 賣；只給原型 ETF 與金融股，槓桿與反向不算。`],
    ['專注', '見一個愛一個是最常犯的錯：專注在有把握的標的，好過亂買一大堆。'],
  ];
  return `<section class="card">
      <h2>這一頁的規則</h2>
      <ol class="rule-rules">${items.map(([t, b], k) => `<li><b>${k + 1}｜${esc(t)}</b><span>${esc(b)}</span></li>`).join('')}</ol>
      <p class="note">跟「紀律」頁的趨勢派是相反的兩套：那邊跌破均線就走，這邊跌下來才撿。先決定這一筆錢
        屬於哪一派，再照那一派做，不要兩套混用。</p>
    </section>
    <section class="card note">
      <h2>資料與限制</h2>
      <p>本益比、殖利率、股淨比來自證交所 BWIBBU 與櫃買 peQryDate，是<b>近四季</b>的，不是法人預估的明年；
        區間用每個月最後一個交易日的值（${esc(d.peSince)} 起），會略為低估年內真正的最高與最低。</p>
      <p>月營收來自公開資訊觀測站（最新 ${esc(d.revMonth)}）；報價來自本站報價頁。收盤到 ${esc(d.asof)}。</p>
      <p>這些都是機械式的判斷，不是投資建議。規則的門檻寫在 <code>scripts/build_value.py</code>。</p>
    </section>`;
}

// --------------------------------------------------------------------------
// 搜尋
// --------------------------------------------------------------------------

/**
 * 符合的代號，排序照「多像」：代號完全相同 > 代號開頭 > 名稱開頭 > 名稱包含 > 子族群名包含。
 * 子族群那一層是讓「ABF」「CPO」這種題材詞也搜得到——使用者腦中的問題常常是一個題材。
 */
function searchHits(d, q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const pool = [
    ...Object.entries(d.stocks).map(([c, s]) => [c, s, false]),
    ...Object.entries(d.etfs || {}).map(([c, s]) => [c, s, true]),
  ];
  const scored = [];
  for (const [code, s, etf] of pool) {
    const lc = code.toLowerCase();
    const name = (s.n || '').toLowerCase();
    const subs = (s.subs || []).map(([g, sub]) => `${g} ${sub}`.toLowerCase());
    let score = null;
    if (lc === needle) score = 0;
    else if (lc.startsWith(needle)) score = 1;
    else if (name.startsWith(needle)) score = 2;
    else if (name.includes(needle)) score = 3;
    else if (subs.some((t) => t.includes(needle))) score = 4;
    if (score !== null) scored.push({ code, s, etf, score });
  }
  scored.sort((a, b) => a.score - b.score || a.code.localeCompare(b.code));
  return scored;
}

function kdLine(k, eligible) {
  if (!k) return '<span class="val-muted">KD 資料不足</span>';
  const vals = `<span>日 K ${fmt(k.k, 0)}・D ${fmt(k.d, 0)}・週 K ${k.wk === null ? '—' : fmt(k.wk, 0)}</span>`;
  if (k.sig) return `${vals}<b class="val-k val-k--${KD_SIG[k.sig].tone}">${esc(KD_SIG[k.sig].label)}</b>`;
  return `${vals}${eligible ? '<span class="val-muted">沒有訊號</span>'
    : '<span class="val-muted">KD 價差只給原型 ETF 與金融股，這一檔只列數值</span>'}`;
}

/** 一檔的完整判斷卡：這一頁六個軸對它說了什麼，攤在同一張上。 */
function searchCard({ code, s, etf }) {
  const link = `<a class="linky" href="index.html#/stock/${esc(code)}">個股頁 ↗</a>`;
  if (etf) {
    return `<article class="val-card">
      <header class="val-card__head"><b>${esc(s.n || code)}</b><small>${esc(code)} · ETF</small>
        <span class="val-card__price">${fmt(s.price)}</span>${link}</header>
      <dl class="val-card__dl">
        <dt>價差</dt><dd>${kdLine(s, true)}</dd>
        <dt>估值</dt><dd><span class="val-muted">ETF 不看本益比位階</span></dd>
      </dl>
    </article>`;
  }

  const fin = s.ind === '金融保險';
  const b = s.peBand;
  const rev = s.rev;
  let note = '';
  if (s.digest) note = `<b class="val-digest">成長消化得掉：粗估明年 ${fmt(s.fwd, 1)} 倍</b>`;
  else if (s.trap) note = '<b class="val-trap">營收衰退，便宜可能是陷阱</b>';
  else if (s.fwd) note = `<span class="val-muted">粗估明年 ${fmt(s.fwd, 1)} 倍</span>`;
  const pe = s.pe === null
    ? '<span class="val-muted">虧損或沒有本益比，不評價</span>'
    : s.pe > state.data.rules.peMax
      ? `<span>${fmt(s.pe, 1)} 倍</span><span class="val-muted">超過 ${state.data.rules.peMax} 倍：獲利接近零時的本益比沒有意義，不評價</span>`
    : `<span>${fmt(s.pe, 1)} 倍 ${lvChip(s.peLv)}</span>${b
      ? `<span class="val-muted">平均最低 ${fmt(b.lo, 1)}／平均 ${fmt(b.avg, 1)}／平均最高 ${fmt(b.hi, 1)}（${b.years} 年）</span>`
      : '<span class="val-muted">歷史不滿三年，不評價</span>'}${note}`;
  const growth = rev
    ? `<span>${esc(state.data.revMonth)} 年增 <b class="${dir(rev.yoy)}">${pct(rev.yoy)}</b>（上月 ${pct(rev.yoyPrev)}、近三月平均 ${pct(rev.yoy3)}）</span>${
      rev.high ? '<span class="val-good">營收創一年新高</span>' : ''}`
    : '<span class="val-muted">沒有月營收</span>';
  const under = s.yldPrice && s.price && s.price <= s.yldPrice;
  const income = `<span>殖利率 ${s.yld ? `${fmt(s.yld, 2)}%` : '—'}・5% 殖利率價 ${s.yldPrice ? fmt(s.yldPrice, 2) : '—'}${
    under ? ' <b class="val-good">股價在它下面</b>' : ''}</span>
    <span>股淨比 ${fmt(s.pb, 2)} ${fin ? lvChip(s.pbLv) : '<span class="val-muted">（金融股才用這把尺）</span>'}</span>${
    s.state ? '<span class="chip accent">官股</span>' : ''}`;
  const themes = (s.subs || []).length
    ? s.subs.map(([g, sub]) => `<button class="chip accent val-card__theme" data-goto="${esc(`${g}|${sub}`)}">${esc(sub)}</button>`).join('')
    : `<span class="val-muted">${esc(s.ind || '不在題材族群表上')}</span>`;

  return `<article class="val-card">
    <header class="val-card__head"><b>${esc(s.n || code)}</b><small>${esc(code)}${s.ind ? ` · ${esc(s.ind)}` : ''}</small>
      <span class="val-card__price">${fmt(s.price)}</span>${link}</header>
    <div class="val-card__band">${bandBar(s.pe, b)}</div>
    <dl class="val-card__dl">
      <dt>估值</dt><dd>${pe}</dd>
      <dt>營收</dt><dd>${growth}</dd>
      <dt>存股</dt><dd>${income}</dd>
      <dt>價差</dt><dd>${kdLine(s.kd, fin)}</dd>
      <dt>題材</dt><dd>${themes}</dd>
    </dl>
  </article>`;
}

function searchView(d) {
  const hits = searchHits(d, state.q);
  const shown = hits.slice(0, SEARCH_LIMIT);
  const head = hits.length
    ? `找到 ${hits.length} 檔${hits.length > shown.length ? `，列出前 ${shown.length} 檔——再多打幾個字縮小範圍` : ''}。`
    : '沒有符合的標的。這一頁只收題材族群的成分股、金融股，與成交熱絡的原型 ETF。';
  return `<section class="card"><p class="lede">「${esc(state.q.trim())}」：${head}</p></section>
    ${shown.length ? `<section class="card">${shown.map(searchCard).join('')}</section>` : ''}`;
}

// --------------------------------------------------------------------------

function render() {
  const d = state.data;
  $('#meta').textContent = `收盤 ${d.asof} · 本益比 ${d.peAsof} · 營收 ${d.revMonth}`;
  if (state.q.trim()) {
    $('#view').innerHTML = searchView(d);
    return;
  }
  const view = { market: marketView, theme: themeView, stock: stockView, income: incomeView, kd: kdView, backtest: backtestView, rules: rulesView }[state.view] || marketView;
  $('#view').innerHTML = `
    <section class="card"><div class="controls val-views">${pills('view', VIEWS, state.view)}</div></section>
    ${view(d)}`;
}

function bind() {
  $('#view').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const ds = btn.dataset;
    if (ds.view) {
      state.view = ds.view;
      save(KEYS.view, state.view);
    } else if (ds.lv) {
      state.lv = ds.lv;
      save(KEYS.lv, state.lv);
    } else if (ds.h) {
      state.h = ds.h;
      save(KEYS.h, state.h);
    } else if (ds.sort) {
      state.sort = ds.sort;
      save(KEYS.sort, state.sort);
    } else if (ds.goto) {
      // 搜尋卡上的題材：清掉搜尋、切到題材軸、展開那一族
      state.q = '';
      $('#q').value = '';
      state.view = 'theme';
      save(KEYS.view, state.view);
      state.openT.add(ds.goto);
    } else if (ds.t) {
      if (state.openT.has(ds.t)) state.openT.delete(ds.t);
      else state.openT.add(ds.t);
    } else {
      return;
    }
    render();
  });
}

function bindSearch() {
  const input = $('#q');
  if (!input) return;
  input.addEventListener('input', () => {
    state.q = input.value;
    render();
  });
  // Esc 清空。手機上沒有這個鍵，但 type=search 的框本身有清除鈕
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && input.value) {
      input.value = '';
      state.q = '';
      render();
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
    const pick = (key, list) => {
      const v = localStorage.getItem(key);
      return list.some((o) => o.value === v) ? v : null;
    };
    state.view = pick(KEYS.view, VIEWS) || state.view;
    state.lv = pick(KEYS.lv, LEVEL_FILTERS) || state.lv;
    state.sort = pick(KEYS.sort, STOCK_SORTS) || state.sort;
    state.h = pick(KEYS.h, HORIZONS) || state.h;
  } catch (err) {
    /* 讀不到就用預設 */
  }
}

async function main() {
  restore();
  try {
    const res = await fetch(`${DATA}/value.json`);
    if (!res.ok) throw new Error(`value.json ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    console.error(err);
    $('#meta').textContent = '載入失敗';
    $('#view').innerHTML = `<p class="hint">資料載不到。這一頁要等
      <code>scripts/fetch_value.py</code> 與 <code>scripts/build_value.py</code> 跑過一次才有東西。</p>`;
    return;
  }
  bind();
  bindSearch();
  render();
}

main();
