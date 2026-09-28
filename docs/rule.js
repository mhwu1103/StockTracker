/*
 * 操盤紀律（rule.html）：把《股市大贏家》那幾份操作手冊變成每天打開就知道該做什麼的一頁。
 *
 * 回答的問題：**照規則，今天該做什麼**。不是「會漲到多少」——手冊的第一條就是
 * 不聽任何人對價位與時間的預測，這一頁自己也不做。
 *
 * 由上而下是手冊裡「大贏家飛輪」的順序：
 *
 *   大盤溫控   加權指數跌破 10／20／60 日線 -> 現金至少三成／五成／只留超長線
 *   我的持股   每一檔照自己的門派判：短線看 10 日線、中線看月線、長線看左側買點
 *   進場訊號   短線四條件（外資連買＋多頭排列＋剛站上 10 日線＋業績）與中線突破月線
 *   鐵律       六大鐵律與操作矩陣，放在最後當參考
 *
 * ## 規則寫在這裡，不寫在後端
 *
 * scripts/build_rule.py 只算「每一檔在每一條均線的哪一邊、連續幾天」，
 * 「跌破 10 日線 = 出場」這種判斷全部在這支。規則只有一份，要改門檻也只改這裡。
 *
 * ## 門派不能改（鐵律 6）
 *
 * 持股加進來時就定了門派，之後只能刪、不能改。「聽 A 的策略進場、被套了改聽 B 的
 * 策略不停損」正是手冊說的走火入魔，而一個下拉選單就能讓人這樣做 —— 所以不給。
 * 還沒觸發出場就要刪除的，會多問一句。
 *
 * ## 持股只在這台裝置
 *
 * 這是 GitHub Pages 上的靜態站，沒有後端可以存。持股存在 localStorage，
 * 換一台裝置、清掉網站資料就沒了，頁面上會說清楚。
 */

const DATA = 'data';

// rule.json 每一檔的欄位順序，必須與 scripts/build_rule.py 的 FIELDS 一致
const FIELDS = ['name', 'close', 'chg', 'ma10', 'ma20', 'ma60', 'ma240',
  's10', 's20', 's60', 'bull', 'fo'];
const [S_NAME, S_CLOSE, S_CHG, S_MA10, S_MA20, S_MA60, S_MA240,
  S_S10, S_S20, S_S60, S_BULL, S_FO] = FIELDS.map((_, i) => i);

/*
 * 大盤溫控的四個水位。依據是加權指數收在哪一條線下面，取最嚴重的那一條：
 * 破季線但還在月線上（很少見）也算破季線。
 */
const LEVELS = [
  { title: '全數站上', act: '沒有降溫：照各門派自己的規則操作', cash: 0, tone: 'ok' },
  { title: '跌破 10 日線', act: '資金降溫：現金至少保留 3 成', cash: 30, tone: 'warn' },
  { title: '跌破月線', act: '防禦升級：現金至少保留 5 成', cash: 50, tone: 'warn' },
  { title: '跌破季線', act: '終極防禦：只留超長線 ETF 與超長線股票，其餘清空', cash: null, tone: 'stop' },
];

/*
 * 四個門派（操作矩陣）。極短線／當沖不在這裡——手冊說絕對不要碰，所以也不讓人選。
 */
const SCHOOLS = {
  short: { label: '短線', sub: '動能', target: '轉強族群', hold: '數日～數週',
    entry: '突破 10 日線', exit: '跌破 10 日線', demon: '漲停不嗨、跌停不慌' },
  mid: { label: '中線', sub: '波段', target: '未來爆發產業', hold: '3 個月～1 年',
    entry: '突破月線', exit: '跌破月線', demon: '忍住急著獲利的心' },
  long: { label: '長線', sub: '價值', target: '最大權值股', hold: '數年（跨牛熊）',
    entry: '跌破月／季／年線分批買', exit: '牛市多頭年部分調節', demon: '無視幾個月的漲跌' },
  core: { label: '超長線', sub: '指數', target: '全球／市值型 ETF', hold: '幾十年',
    entry: '定期定額', exit: '急需用錢才賣', demon: '無視市場大循環波動' },
};
const SCHOOL_KEYS = Object.keys(SCHOOLS);

const RULES = [
  ['保護資產優先', '最重要的不是贏錢，是保護資產。虧損 50% 要賺 100% 才回得來。'],
  ['屏蔽主力雜訊', '不聽大戶主力說會到多少「價位」、漲到「幾月」。'],
  ['紀律大於情緒', '停損再痛、少賺再痛，永遠照著買賣規則走。'],
  ['拒絕任何借款', '只用自有資金。房貸、車貸、信貸、質借、融資、槓桿 ETF 都不碰。'],
  ['永遠分批進出', '大忌 All-in／All-out。分批才留得住調配的空間，心態才輕鬆。'],
  ['嚴守門派一致', '用什麼理由進場就用什麼理由出場。短線看 10 日線，長線看年線，絕不混用。'],
];

