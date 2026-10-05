/*
 * 景氣（cycle.html）：哪些股票的營收跟著景氣循環，它們現在走到循環的哪一段。
 *
 * 回答的問題：**景氣走到哪了？哪些產業、哪幾檔是循環股？各自在谷底、復甦、高峰還是退潮？**
 *
 *   景氣   所有公司近 3 個月營收年增的中位數，2019 年起的整條線
 *   產業   哪些產業循環、前後兩半是不是都成立、現在年增多少
 *   位置   循環股落在四格裡的哪一格，每一格是檔數也是篩選鈕
 *   清單   每一檔的 beta、年增、距高峰；點開看它的營收年增疊在景氣線上
 *   新跟上 前半段不跟景氣、後半段才同步的（這一輪的主角，不是傳統循環股）
 *
 * 另一個分頁「月曆」是使用者要的固定 1～12 月買進／賣出清單（scripts/build_season.py）。
 * 它沒通過 walk-forward，所以最上面先放檢驗結果與「純靠運氣預期幾檔」，結論照數字寫。
 *
 * 判斷全在 scripts/build_cycle.py 算好，門檻也從那裡帶過來（data.rules），這裡只畫。
 * 這是營收的循環，股價有沒有跟著走還沒有回測——頁面上不能長得像買賣訊號。
 */

const DATA = 'data';

const PHASE = {
  trough: { label: '谷底', hint: '離高峰遠，年增還是負的' },
  recover: { label: '復甦', hint: '離高峰遠，年增已經轉正' },
  peak: { label: '高峰', hint: '接近高峰，年增仍是正的' },
  ebb: { label: '退潮', hint: '接近高峰，年增已經轉負' },
};

const VERS = [
  { value: 'strict', label: '嚴格：前後兩半都成立' },
  { value: 'loose', label: '寬鬆：只看全期' },
];
const SIZES = [
  { value: '0', label: '不限' },
  { value: '20', label: '營收 ≥ 20 億' },
  { value: '100', label: '≥ 100 億' },
];
const SORTS = [
  { value: 'beta', label: '振幅大到小' },
  { value: 'vp', label: '離高峰遠到近' },
  { value: 'yoy', label: '年增高到低' },
];

const NOW_M = new Date().getMonth() + 1;
const NEXT_M = (NOW_M % 12) + 1;
const BMS = [
  { value: 'all', label: '不限月份' },
  { value: String(NOW_M), label: `${NOW_M} 月適合買進` },
  { value: String(NEXT_M), label: `${NEXT_M} 月適合買進` },
];

const PAGE = 40;          // 清單一次列幾檔

const state = {
  data: null,
  ver: 'strict',
  size: '20',
  sort: 'beta',
  phase: null,
  ind: null,
  open: new Set(),
  more: 1,
  freshMore: 1,
  bm: 'all',
  tab: 'cycle',
  month: new Date().getMonth() + 1,
  side: 'buy',
  basis: 'abs',
  season: undefined,   // 月曆資料：undefined 還沒載、null 載不到
};

const TABS = [
  { value: 'cycle', label: '循環' },
  { value: 'season', label: '月曆' },
];
const BASES = [
  { value: 'abs', label: '自己漲跌' },
  { value: 'rel', label: '贏大盤' },
];
const SIDES = [
  { value: 'buy', label: '買進清單' },
  { value: 'sell', label: '賣出清單' },
];

const KEYS = {
  ver: 'stocktracker.cyclever',
  size: 'stocktracker.cyclesize',
  sort: 'stocktracker.cyclesort',
  tab: 'stocktracker.cycletab',
  basis: 'stocktracker.cyclebasis',
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (v, digits = 2) => (v === null || v === undefined ? '—'
  : Number(v).toLocaleString('zh-TW', { maximumFractionDigits: digits }));
const pct = (v, digits = 0) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`);
const dir = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');

function pills(name, options, current) {
  return `<div class="pills">${options
    .map((o) => `<button class="pill ${o.value === current ? 'active' : ''}" data-${name}="${o.value}">${esc(o.label)}</button>`)
    .join('')}</div>`;
}

// --------------------------------------------------------------------------
// 折線圖。SVG 直接畫，這一頁不值得為兩張圖載一個圖表庫。
// --------------------------------------------------------------------------

/**
 * series：[{ v: [...], cls }]，與 months 等長、可有 null。負的那一段（景氣在收縮）上底色。
 * shade：拿哪一條判斷收縮期；年份標在圖下面（SVG 是拉伸的，字放在裡面會變形）。
 */
function lineChart(months, series, { shade = null, height = 160, label = '' } = {}) {
  const W = 600;
  const H = 180;
  const pad = 6;
  const all = series.flatMap((s) => s.v).filter((v) => v !== null && v !== undefined);
  const lo = Math.min(0, ...all);
  const hi = Math.max(0, ...all);
  const n = months.length;
  const x = (k) => pad + (k / Math.max(1, n - 1)) * (W - pad * 2);
  const y = (v) => pad + (1 - (v - lo) / (hi - lo || 1)) * (H - pad * 2);
  const path = (v) => v.map((p, k) => (p === null || p === undefined ? null : `${x(k).toFixed(1)},${y(p).toFixed(1)}`))
    .filter(Boolean).join(' ');

  let bands = '';
  if (shade) {
    const step = (W - pad * 2) / Math.max(1, n - 1);
    shade.forEach((v, k) => {
      if (v !== null && v < 0) {
        bands += `<rect class="cyc-chart__neg" x="${(x(k) - step / 2).toFixed(1)}" y="0" width="${step.toFixed(1)}" height="${H}"/>`;
      }
    });
  }
  const years = [];
  months.forEach((m, k) => {
    if (m.endsWith('-01')) years.push(`<span style="left:${(x(k) / W) * 100}%">${m.slice(0, 4)}</span>`);
  });

  return `<figure class="cyc-chart">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}" style="height:${height}px">
      ${bands}
      <line class="cyc-chart__zero" x1="0" x2="${W}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>
      ${series.map((s) => `<polyline class="cyc-line ${s.cls}" points="${path(s.v)}"/>`).join('')}
    </svg>
    <div class="cyc-chart__years">${years.join('')}</div>
    <div class="cyc-chart__range">上 ${pct(hi)}　下 ${pct(lo)}</div>
  </figure>`;
}

/** 近 12 個月營收的迷你走勢，以它自己的高點 = 100。 */
function spark(values) {
  const pts = values.filter((v) => v !== null);
  const w = 68;
  const h = 24;
  if (pts.length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"></svg>`;
  const min = Math.min(...pts);
  const span = 100 - min || 1;
  const line = pts.map((v, i) => `${(1 + (i / (pts.length - 1)) * (w - 2)).toFixed(1)},${(h - 1 - ((v - min) / span) * (h - 2)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${line}"/></svg>`;
}

// --------------------------------------------------------------------------
// 1. 景氣
// --------------------------------------------------------------------------

function indexCard(d) {
  const v = d.index[d.index.length - 1];
  const prev = d.index[d.index.length - 2];
  const share = d.share[d.share.length - 1];
  const run = d.run;
  const runText = run > 0 ? `連 ${run} 個月走高` : run < 0 ? `連 ${-run} 個月走低` : '持平';
  let lo = Infinity;
  let loAt = '';
  let hi = -Infinity;
  let hiAt = '';
  d.index.forEach((x, k) => {
    if (x === null) return;
    if (x < lo) { lo = x; loAt = d.months[k]; }
    if (x > hi) { hi = x; hiAt = d.months[k]; }
  });
  return `<section class="card">
    <h2>景氣 <small>所有公司近 3 個月營收年增的中位數</small></h2>
    <div class="stat-grid">
      <div class="stat"><b class="${dir(v)}">${pct(v, 1)}</b><span>${esc(d.revMonth)}（上月 ${pct(prev, 1)}）</span></div>
      <div class="stat"><b class="sm">${runText}</b><span>方向</span></div>
      <div class="stat"><b>${share ?? '—'}%</b><span>年增為正的公司</span></div>
    </div>
    ${lineChart(d.months, [{ v: d.index, cls: 'cyc-line--mkt' }], { shade: d.index, label: '景氣指標：近 3 個月營收年增中位數' })}
    <p class="note">底色是收縮期（中位數年增 &lt; 0）。這段期間的高點是 ${esc(hiAt)} 的 ${pct(hi, 1)}、
      低點是 ${esc(loAt)} 的 ${pct(lo, 1)}。用中位數而不是加總，是因為加總會被台積電一家帶著走。
      樣本 ${d.sample} 檔：非金融、資料滿 ${d.months.length - 8} 個月以上、月營收平均 ${fmt(d.rules.minRevWan, 0)} 萬以上。</p>
  </section>`;
}