const SCAN_MODES = [
  { value: 'short', label: '短線' },
  { value: 'mid', label: '中線' },
];

// 掃描結果一次最多畫幾檔。中線「剛站上月線」的日子可以有上百檔，全畫出來就沒人看得完。
const SCAN_LIMIT = 40;

// 大盤圖畫最近幾個交易日
const CHART_DAYS = 120;

const KEYS = {
  pos: 'stocktracker.rule.pos',
  cash: 'stocktracker.rule.cash',
  scan: 'stocktracker.rule.scan',
  themeOnly: 'stocktracker.rule.themeonly',
};

const state = {
  data: null,
  themes: new Map(),      // 代號 -> [族群名]
  pos: [],                // [{ code, school, shares, cost, since }]
  cash: null,             // 現金（元），沒填為 null
  scan: 'short',
  themeOnly: true,
  draft: null,            // 新增表單的預填值 { code, school }
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (v, digits = 2) => (v === null || v === undefined ? '—'
  : Number(v).toLocaleString('zh-TW', { maximumFractionDigits: digits }));
const money = (v) => (v === null || v === undefined ? '—' : Math.round(v).toLocaleString('zh-TW'));
const pct = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const dir = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const gap = (close, line) => (line ? (close / line - 1) * 100 : null);
const isEtf = (code) => code.startsWith('00');

/** 連續天數的說法：「站上 3 天」「跌破 12 天」「站上 60+ 天」 */
function runText(run) {
  if (run === null || run === undefined) return '資料不足';
  const n = Math.abs(run);
  return `${run > 0 ? '站上' : '跌破'} ${n >= 60 ? '60+' : n} 天`;
}

function pills(name, options, current) {
  return `<div class="pills">${options
    .map((o) => `<button class="pill ${o.value === current ? 'active' : ''}" data-${name}="${o.value}">${esc(o.label)}</button>`)
    .join('')}</div>`;
}

// --------------------------------------------------------------------------
// 大盤溫控
// --------------------------------------------------------------------------

/** 第 i 天的 n 日均線；往前湊不滿 n 天就是 null */
function maAt(c, i, n) {
  if (i + 1 < n) return null;
  let sum = 0;
  for (let k = i - n + 1; k <= i; k += 1) sum += c[k];
  return sum / n;
}

/** 由最後一天往回數，收盤連續在 n 日線同一側幾天（正為站上） */
function runAt(c, n) {
  const last = c.length - 1;
  const side = (i) => {
    const m = maAt(c, i, n);
    return m === null ? 0 : c[i] > m ? 1 : -1;
  };
  const s = side(last);
  if (!s) return null;
  let days = 0;
  for (let i = last; i >= 0 && side(i) === s; i -= 1) days += 1;
  return s * days;
}

function taiexState(tx) {
  if (!tx || !tx.c || tx.c.length < 60) return null;
  const c = tx.c;
  const i = c.length - 1;
  const close = c[i];
  const ma = { 10: maAt(c, i, 10), 20: maAt(c, i, 20), 60: maAt(c, i, 60), 240: maAt(c, i, 240) };
  const level = close < ma[60] ? 3 : close < ma[20] ? 2 : close < ma[10] ? 1 : 0;

  // 過去一年（250 個交易日）跌破季線幾次：手冊說一年一兩次是常態，那不是崩盤
  let breaks = 0;
  let span = 0;
  for (let k = Math.max(60, i - 249); k <= i; k += 1) {
    const now = maAt(c, k, 60);
    const before = maAt(c, k - 1, 60);
    span += 1;
    if (before !== null && c[k - 1] >= before && c[k] < now) breaks += 1;
  }

  return {
    date: tx.d[i], close, prev: c[i - 1], ma, level, breaks, span,
    runs: { 10: runAt(c, 10), 20: runAt(c, 20), 60: runAt(c, 60) },
  };
}

/** 加權指數與三條均線的折線圖。SVG 直接畫，這一頁不值得為一張圖載一個圖表庫。 */
function taiexChart(tx) {
  const c = tx.c;
  const from = Math.max(0, c.length - CHART_DAYS);
  const idx = [];
  for (let i = from; i < c.length; i += 1) idx.push(i);
  const series = [
    { key: 'c', label: '加權指數', cls: 'rule-line--c', v: idx.map((i) => c[i]) },
    { key: 10, label: '10 日線', cls: 'rule-line--10', v: idx.map((i) => maAt(c, i, 10)) },
    { key: 20, label: '月線', cls: 'rule-line--20', v: idx.map((i) => maAt(c, i, 20)) },
    { key: 60, label: '季線', cls: 'rule-line--60', v: idx.map((i) => maAt(c, i, 60)) },
  ];
  const all = series.flatMap((s) => s.v).filter((v) => v !== null);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const W = 600;
  const H = 180;
  const pad = 6;
  const x = (k) => pad + (k / Math.max(1, idx.length - 1)) * (W - pad * 2);
  const y = (v) => pad + (1 - (v - lo) / (hi - lo || 1)) * (H - pad * 2);
  const path = (v) => v.map((p, k) => (p === null ? null : `${x(k).toFixed(1)},${y(p).toFixed(1)}`))
    .filter(Boolean).join(' ');

  return `<figure class="rule-chart">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
         aria-label="加權指數最近 ${idx.length} 個交易日與 10 日線、月線、季線">
      ${series.map((s) => `<polyline class="rule-line ${s.cls}" points="${path(s.v)}" />`).join('')}
    </svg>
    <figcaption>
      ${series.map((s) => `<span class="rule-key ${s.cls}">${esc(s.label)}</span>`).join('')}
      <span class="rule-key__range">${esc(tx.d[from])} ～ ${esc(tx.d[c.length - 1])}</span>
    </figcaption>
  </figure>`;
}

function taiexCard(t, tx) {
  if (!t) {
    return `<section class="card"><h2>大盤溫控</h2>
      <p class="hint">還沒有加權指數的資料。要先跑一次 <code>scripts/fetch_taiex.py --months 15</code>。</p></section>`;
  }
  const lv = LEVELS[t.level];
  const ladder = LEVELS.slice(1).map((l, k) => {
    const n = [10, 20, 60][k];
    const broken = t.close < t.ma[n];
    return `<li class="${broken ? 'is-on' : ''}">
      <span class="rule-ladder__line">跌破${n === 10 ? ' 10 日線' : n === 20 ? '月線（20MA）' : '季線（60MA）'}</span>
      <span class="rule-ladder__act">${esc(l.act.split('：')[1])}</span>
      <span class="rule-ladder__now">${fmt(t.ma[n], 0)}・${esc(runText(t.runs[n]))}</span>
    </li>`;
  }).join('');
  const chg = t.prev ? (t.close / t.prev - 1) * 100 : null;
  const year = t.ma[240]
    ? `年線 ${fmt(t.ma[240], 0)}，指數${t.close > t.ma[240] ? '在年線上' : '已跌破年線'}。` : '';

  return `<section class="card">
    <h2>大盤溫控 <small>${esc(t.date)} 收盤</small></h2>
    <div class="rule-level rule-level--${lv.tone}">
      <b>${esc(lv.title)}</b>
      <span>${esc(lv.act)}</span>
    </div>
    <div class="stat-grid">
      <div class="stat"><b>${fmt(t.close, 0)}</b><span>加權指數 <em class="${dir(chg)}">${pct(chg)}</em></span></div>
      <div class="stat"><b>${lv.cash === null ? '只留超長線' : lv.cash ? `≥ ${lv.cash}%` : '不限'}</b><span>現金水位要求</span></div>
      <div class="stat"><b>${t.breaks} 次</b><span>近 ${t.span} 日跌破季線（含來回）</span></div>
    </div>
    <ol class="rule-ladder">${ladder}</ol>
    ${taiexChart(state.data.taiex)}
    <p class="note">${year}一年跌破季線一兩次是常態，四五年一次的熊市大崩盤是財富重分配的機會 ——
      該砍就砍、保留實力，不凹單。個股不管大盤怎麼走，跌破自己門派的出場線就走。</p>
  </section>`;
}

// --------------------------------------------------------------------------
// 我的持股
// --------------------------------------------------------------------------

/**
 * 一檔持股照它的門派判。回傳 { tone, say, detail }：
 *   tone  exit 該出場／buy 左側買點／hold 續抱／na 判不了
 */
function judge(p, row, level) {
  if (!row) {
    return { tone: 'na', say: '沒有今天的收盤價', detail: '停牌、下市，或是代號打錯了' };
  }
  const close = row[S_CLOSE];

  // 溫控壓過門派：大盤破季線時只留超長線
  if (level === 3 && p.school !== 'core') {
    return { tone: 'exit', say: '大盤跌破季線：清空',
      detail: p.school === 'long'
        ? '溫控只留超長線。長線的左側加碼要等大盤回到季線上再說——先保命'
        : '溫控只留超長線 ETF 與超長線股票，其餘部位全數清空' };
  }

  if (p.school === 'short' || p.school === 'mid') {
    const short = p.school === 'short';
    const line = row[short ? S_MA10 : S_MA20];
    // 接在中文字後面，數字前要空一格：「跌破 10 日線」「跌破月線」
    const name = short ? ' 10 日線' : '月線';
    if (line === null) return { tone: 'na', say: `${name}資料不足`, detail: '上市不久，或最近停牌過' };
    const g = gap(close, line);
    if (close < line) {
      return { tone: 'exit', say: `跌破${name}：無條件出場`,
        detail: `收 ${fmt(close)}，${name.trim()} ${fmt(line)}（${pct(g)}）。猶豫只會讓虧損放大三到五倍` };
    }
    return { tone: 'hold', say: `站在${name}上：續抱`,
      detail: `距${name} ${pct(g)}，收盤跌破 ${fmt(line)} 就出場。${SCHOOLS[p.school].demon}` };
  }

  if (p.school === 'long') {
    const zones = [
      [S_MA240, '年線', '跌破年線：大量買入（大打折）', '需要一年轉強'],
      [S_MA60, '季線', '跌破季線：多買一點', '需要一季轉強'],
      [S_MA20, '月線', '跌破月線：小買一點', '需要一個月轉強'],
    ];
    for (const [i, line, say, why] of zones) {
      if (row[i] !== null && close < row[i]) {
        return { tone: 'buy', say, detail: `收 ${fmt(close)}，${line} ${fmt(row[i])}（${pct(gap(close, row[i]))}），${why}。分批，不要一次買完` };
      }
    }
    const noYear = row[S_MA240] === null ? '（年線資料不足，只看得到月線與季線）' : '';
    return { tone: 'hold', say: '無感持有', detail: `不管幾天、幾週、幾個月的漲跌。3–5 年一次的大循環，牛市大賺後再部分調節${noYear}` };
  }

  return { tone: 'hold', say: '定期定額', detail: '跟著世界經濟成長放幾十年，只有生活急需用錢才賣' };
}

function positionRow(p, k, level) {
  const row = state.data.stocks[p.code];
  const j = judge(p, row, level);
  const s = SCHOOLS[p.school];
  const value = row && p.shares ? row[S_CLOSE] * p.shares : null;
  const pnl = row && p.cost ? gap(row[S_CLOSE], p.cost) : null;
  return `<div class="row rule-pos rule-pos--${j.tone}">
    <span class="rule-school">${esc(s.label)}</span>
    <span class="ident">
      <span class="name">${esc(row ? row[S_NAME] : p.code)}</span>
      <span class="code">${esc(p.code)}${p.since ? `・${esc(p.since)} 進` : ''}</span>
      <span class="rule-say">${esc(j.say)}</span>
      <span class="rule-detail">${esc(j.detail)}</span>
    </span>
    <span class="figures">
      <span class="value">${row ? fmt(row[S_CLOSE]) : '—'}</span>
      <span class="price ${row ? dir(row[S_CHG]) : ''}">${row ? pct(row[S_CHG]) : ''}</span>
      ${pnl !== null ? `<span class="price ${dir(pnl)}">損益 ${pct(pnl)}</span>` : ''}
      ${value !== null ? `<span class="price">${money(value)} 元</span>` : ''}
      <button class="linky rule-del" data-del="${k}">${j.tone === 'exit' ? '已出場' : '刪除'}</button>
    </span>
  </div>`;
}

/** 現金水位：有填股數與現金時才算得出來 */
function cashCheck(level) {
  const lv = LEVELS[level];
  const rows = state.pos.map((p) => ({ p, row: state.data.stocks[p.code] }));
  const valued = rows.filter(({ p, row }) => row && p.shares);
  if (state.cash === null || !valued.length) {
    return '<p class="note">填了每一檔的股數與手上的現金，這裡才算得出現金水位合不合溫控的要求。</p>';
  }
  const stock = valued.reduce((sum, { p, row }) => sum + p.shares * row[S_CLOSE], 0);
  const total = stock + state.cash;
  const cashPct = total ? (state.cash / total) * 100 : 0;
  const missing = rows.length - valued.length;
  const partial = missing ? `（有 ${missing} 檔沒填股數，沒算進去）` : '';

  let verdict;
  if (lv.cash === null) {
    const rest = valued.filter(({ p }) => p.school !== 'core')
      .reduce((sum, { p, row }) => sum + p.shares * row[S_CLOSE], 0);
    verdict = rest > 0
      ? `<b class="rule-bad">還有 ${money(rest)} 元不是超長線部位，要清空</b>`
      : '<b class="rule-good">只剩超長線部位，符合終極防禦</b>';
  } else if (lv.cash && cashPct < lv.cash) {
    const need = (lv.cash / 100) * total - state.cash;
    verdict = `<b class="rule-bad">低於 ${lv.cash}%：還要賣出約 ${money(need)} 元</b>`;
  } else {
    verdict = `<b class="rule-good">${lv.cash ? `符合 ≥ ${lv.cash}% 的要求` : '大盤沒有降溫要求'}</b>`;
  }
  const allIn = state.cash === 0
    ? '<p class="note rule-bad">現金是零：這就是 All-in。分批才留得住調配的空間（鐵律 5）。</p>' : '';

  return `<p class="lede">現金 <em>${money(state.cash)}</em> 元、股票 <em>${money(stock)}</em> 元，現金水位 <em>${cashPct.toFixed(1)}%</em>${partial}。${verdict}</p>${allIn}`;
}

function addForm() {
  const d = state.draft || {};
  const row = d.code ? state.data.stocks[d.code] : null;
  const preview = d.code
    ? (row ? `${esc(row[S_NAME])}　收 ${fmt(row[S_CLOSE])}` : '<span class="rule-bad">找不到這個代號</span>') : '';
  return `<form class="rule-form" id="add-form" autocomplete="off">
    <div class="rule-form__row">
      <label>代號<input name="code" inputmode="text" maxlength="8" required value="${esc(d.code || '')}" placeholder="2330"></label>
      <label>門派<select name="school">${SCHOOL_KEYS.map((k) => `<option value="${k}" ${k === (d.school || 'short') ? 'selected' : ''}>${esc(SCHOOLS[k].label)}（${esc(SCHOOLS[k].exit)}）</option>`).join('')}</select></label>
    </div>
    <div class="rule-form__row">
      <label>股數<input name="shares" type="number" min="0" step="1" inputmode="numeric" placeholder="選填"></label>
      <label>成本<input name="cost" type="number" min="0" step="0.01" inputmode="decimal" placeholder="選填"></label>
    </div>
    <p class="rule-form__preview" id="add-preview">${preview}</p>
    <fieldset class="rule-oath">
      <legend>進場前先答應自己三件事</legend>
      <label><input type="checkbox" name="oath"> 這筆是自有資金，沒有借錢、沒有融資（鐵律 4）</label>
      <label><input type="checkbox" name="oath"> 這不是全部的錢，是分批的其中一批（鐵律 5）</label>
      <label><input type="checkbox" name="oath"> 出場時照同一個門派的出場線，不換理由（鐵律 6）</label>
    </fieldset>
    <button type="submit" class="pill active" id="add-go" disabled>加入持股</button>
  </form>`;
}

function positionsCard(level) {
  const judged = state.pos.map((p) => judge(p, state.data.stocks[p.code], level));
  const exits = judged.filter((j) => j.tone === 'exit').length;
  const buys = judged.filter((j) => j.tone === 'buy').length;

  const head = !state.pos.length
    ? '<p class="lede">還沒有持股。把手上的部位加進來，每天打開這一頁就知道哪幾檔該走。</p>'
    : `<p class="lede">${state.pos.length} 檔持股：${exits
      ? `<b class="rule-bad">${exits} 檔觸發出場 —— 該砍就砍，猶豫是禁忌</b>`
      : '<b class="rule-good">沒有任何一檔觸發出場</b>'}${buys ? `，${buys} 檔長線落在左側買點` : ''}。</p>`;

  // 觸發出場的排最上面，其次是左側買點
  const order = { exit: 0, buy: 1, na: 2, hold: 3 };
  const rows = state.pos.map((p, k) => ({ p, k, t: judged[k].tone }))
    .sort((a, b) => order[a.t] - order[b.t])
    .map(({ p, k }) => positionRow(p, k, level)).join('');

  return `<section class="card">
    <h2>我的持股 <small>每一檔照自己的門派判</small></h2>
    ${head}
    ${rows}
    ${cashCheck(level)}
    <div class="rule-cash">
      <label>手上現金（元）<input id="cash" type="number" min="0" step="1" inputmode="numeric"
        value="${state.cash === null ? '' : state.cash}" placeholder="選填"></label>
    </div>
    <details class="rule-add" ${state.draft ? 'open' : ''}>
      <summary>＋ 新增持股</summary>
      ${addForm()}
    </details>
    <p class="note">門派加進來就不能改，只能刪 —— 「聽 A 的進場、聽 B 的出場」是手冊裡最大的禁忌。
      持股只存在這台裝置的瀏覽器裡，換裝置或清除網站資料就會不見。</p>
  </section>`;
}

// --------------------------------------------------------------------------
// 進場訊號
// --------------------------------------------------------------------------

function scanRows() {
  const out = [];
  for (const [code, r] of Object.entries(state.data.stocks)) {
    if (isEtf(code)) continue;
    out.push([code, r]);
  }
  return out;
}

/** 短線的四個條件，逐層過濾，每一層剩幾檔都要看得到 */
function shortScan() {
  const all = scanRows();
  const bull = all.filter(([, r]) => r[S_BULL] === 1);
  const fresh = bull.filter(([, r]) => r[S_S10] === 1 || r[S_S10] === 2);
  const chips = fresh.filter(([, r]) => r[S_FO] !== null && r[S_FO] >= 3);
  chips.sort((a, b) => b[1][S_FO] - a[1][S_FO] || b[1][S_CHG] - a[1][S_CHG]);
  return {
    steps: [['上市櫃普通股', all.length], ['均線多頭排列', bull.length],
      ['剛站上 10 日線 1–2 天', fresh.length], ['外資連買 3 天以上', chips.length]],
    list: chips,
  };
}

function midScan() {
  const all = scanRows();
  const fresh = all.filter(([, r]) => r[S_S20] === 1 || r[S_S20] === 2);
  const themed = fresh.filter(([code]) => state.themes.has(code));
  const list = (state.themeOnly ? themed : fresh).slice();
  list.sort((a, b) => b[1][S_CHG] - a[1][S_CHG]);
  return {
    steps: [['上市櫃普通股', all.length], ['剛站上月線 1–2 天', fresh.length],
      ['其中在題材族群裡', themed.length]],
    list,
  };
}

function scanRow(code, r, mode) {
  const themes = state.themes.get(code) || [];
  const tags = mode === 'short'
    ? [`外資連買 ${r[S_FO]} 天`, `站上 10 日線第 ${r[S_S10]} 天`, '多頭排列']
    : [`站上月線第 ${r[S_S20]} 天`, `季線 ${runText(r[S_S60])}`];
  return `<div class="row rule-scan">
    <span class="ident">
      <span class="name">${esc(r[S_NAME])}</span>
      <span class="code">${esc(code)}</span>
      <span class="chips">${tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}${themes.slice(0, 3)
        .map((t) => `<span class="chip accent">${esc(t)}</span>`).join('')}</span>
    </span>
    <span class="figures">
      <span class="value">${fmt(r[S_CLOSE])}</span>
      <span class="price ${dir(r[S_CHG])}">${pct(r[S_CHG])}</span>
      <button class="linky" data-adopt="${esc(code)}" data-school="${mode}">加入持股</button>
    </span>
  </div>`;
}

function scanCard(level) {
  const mode = state.scan;
  const res = mode === 'short' ? shortScan() : midScan();
  const funnel = `<ol class="funnel rule-funnel">${res.steps
    .map(([label, n]) => `<li><span>${esc(label)}</span><b>${n}</b></li>`).join('')}</ol>`;
  const shown = res.list.slice(0, SCAN_LIMIT);
  const more = res.list.length > shown.length
    ? `<p class="note">還有 ${res.list.length - shown.length} 檔沒列出來。</p>` : '';
  const cold = level >= 2
    ? `<p class="lede rule-bad">大盤${LEVELS[level].title}：${esc(LEVELS[level].act)}。訊號照樣列，但新倉要先過現金水位那一關。</p>`
    : '';
  const foNote = state.data.foDate
    ? '' : '<p class="note rule-bad">法人資料跟收盤價不是同一天，外資連買這一層今天是空的。</p>';

  const note = mode === 'short'
    ? `短線四條件：外資連買、均線多頭排列、向上突破 10 日線，再加上<b>未來業績上升</b> ——
       最後這一項這裡沒有資料，EPS、營收、毛利率要自己查過。只做族群發動轉強的第一、二天；
       進場後跌破 10 日線，即刻無條件出場。`
    : `中線的標的是未來半年有突破性進展的產業族群，持有 3 個月到 1 年：站上月線進、跌破月線出，
       沒跌破就不賣。「題材族群」是站上手動維護的族群清單（themes.json），族群本身值不值得做要自己判斷。`;

  return `<section class="card">
    <h2>進場訊號 <small>${esc(state.data.date)} 收盤</small></h2>
    <div class="controls rule-controls">
      ${pills('scan', SCAN_MODES, mode)}
      ${mode === 'mid' ? `<label class="rule-toggle"><input type="checkbox" id="theme-only" ${state.themeOnly ? 'checked' : ''}> 只看題材族群</label>` : ''}
    </div>
    ${cold}
    ${funnel}
    ${shown.length ? shown.map(([code, r]) => scanRow(code, r, mode)).join('') : '<p class="hint">今天沒有符合全部條件的股票。沒有訊號就不進場，也是紀律。</p>'}
    ${more}
    ${foNote}
    <p class="note">${note}</p>
  </section>`;
}

// --------------------------------------------------------------------------
// 鐵律與操作矩陣
// --------------------------------------------------------------------------

function rulesCard() {
  const rules = RULES.map(([title, body], k) => `<li><b>鐵律 ${k + 1}｜${esc(title)}</b><span>${esc(body)}</span></li>`).join('');
  const rowsOf = [['適用標的', 'target'], ['持有時間', 'hold'], ['進場指標', 'entry'], ['出場指標', 'exit'], ['克服心魔', 'demon']];
  const matrix = `<div class="tbl-wrap"><table class="tbl rule-matrix">
    <thead><tr><th></th>${SCHOOL_KEYS.map((k) => `<th>${esc(SCHOOLS[k].label)}<br><small>${esc(SCHOOLS[k].sub)}</small></th>`).join('')}</tr></thead>
    <tbody>${rowsOf.map(([label, key]) => `<tr><th>${esc(label)}</th>${SCHOOL_KEYS.map((k) => `<td>${esc(SCHOOLS[k][key])}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;

  return `<section class="card">
    <h2>六大鐵律與操作矩陣</h2>
    <ol class="rule-rules">${rules}</ol>
    <details class="rule-more">
      <summary>操作矩陣：四個門派各看哪一條線</summary>
      ${matrix}
      <p class="note">操作越長線，勝率越高。<b>極短線／當沖：絕對不要碰</b> —— 只有極少數超級高手會贏，
        這是資金消耗率最高的戰場，所以這一頁的門派裡沒有它。</p>
    </details>
    <details class="rule-more">
      <summary>決策漏斗：訊號的優先順序</summary>
      <ol class="rule-rules">
        <li><b>1｜籌碼面</b><span>資金的真實足跡，位階最高：法人連買賣超、爆量與量縮、期貨空單、鉅額交易。</span></li>
        <li><b>2｜技術面</b><span>趨勢的視覺化證據：K 棒、均線多頭排列與交叉、均線上下彎、扣抵值、MACD／KD。</span></li>
        <li><b>3｜產業基本面</b><span>趨勢延續的底氣：EPS、本益比、營收、毛利率、接單搶單、新族群新題材。</span></li>
        <li><b>4｜消息面</b><span>只用來驗證情緒，絕不能當單一進場依據：法人目標價、主力喊價、小道消息。</span></li>
      </ol>
      <p class="note">前三項都達到轉強 → 果斷進場；籌碼或技術任一出現轉弱 → 馬上賣出。</p>
    </details>
  </section>`;
}

// --------------------------------------------------------------------------
// 畫面與事件
// --------------------------------------------------------------------------

function render() {
  const t = taiexState(state.data.taiex);
  const level = t ? t.level : 0;
  $('#meta').textContent = `個股 ${state.data.date} 收盤・${t ? `加權指數 ${t.date}` : '沒有加權指數'}`;
  const openAdd = $('.rule-add')?.open;
  $('#view').innerHTML = [
    taiexCard(t, state.data.taiex),
    positionsCard(level),
    scanCard(level),
    rulesCard(),
  ].join('');
  if (openAdd && !state.draft) $('.rule-add').open = true;
}

function savePos() {
  save(KEYS.pos, JSON.stringify(state.pos));
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function bind() {
  const view = $('#view');

  view.addEventListener('click', (e) => {
    const scan = e.target.closest('[data-scan]');
    if (scan) {
      state.scan = scan.dataset.scan;
      save(KEYS.scan, state.scan);
      render();
      return;
    }

    const adopt = e.target.closest('[data-adopt]');
    if (adopt) {
      state.draft = { code: adopt.dataset.adopt, school: adopt.dataset.school };
      render();
      state.draft = null;
      $('.rule-add')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    const del = e.target.closest('[data-del]');
    if (del) {
      const k = Number(del.dataset.del);
      const p = state.pos[k];
      if (!p) return;
      const t = taiexState(state.data.taiex);
      const j = judge(p, state.data.stocks[p.code], t ? t.level : 0);
      // 規則還沒叫你走就要走：多問一句。這是「急著獲利出場」與「換理由出場」會發生的地方
      if ((p.school === 'short' || p.school === 'mid') && j.tone === 'hold'
        && !window.confirm(`${p.code} 還站在${p.school === 'short' ? ' 10 日線' : '月線'}上，規則沒有叫你出場。\n急著獲利出場是${SCHOOLS[p.school].label}最大的心魔，確定要刪除？`)) {
        return;
      }
      state.pos.splice(k, 1);
      savePos();
      render();
    }
  });

  view.addEventListener('change', (e) => {
    if (e.target.id === 'cash') {
      const v = e.target.value.trim();
      state.cash = v === '' ? null : Math.max(0, Number(v));
      save(KEYS.cash, state.cash === null ? '' : String(state.cash));
      render();
      return;
    }
    if (e.target.id === 'theme-only') {
      state.themeOnly = e.target.checked;
      save(KEYS.themeOnly, state.themeOnly ? '1' : '0');
      render();
    }
  });

  // 表單：三個勾都打了才能送出；代號打完就預覽名稱
  view.addEventListener('input', (e) => {
    const form = e.target.closest('#add-form');
    if (!form) return;
    const oaths = [...form.querySelectorAll('[name="oath"]')];
    $('#add-go').disabled = !oaths.every((o) => o.checked);
    if (e.target.name === 'code') {
      const code = e.target.value.trim().toUpperCase();
      const row = state.data.stocks[code];
      $('#add-preview').innerHTML = !code ? ''
        : row ? `${esc(row[S_NAME])}　收 ${fmt(row[S_CLOSE])}` : '<span class="rule-bad">找不到這個代號</span>';
    }
  });

  view.addEventListener('submit', (e) => {
    if (e.target.id !== 'add-form') return;
    e.preventDefault();
    const f = new FormData(e.target);
    const code = String(f.get('code') || '').trim().toUpperCase();
    if (!state.data.stocks[code]) {
      $('#add-preview').innerHTML = '<span class="rule-bad">找不到這個代號，沒有加進去</span>';
      return;
    }
    const num = (v) => (v === '' || v === null ? null : Math.max(0, Number(v)) || null);
    state.pos.push({
      code,
      school: SCHOOL_KEYS.includes(f.get('school')) ? f.get('school') : 'short',
      shares: num(f.get('shares')),
      cost: num(f.get('cost')),
      since: today(),
    });
    savePos();
    render();
  });
}

function save(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    /* 記不住就算了：這次開著的畫面照樣能用 */
  }
}

function restore() {
  try {
    const pos = JSON.parse(localStorage.getItem(KEYS.pos) || '[]');
    if (Array.isArray(pos)) {
      state.pos = pos.filter((p) => p && typeof p.code === 'string' && SCHOOL_KEYS.includes(p.school));
    }
    const cash = localStorage.getItem(KEYS.cash);
    if (cash !== null && cash !== '' && Number.isFinite(Number(cash))) state.cash = Number(cash);
    const scan = localStorage.getItem(KEYS.scan);
    if (SCAN_MODES.some((m) => m.value === scan)) state.scan = scan;
    const themeOnly = localStorage.getItem(KEYS.themeOnly);
    if (themeOnly !== null) state.themeOnly = themeOnly === '1';
  } catch (err) {
    /* 讀不到就用預設 */
  }
}

async function main() {
  restore();
  try {
    const [data, themes] = await Promise.all([
      fetch(`${DATA}/rule.json`, { cache: 'reload' }).then((r) => {
        if (!r.ok) throw new Error(`rule.json ${r.status}`);
        return r.json();
      }),
      // 族群只是掃描結果旁邊的標籤，載不到不影響判斷
      fetch(`${DATA}/themes.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if ((data.fields || []).join() !== FIELDS.join()) {
      throw new Error(`rule.json 的欄位對不上：${(data.fields || []).join()}`);
    }
    state.data = data;
    // 族群是兩層（AI 伺服器 → 系統組裝／ODM），標籤用子族群：比大類更說得出它在做什麼
    for (const g of (themes && themes.groups) || []) {
      for (const sub of g.subs || []) {
        for (const code of sub.codes || []) {
          if (!state.themes.has(code)) state.themes.set(code, []);
          const names = state.themes.get(code);
          if (!names.includes(sub.name)) names.push(sub.name);
        }
      }
    }
  } catch (err) {
    console.error(err);
    $('#meta').textContent = '載入失敗';
    $('#view').innerHTML = `<p class="hint">資料載不到。這一頁要等
      <code>scripts/fetch_taiex.py</code> 與 <code>scripts/build_rule.py</code> 跑過一次才有東西。</p>`;
    return;
  }
  bind();
  render();
}

main();