// --------------------------------------------------------------------------
// 2. 產業
// --------------------------------------------------------------------------

const dots = (n) => `<span class="cyc-dots" title="前後兩半有幾段成立">${'<i class="on"></i>'.repeat(n)}${'<i></i>'.repeat(2 - n)}</span>`;

function indRow(r) {
  const on = state.ind === r.ind;
  return `<button class="row cyc-ind ${on ? 'is-on' : ''}" data-ind="${esc(r.ind)}">
    <span class="cyc-ind__beta"><b>${fmt(r.beta, 1)}</b><small>beta</small></span>
    <span class="ident">
      <span class="name">${esc(r.ind)}</span>
      <span class="code">${dots(r.halves)} 前 ${r.b1.toFixed(1)}／後 ${r.b2.toFixed(1)} · ${r.cyc}／${r.n} 檔入選</span>
    </span>
    <span class="figures"><span class="value ${dir(r.yoy)}">${pct(r.yoy, 1)}</span><span class="price">現在年增</span></span>
  </button>`;
}

function industryCard(d) {
  const r = d.rules;
  const isCyc = (x) => x.halves > 0 && x.beta >= r.beta;
  const cyc = d.industries.filter(isCyc);
  const rest = d.industries.filter((x) => !isCyc(x)).sort((a, b) => b.beta - a.beta);
  const pass = (b, c) => b >= r.beta && c >= r.corr;
  const early = cyc.filter((x) => pass(x.b1, x.c1) && !pass(x.b2, x.c2)).map((x) => x.ind);
  return `<section class="card">
    <h2>哪些產業是循環的 <small>成分股的中位數，點一下篩下面的清單</small></h2>
    ${cyc.map(indRow).join('')}
    <details class="cyc-more">
      <summary>不太跟景氣的 ${rest.length} 個產業</summary>
      ${rest.map(indRow).join('')}
    </details>
    <p class="note">beta：景氣（中位數年增）動 1%，這個產業的營收年增動幾 %。「前／後」是前後兩半（以 ${esc(d.split)} 為界）各自的 beta，圓點是那一半是否 beta ≥ ${r.beta} 且相關 ≥ ${r.corr}。${early.length ? `只有前半成立的是${early.map(esc).join('、')}：
      後半段大家營收回升時它們沒跟上，這也是一種訊息。` : ''}</p>
  </section>`;
}

// --------------------------------------------------------------------------
// 3. 位置與 4. 清單
// --------------------------------------------------------------------------

function pool(d) {
  const min = Number(state.size);
  return d.stocks.filter((s) => s[state.ver] && s.rev >= min && (!state.ind || s.ind === state.ind)
    && (state.bm === 'all' || s.bm === Number(state.bm)));
}

function quadCard(d, list) {
  const count = (p) => list.filter((s) => s.phase === p).length;
  const cell = (p) => `<button class="cyc-quad__cell cyc-quad__cell--${p} ${state.phase === p ? 'is-on' : ''}" data-phase="${p}">
      <b>${count(p)}</b><span>${PHASE[p].label}</span><small>${PHASE[p].hint}</small>
    </button>`;
  return `<section class="card">
    <h2>循環位置 <small>${list.length} 檔各在哪一格，點一格篩清單</small></h2>
    <div class="cyc-quad">
      <span class="cyc-quad__y">年增為正</span>
      ${cell('recover')}${cell('peak')}
      <span class="cyc-quad__y cyc-quad__y--neg">年增為負</span>
      ${cell('trough')}${cell('ebb')}
      <span></span>
      <span class="cyc-quad__x">離高峰遠（&lt; ${d.rules.nearPeak}%）</span>
      <span class="cyc-quad__x">接近高峰</span>
    </div>
    <p class="note">橫軸是近 12 個月營收距離它自己歷史最高的位置，縱軸是近 3 個月營收年增率。
      循環照理是 谷底 → 復甦 → 高峰 → 退潮 → 谷底 轉一圈。</p>
  </section>`;
}

/**
 * 12 個月各自「自己含息上漲」的勝率。一格一個月，顏色越深勝率越高，框起來的是適合買進的那個月。
 * 數字是漲的年數／年數：樣本只有七、八年，百分比會讓人以為比實際準。
 */
function monthStrip(s) {
  if (!s.mon) return '';
  return `<div class="cyc-mon">${s.mon.map(([up, n, avg], k) => {
    const r = n ? up / n : 0;
    const tone = r >= 0.5 ? 'up' : 'down';
    const a = n ? Math.abs(r - 0.5) * 2 : 0;
    return `<span class="cyc-mon__m ${tone} ${s.bm === k + 1 ? 'is-best' : ''}" style="--a:${a.toFixed(2)}"
      title="${k + 1} 月：漲 ${up}／${n} 年，平均 ${pct(avg, 1)}"><b>${k + 1}</b><small>${up}/${n}</small></span>`;
  }).join('')}</div>`;
}

function stockRow(s, d) {
  const open = state.open.has(s.c);
  const ph = s.phase ? PHASE[s.phase] : null;
  const detail = open ? `<div class="cyc-detail">
      ${lineChart(d.months, [{ v: d.index, cls: 'cyc-line--mkt' }, { v: s.y, cls: 'cyc-line--stk' }],
        { shade: d.index, height: 140, label: `${s.n || s.c} 的營收年增與景氣` })}
      <div class="cyc-detail__keys"><span class="cyc-key cyc-line--stk">${esc(s.n || s.c)} 近 3 個月營收年增</span>
        <span class="cyc-key cyc-line--mkt">景氣（中位數）</span></div>
      <dl class="cyc-detail__dl">
        <dt>振幅</dt><dd>beta 全期 ${fmt(s.beta, 1)}・前半 ${fmt(s.b1, 1)}・後半 ${fmt(s.b2, 1)}</dd>
        <dt>同步</dt><dd>相關 全期 ${fmt(s.corr)}・前半 ${fmt(s.c1)}・後半 ${fmt(s.c2)}</dd>
        <dt>衰退</dt><dd>近 12 個月營收最深回落 ${pct(s.dd)}，現在距高峰 ${pct(s.vp)}</dd>
        <dt>規模</dt><dd>近 12 個月營收 ${fmt(s.rev, 0)} 億</dd>
        <dt>月份</dt><dd>${s.bm ? `過去 <b>${s.bm} 月</b>最常漲：${s.mon[s.bm - 1][0]}／${s.mon[s.bm - 1][1]} 年，平均 ${pct(s.mon[s.bm - 1][2], 1)}` : '紀錄不滿 6 年，不標'}</dd>
      </dl>
      ${monthStrip(s)}
      <a class="cyc-detail__link" href="index.html#/stock/${esc(s.c)}">看個股 K 線與法人 →</a>
    </div>` : '';
  return `<div class="cyc-item ${open ? 'is-open' : ''}">
    <button class="row cyc-row" data-open="${esc(s.c)}">
      <span class="cyc-tag cyc-tag--${s.phase || 'none'}">${ph ? ph.label : '—'}<small>β ${fmt(s.beta, 1)}</small></span>
      <span class="ident">
        <span class="name">${esc(s.n || s.c)}</span>
        <span class="code">${esc(s.c)} · ${esc(s.ind)}${s.bm ? ` · <em class="cyc-bm">宜 ${s.bm} 月</em>` : ''}</span>
      </span>
      ${spark(s.t)}
      <span class="figures"><span class="value ${dir(s.yoy)}">${pct(s.yoy)}</span><span class="price">距高峰 ${pct(s.vp)}</span></span>
    </button>
    ${detail}
  </div>`;
}

const SORT_FN = {
  beta: (a, b) => b.beta - a.beta,
  vp: (a, b) => (a.vp ?? 0) - (b.vp ?? 0),
  yoy: (a, b) => (b.yoy ?? -1e9) - (a.yoy ?? -1e9),
};

/** 「宜 X 月」是怎麼來的，以及它過去準不準。數字照 bestWalk 寫，不寫死。 */
function bmNote(d) {
  const w = d.bestWalk;
  if (!w || !w.n) return '';
  const works = w.t >= 2 && w.hit > 50;
  return `<p class="note"><b>宜 X 月</b>：過去每年同一個月它<b>自己</b>含息上漲的勝率最高的月份（同勝率比平均漲幅），
    點開一列看 12 個月各自的勝率。${works ? '' : '<b>這個月份延續不到下一年</b>：'}只用那一年以前的資料挑月份，
    那一年它在那個月比其餘月份平均${w.diff >= 0 ? '多' : '少'} ${Math.abs(w.diff)}%，t 值 ${fmt(w.t)}，${w.n} 次裡只有 ${w.hit}% 真的比較好。
    很多檔都落在 2 月，是因為過去 8 年的 2 月有 7 年連一般股票都在漲——那是整個市場的季節性，不是這一檔的。</p>`;
}

function listCard(d, list) {
  const rows = list.filter((s) => !state.phase || s.phase === state.phase).sort(SORT_FN[state.sort]);
  const shown = rows.slice(0, PAGE * state.more);
  const chips = [
    state.phase ? `<button class="cyc-chip" data-phase="${state.phase}">${PHASE[state.phase].label} ✕</button>` : '',
    state.ind ? `<button class="cyc-chip" data-ind="${esc(state.ind)}">${esc(state.ind)} ✕</button>` : '',
  ].join('');
  return `<section class="card" id="list">
    <h2>循環股 <small>${rows.length} 檔，點一列展開</small></h2>
    <div class="controls cyc-controls">
      ${pills('ver', VERS, state.ver)}
      ${pills('size', SIZES, state.size)}
      ${pills('sort', SORTS, state.sort)}
      ${pills('bm', BMS, state.bm)}
      ${chips ? `<div class="pills">${chips}</div>` : ''}
    </div>
    ${shown.length ? shown.map((s) => stockRow(s, d)).join('') : '<p class="hint">這個條件下沒有股票。</p>'}
    ${rows.length > shown.length ? `<button class="cyc-morebtn" data-more="list">再列 ${Math.min(PAGE, rows.length - shown.length)} 檔（還有 ${rows.length - shown.length}）</button>` : ''}
    <p class="note">右邊的數字是近 3 個月營收年增，下面一行是近 12 個月營收距它自己的高峰；迷你線是近 12 個月營收的走勢。
      「嚴格」要前後兩半各自 beta ≥ ${d.rules.beta}、相關 ≥ ${d.rules.corr}，而且近 12 個月營收曾經回落 ${Math.abs(d.rules.drawdown)}% 以上。</p>
    ${bmNote(d)}
  </section>`;
}

function freshCard(d) {
  const min = Number(state.size);
  const rows = d.stocks.filter((s) => s.fresh && s.rev >= min && (!state.ind || s.ind === state.ind))
    .sort((a, b) => b.rev - a.rev);
  if (!rows.length) return '';
  const shown = rows.slice(0, 10 * state.freshMore);
  return `<section class="card">
    <h2>這一輪新跟上的 <small>${rows.length} 檔，依營收規模</small></h2>
    <p class="lede">前半段營收<b>不跟</b>景氣（相關 &lt; ${d.rules.fresh1}）、後半段才高度同步的。
      這比較像是<b>這一輪行情的主角</b>（AI、先進製程）把景氣線帶著走，不是傳統的循環股，所以不放進上面的名單。</p>
    ${shown.map((s) => stockRow(s, d)).join('')}
    ${rows.length > shown.length ? `<button class="cyc-morebtn" data-more="fresh">再列 10 檔（還有 ${rows.length - shown.length}）</button>` : ''}
  </section>`;
}

// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// 月曆：1～12 月的買進與賣出清單
// --------------------------------------------------------------------------

async function loadSeason() {
  try {
    const res = await fetch(`${DATA}/season.json`);
    if (!res.ok) throw new Error(`season.json ${res.status}`);
    state.season = await res.json();
  } catch (err) {
    console.error(err);
    state.season = null;
  }
  render();
}

/** 兩種勝率基準的用詞。rel 跟一般股票比；abs 只看它自己有沒有漲。 */
const BASIS = {
  rel: { win: '贏', lose: '輸', what: '贏大盤', yearly: '超額', def: '這個月它的含息漲跌贏過<b>全市場普通股漲跌的中位數</b>（一般股票），不是加權指數' },
  abs: { win: '漲', lose: '跌', what: '自己漲跌', yearly: '含息漲跌', def: '這個月它<b>自己</b>含息是漲還是跌，不跟任何人比' },
};

/** walk-forward 的結論。照數字寫，不寫死：哪天真的變顯著了，這一段自己會改口。 */
function verdictCard(z) {
  const B = BASIS[state.basis];
  const w = z.bases[state.basis].walk;
  const works = w.t >= 2 && w.spread > 0;
  return `<section class="card">
    <h2>先看這個 <small>過去的勝率，下一年還準嗎</small></h2>
    <div class="stat-grid">
      <div class="stat"><b class="${w.buyHit > w.allHit + 2 ? 'up' : ''}">${w.buyHit}%</b><span>買進清單下一年真的${B.win}</span></div>
      <div class="stat"><b>${w.allHit}%</b><span>全市場同一個月${B.win}的比例</span></div>
      <div class="stat"><b class="${w.sellHit > 100 - w.allHit + 2 ? 'down' : ''}">${w.sellHit}%</b><span>賣出清單下一年真的${B.lose}</span></div>
    </div>
    <p class="rule-level rule-level--${works ? 'ok' : 'warn'}">
      <b>${works ? '過去的月份規律有延續到下一年' : '過去的勝率延續不到下一年'}</b>
      <span>把「今天」換成 ${esc(w.from)} 以後的每一年，只用那一年以前的資料照同一條規則挑前 ${z.rules.wfN} 檔，
        看那一年同一個月它們是不是真的${B.win}：買進清單 ${w.buyHit}%，跟全市場的 ${w.allHit}% ${Math.abs(w.buyHit - w.allHit) <= 2 ? '差不多' : '有差'}。
        換成報酬：買進減賣出平均 ${pct(w.spread, 2)}／月，t 值 ${fmt(w.t)}${works ? '' : '，不到 2，跟擲硬幣分不開'}。</span>
    </p>
    <p class="note">為什麼會這樣：一千多檔股票、每檔只有 7、8 年，就算股價完全隨機，「${B.win}的年份 ≥ ${Math.round(z.rules.hit * 100)}%」
      每個月份也會有上百檔。下面每個月都寫了「純靠運氣預期幾檔」——實際檔數跟它差不多，就代表那個月沒有規律。</p>
  </section>`;
}

function yearBars(y, years) {
  return `<span class="ssn-years">${years.map((yr) => {
    const v = y[yr];
    if (v === undefined) return '<i class="ssn-bar ssn-bar--none"></i>';
    const h = Math.min(100, Math.abs(v) * 4);
    return `<i class="ssn-bar ${v > 0 ? 'up' : 'down'}" style="--h:${Math.max(10, h)}%" title="${yr}：${pct(v, 1)}"></i>`;
  }).join('')}</span>`;
}

/** 過往勝率：「86%（6／7）」。百分比好比，括號裡的年數提醒樣本只有這幾年。 */
const rate = (k, n) => (n ? `${Math.round((k / n) * 100)}%（${k}／${n}）` : '—');

/** 買進清單看贏（漲）的年數、賣出清單看輸（跌）的年數。 */
const wins = (r) => (state.side === 'buy' ? r.win : r.yrs - r.win);

function seasonRow(r, years) {
  const B = BASIS[state.basis];
  const buy = state.side === 'buy';
  // 底下一行補另一種基準，兩種勝率都看得到
  const other = state.basis === 'rel'
    ? `<span>自己上漲 <b>${rate(r.up, r.yrs)}</b></span>`
    : `<span>贏大盤 <b>${rate(r.rw, r.yrs)}</b></span>`;
  return `<a class="row ssn-row" href="index.html#/stock/${esc(r.c)}">
    <span class="ident">
      <span class="name">${esc(r.n || r.c)}</span>
      <span class="code">${esc(r.c)} · ${esc(r.ind)}${r.rev ? ` · 營收 ${fmt(r.rev, 0)} 億` : ''}</span>
    </span>
    ${yearBars(r.y, years)}
    <span class="figures ssn-win">
      <span class="value ${buy ? 'up' : 'down'}">${Math.round((wins(r) / r.yrs) * 100)}%</span>
      <span class="price">${buy ? B.win : B.lose} ${wins(r)}／${r.yrs} 年</span>
    </span>
    <span class="ssn-rate">
      ${other}
      <span>平均漲跌 <b class="${dir(r.avg)}">${pct(r.avg, 1)}</b></span>
      <span>${B.yearly}中位數 <b class="${dir(r.med)}">${pct(r.med, 1)}</b></span>
    </span>
  </a>`;
}

function indList(rows, title) {
  return `<div class="ssn-ind"><h3>${title}</h3><ol>${rows.map((r) =>
    `<li><span>${esc(r.ind)}</span><em class="${dir(r.avg)}">${pct(r.avg, 1)}</em><small>${Math.round((r.win / r.yrs) * 100)}%</small></li>`).join('')}</ol></div>`;
}

function seasonView() {
  const z = state.season;
  if (z === undefined) return '<p class="hint">載入中…</p>';
  if (z === null) return '<p class="hint">月曆資料載不到。要先跑 <code>scripts/build_season.py</code>。</p>';
  const B = BASIS[state.basis];
  const base = z.bases[state.basis];
  const mo = base.months.find((r) => r.m === state.month) || base.months[0];
  const min = Number(state.size);
  const all = mo[state.side];
  // 勝率高的排前面，同勝率再比中位數
  const rows = all.filter((r) => (r.rev ?? 0) >= min)
    .sort((a, b) => wins(b) / b.yrs - wins(a) / a.yrs || Math.abs(b.med) - Math.abs(a.med));
  const wfm = base.walk.byMonth[mo.m];
  const months = Array.from({ length: 12 }, (_, k) => ({ value: String(k + 1), label: `${k + 1} 月` }));
  const sideN = mo[`${state.side}N`];
  const yr = `${mo.years[0]}～${mo.years[mo.years.length - 1]}`;
  return `<section class="card">
      <div class="controls cyc-controls">
        <span class="ssn-label">勝率基準</span>${pills('basis', BASES, state.basis)}
      </div>
      <p class="note">${B.def}。</p>
    </section>
    ${verdictCard(z)}
    <section class="card">
      <div class="controls cyc-controls">${pills('month', months, String(mo.m))}</div>
      <div class="stat-grid">
        <div class="stat"><b>${mo.buyN}</b><span>符合買進（運氣 ${mo.luckBuy}）</span></div>
        <div class="stat"><b>${mo.sellN}</b><span>符合賣出（運氣 ${mo.luckSell}）</span></div>
        <div class="stat"><b>${z.upShare[mo.m]}%</b><span>${mo.m} 月平均有幾成股票上漲</span></div>
      </div>
      <div class="ssn-inds">
        ${indList(mo.indUp, `${mo.m} 月偏強的產業`)}
        ${indList(mo.indDown, `${mo.m} 月偏弱的產業`)}
      </div>
      <p class="note">產業是成分股${B.yearly}的中位數，再對 ${yr} 年取平均；右邊是${B.win}的年份比例。
        只看 ${mo.m} 月的 walk-forward（${base.walk.byMonthN[mo.m]} 年）：買進減賣出 ${wfm === null || wfm === undefined ? '—' : pct(wfm, 1)}。</p>
    </section>
    <section class="card">
      <h2>${mo.m} 月${state.side === 'buy' ? '買進' : '賣出'}清單 <small>${sideN} 檔符合，列出前 ${all.length} 檔中的 ${rows.length} 檔</small></h2>
      <div class="controls cyc-controls">
        ${pills('side', SIDES, state.side)}
        ${pills('size', SIZES, state.size)}
      </div>
      ${rows.length ? rows.map((r) => seasonRow(r, mo.years)).join('') : '<p class="hint">這個條件下沒有股票。</p>'}
      <p class="note">${state.side === 'buy' ? '買進' : '賣出'}：過去至少 ${z.rules.minYears} 年的 ${mo.m} 月裡，
        ${state.side === 'buy' ? B.win : B.lose}的年份 ≥ ${Math.round(z.rules.hit * 100)}%（基準：${B.what}），
        依勝率排、同勝率比中位數。底下一行補上另一種勝率、平均含息漲跌，與${B.yearly}的中位數。
        小長條是每一年 ${mo.m} 月的${B.yearly}（${mo.years[0]} → ${mo.years[mo.years.length - 1]}，紅${B.win}綠${B.lose}）。
        股價已還原除權息；資料 ${esc(z.from)} ～ ${esc(z.to)}。</p>
    </section>`;
}

function render() {
  const d = state.data;
  const head = `<section class="card"><div class="controls cyc-tabs">${pills('tab', TABS, state.tab)}</div></section>`;
  if (state.tab === 'season') {
    const z = state.season;
    $('#meta').textContent = z ? `股價 ${z.from} ～ ${z.to} · ${z.sample} 檔 · 已還原除權息` : '月曆';
    $('#view').innerHTML = head + seasonView();
    if (z === undefined) loadSeason();
    return;
  }
  $('#meta').textContent = `營收 ${d.revMonth} · 樣本 ${d.sample} 檔 · 前後兩半以 ${d.split} 為界`;
  const list = pool(d);
  $('#view').innerHTML = head + indexCard(d) + industryCard(d) + quadCard(d, list) + listCard(d, list) + freshCard(d);
}

function bind() {
  $('#view').addEventListener('click', (ev) => {
    const el = ev.target.closest('button');
    if (!el) return;
    const ds = el.dataset;
    let scroll = false;
    if (ds.open) {
      if (state.open.has(ds.open)) state.open.delete(ds.open);
      else state.open.add(ds.open);
    } else if (ds.phase) {
      state.phase = state.phase === ds.phase ? null : ds.phase;
      state.more = 1;
    } else if (ds.ind !== undefined) {
      const was = state.ind === ds.ind;
      state.ind = was ? null : ds.ind;
      state.more = 1;
      scroll = !was && !el.classList.contains('cyc-chip');
    } else if (ds.bm) {
      state.bm = ds.bm;
      state.more = 1;
    } else if (ds.ver) {
      state.ver = ds.ver;
      save(KEYS.ver, ds.ver);
    } else if (ds.size) {
      state.size = ds.size;
      save(KEYS.size, ds.size);
    } else if (ds.sort) {
      state.sort = ds.sort;
      save(KEYS.sort, ds.sort);
    } else if (ds.tab) {
      state.tab = ds.tab;
      save(KEYS.tab, ds.tab);
    } else if (ds.month) {
      state.month = Number(ds.month);
    } else if (ds.basis) {
      state.basis = ds.basis;
      save(KEYS.basis, ds.basis);
    } else if (ds.side) {
      state.side = ds.side;
    } else if (ds.more === 'list') {
      state.more += 1;
    } else if (ds.more === 'fresh') {
      state.freshMore += 1;
    } else {
      return;
    }
    // 重畫會把 <details> 收起來；產業的展開狀態要留著，不然點了下面那一群會整段闔上
    const opened = $('.cyc-more')?.open;
    render();
    if (opened) $('.cyc-more').open = true;
    if (scroll) $('#list')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    state.ver = pick(KEYS.ver, VERS) || state.ver;
    state.size = pick(KEYS.size, SIZES) || state.size;
    state.sort = pick(KEYS.sort, SORTS) || state.sort;
    state.tab = pick(KEYS.tab, TABS) || state.tab;
    state.basis = pick(KEYS.basis, BASES) || state.basis;
  } catch (err) {
    /* 讀不到就用預設 */
  }
}

async function main() {
  restore();
  try {
    const res = await fetch(`${DATA}/cycle.json`);
    if (!res.ok) throw new Error(`cycle.json ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    console.error(err);
    $('#meta').textContent = '載入失敗';
    $('#view').innerHTML = `<p class="hint">資料載不到。這一頁要等 <code>scripts/build_cycle.py</code> 跑過一次才有東西。</p>`;
    return;
  }
  bind();
  render();
}

main();
