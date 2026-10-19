/*
 * 期貨（futures.html）：台指期與台指選擇權的籌碼，一張卡一個指標。
 *
 *   關卡     加權指數，疊上選擇權未平倉最大的買權、賣權履約價
 *   外資     約當大台淨部位（大台 ＋ 小台 ÷ 4）、近 20 日變化在近一年的位置
 *   選擇權   外資買權淨金額 − 賣權淨金額
 *   成本     外資這批部位的估算平均成本與損益
 *   散戶     小台散戶多空比
 *   大額     前十大特定法人的淨部位
 *   P/C      賣權÷買權未平倉
 *   基差     台指期近月 − 加權指數
 *
 * 每張卡都標回測怎麼說（build_futures.py 的 VERDICT，出處 BACKTEST.md「期貨籌碼的七個指標」）：
 * 沒有預測力的照樣列，但明講它只是盤面，不是訊號。算式在 scripts/futures.py，這裡只畫。
 */

const DATA = 'data';
const state = { data: null };

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (v, digits = 0) => (v === null || v === undefined ? '—'
  : Number(v).toLocaleString('zh-TW', { maximumFractionDigits: digits, minimumFractionDigits: digits }));
const signed = (v, digits = 0) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${fmt(v, digits)}`);
const dir = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const md = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '');

/**
 * 折線圖：同一條時間軸（data.d）上的幾條線。zero 時畫零軸。每個交易日一塊透明 rect 帶 <title>，滑過去看數字。
 * 單位不同的東西不擠在同一張（一張圖一個 y 軸），要對照就上下兩張對齊。
 */
function lineChart(lines, { zero = false, height = 130, label = '', unit = '' } = {}) {
  const d = state.data.d;
  const W = 600;
  const H = height + 10;
  const pad = 5;
  const all = lines.flatMap((l) => l.data).filter((v) => v !== null && v !== undefined);
  if (!all.length) return '<p class="hint">還沒有資料。</p>';
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const n = d.length;
  const x = (k) => pad + (k / Math.max(1, n - 1)) * (W - pad * 2);
  const y = (v) => pad + (1 - (v - lo) / (hi - lo || 1)) * (H - pad * 2);
  const path = (data) => {
    const segs = [];
    let cur = [];
    data.forEach((v, k) => {
      if (v === null || v === undefined) { if (cur.length) segs.push(cur); cur = []; return; }
      cur.push(`${x(k).toFixed(1)},${y(v).toFixed(1)}`);
    });
    if (cur.length) segs.push(cur);
    return segs;
  };
  const polys = lines.map((l) => path(l.data).map((sg) => `<polyline class="fut-line ${l.cls}" points="${sg.join(' ')}"/>`).join('')).join('');
  const ticks = [];
  let lastM = '';
  d.forEach((day, k) => {
    const m = day.slice(0, 7);
    if (m === lastM) return;
    lastM = m;
    if (Number(day.slice(5, 7)) % 2 === 1) ticks.push(`<span style="left:${(x(k) / W) * 100}%">${day.slice(2, 4)}/${Number(day.slice(5, 7))}</span>`);
  });
  const hits = d.map((day, k) => `<rect x="${(x(k) - W / n / 2).toFixed(1)}" y="0" width="${(W / n).toFixed(2)}" height="${H}"><title>${day}${
    lines.map((l) => `　${l.label} ${l.data[k] === null || l.data[k] === undefined ? '—' : fmt(l.data[k], l.digits || 0)}${unit}`).join('')}</title></rect>`).join('');
  return `<figure class="cyc-chart fut-chart">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}" style="height:${height}px">
      ${zero ? `<line class="cyc-chart__zero" x1="0" x2="${W}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>` : ''}
      ${polys}<g class="fut-hit">${hits}</g>
    </svg>
    <div class="cyc-chart__years">${ticks.join('')}</div>
    <div class="cyc-chart__range">上 ${fmt(hi, lines[0].digits || 0)}　下 ${fmt(lo, lines[0].digits || 0)}</div>
  </figure>
  ${lines.length > 1 ? `<p class="gy-keys">${lines.map((l) => `<span class="cyc-key fut-key ${l.cls}">${esc(l.label)}</span>`).join('')}</p>` : ''}`;
}

function verdict(v) {
  if (v.ok === null || v.ok === undefined) return '';
  return `<p class="fut-verdict ${v.ok ? 'is-ok' : 'is-no'}"><b>${v.ok ? '回測：有預測力' : '回測：沒有預測力'}</b>
    <span>${esc(v.say)}</span></p>`;
}

const rankText = (rank) => (rank === null || rank === undefined ? '' : `近一年第 ${rank}%`);

function stat(value, label, cls = '') {
  return `<div class="stat"><b class="${cls}">${value}</b><span>${label}</span></div>`;
}

// --------------------------------------------------------------------------
function wallCard(D) {
  const w = D.wall;
  return `<section class="card">
    <h2>關卡 <small>選擇權最近月契約未平倉最大的履約價</small></h2>
    <div class="stat-grid">
      ${stat(fmt(w.close), `${md(D.asof)} 加權指數`)}
      ${stat(fmt(w.cw), `買權關卡（${fmt(w.cwo)} 口）· 上方 ${fmt(((w.cw - w.close) / w.close) * 100, 1)}%`)}
      ${stat(fmt(w.pw), `賣權關卡（${fmt(w.pwo)} 口）· 下方 ${fmt(((w.close - w.pw) / w.close) * 100, 1)}%`)}
    </div>
    ${lineChart([
      { data: D.index, cls: 'fut-line--main', label: '加權指數' },
      { data: w.cwSeries, cls: 'fut-line--up', label: '買權關卡' },
      { data: w.pwSeries, cls: 'fut-line--down', label: '賣權關卡' },
    ], { label: '加權指數與選擇權關卡', height: 160 })}
    <p class="note">買權未平倉最大的那個履約價常被說成「壓力」、賣權的是「支撐」：賣方（多半是法人、造市商）押的是指數不會過去。
      只看月契約——週選的未平倉小、天天換。</p>
    ${verdict(w)}
  </section>`;
}

function netCard(D) {
  const n = D.net;
  return `<section class="card">
    <h2>外資淨部位 <small>約當大台＝大台 ＋ 小台 ÷ 4 · 口</small></h2>
    <div class="stat-grid">
      ${stat(signed(n.now), `${n.now < 0 ? '淨空' : '淨多'} · ${rankText(n.rank)}`, dir(n.now))}
      ${stat(signed(n.chg20), `近 20 日變化 · 近一年第 ${n.fastRank ?? '—'}%`, dir(n.chg20))}
      ${stat(signed(n.chg5), '近 5 日變化', dir(n.chg5))}
      ${stat(`${signed(n.tr)} / ${signed(n.de)}`, '投信 / 自營（大台）')}
    </div>
    ${n.fast ? `<p class="rule-level rule-level--warn"><b>外資空單一個月加得特別快</b>
      <span>近 20 日變化落在近一年最快的 ${D.rules.fast}%。回測（2019 起）這種日子之後 5 天大盤平均約 0%，其他日子 +0.6%——短線別追高。
      放進策略當多空開關則比 120 日線差，所以只是提醒。</span></p>` : ''}
    ${lineChart([{ data: n.series, cls: 'fut-line--main', label: '外資淨部位' }], { zero: true, label: '外資淨部位', unit: ' 口' })}
    <p class="note">外資長年淨空，有一大塊是幫手上的現股避險，所以水位本身不代表看空；要看的是<b>變化</b>：空單在短時間內加很多才是訊號。</p>
    ${verdict(n)}
  </section>`;
}

function foptCard(D) {
  const x = D.fopt;
  return `<section class="card">
    <h2>外資選擇權 <small>買權淨金額 − 賣權淨金額 · 億元</small></h2>
    <div class="stat-grid">
      ${stat(signed(x.now, 1), `${x.now >= 0 ? '偏多' : '偏空'} · ${rankText(x.rank)}`, dir(x.now))}
      ${stat(`${signed(x.cv, 1)} / ${signed(x.pv, 1)}`, '買權 / 賣權淨金額（億）')}
      ${stat(`${signed(x.cq)} / ${signed(x.pq)}`, '買權 / 賣權淨口數')}
      ${stat(signed(x.chg5, 1), '近 5 日變化（億）', dir(x.chg5))}
    </div>
    ${x.bear ? `<p class="rule-level rule-level--warn"><b>外資選擇權偏空到近一年最低的 20%</b>
      <span>回測：這種日子之後 5 天大盤平均 −0.2%、不到一半的日子上漲，其他日子 +0.7%。短線小心。</span></p>` : ''}
    ${lineChart([{ data: x.series, cls: 'fut-line--main', label: '外資選擇權多空淨額', digits: 1 }], { zero: true, label: '外資選擇權多空淨額', unit: ' 億' })}
    <p class="note">買買權、賣賣權都是看多，所以「買權淨金額 − 賣權淨金額」越大越偏多。用金額不用口數：價外的選擇權很便宜，
      一口深價外跟一口價平的份量差很多。</p>
    ${verdict(x)}
  </section>`;
}

function pnlCard(D) {
  const p = D.pnl;
  return `<section class="card">
    <h2>外資期貨成本 <small>估算 · 損益單位億元</small></h2>
    <div class="stat-grid">
      ${stat(fmt(p.cost), '估算平均成本（點）')}
      ${stat(fmt(p.price), `${md(D.asof)} 近月結算`)}
      ${stat(signed(p.now, 1), `估算未實現損益（億）· ${rankText(p.rank)}`, dir(p.now))}
    </div>
    ${lineChart([{ data: p.series, cls: 'fut-line--main', label: '估算損益', digits: 1 }], { zero: true, label: '外資期貨估算損益', unit: ' 億' })}
    <p class="note">算法跟持股的平均成本一樣：淨部位同方向加碼時用當天結算價加權平均、減碼時成本不變、翻空翻多時重設。
      <b>這是估算</b>：不知道真正的成交價，也分不出哪些是避險。空單成本在指數之下＝外資空單在賠，常被說成「回補壓力」。</p>
    ${verdict(p)}
  </section>`;
}

function retailCard(D) {
  const x = D.retail;
  return `<section class="card">
    <h2>散戶多空比 <small>小台 · %</small></h2>
    <div class="stat-grid">
      ${stat(`${signed(x.now, 1)}%`, `${x.now > 0 ? '散戶偏多' : '散戶偏空'} · ${rankText(x.rank)}`, dir(x.now))}
      ${stat(`${signed(x.chg5, 1)}`, '近 5 日變化（百分點）', dir(x.chg5))}
      ${stat(fmt(x.oi), '小台全部未平倉（口）')}
    </div>
    ${x.hot ? `<p class="rule-level rule-level--warn"><b>散戶偏多到近一年的前 ${D.rules.hot}%</b>
      <span>回測：這種日子之後 5 天，大盤比散戶最偏空的時候平均少 0.5～1.0 個百分點，2020～2026 每一年都是。短線小心。</span></p>` : ''}
    ${lineChart([{ data: x.series, cls: 'fut-line--main', label: '散戶多空比', digits: 1 }], { zero: true, label: '散戶多空比', unit: '%' })}
    <p class="note">小台的參與者扣掉三大法人，剩下的幾乎是散戶：−（小台三大法人淨口數）÷ 小台全部未平倉。
      市場上常當反向指標用——散戶越偏多越要小心。</p>
    ${verdict(x)}
  </section>`;
}

function largeCard(D) {
  const x = D.large;
  return `<section class="card">
    <h2>大額交易人 <small>前十大特定法人淨部位 ÷ 全市場未沖銷 · %</small></h2>
    <div class="stat-grid">
      ${stat(`${signed(x.now, 1)}%`, rankText(x.rank), dir(x.now))}
      ${stat(`${fmt(x.b10)} / ${fmt(x.s10)}`, '買方 / 賣方（口）')}
      ${stat(signed(x.chg5, 1), '近 5 日變化（百分點）', dir(x.chg5))}
    </div>
    ${lineChart([{ data: x.series, cls: 'fut-line--main', label: '特定法人淨部位', digits: 1 }], { zero: true, label: '大額交易人淨部位', unit: '%' })}
    <p class="note">期交所每天公布臺股期貨（大台＋小台÷4＋微台÷20）部位最大的前十名交易人，其中屬於「特定法人」的另外列。
      比三大法人更集中：就是那幾家最大的。</p>
    ${verdict(x)}
  </section>`;
}

function pcCard(D) {
  const x = D.pc;
  return `<section class="card">
    <h2>P/C 比 <small>賣權未平倉 ÷ 買權未平倉 · %</small></h2>
    <div class="stat-grid">
      ${stat(`${fmt(x.now, 1)}%`, rankText(x.rank))}
      ${stat(`${fmt(x.pcv, 1)}%`, '成交量的 P/C')}
      ${stat(signed(x.chg5, 1), '近 5 日變化（百分點）', dir(x.chg5))}
    </div>
    ${lineChart([{ data: x.series, cls: 'fut-line--main', label: 'P/C 未平倉比', digits: 1 }], { label: 'P/C 比', unit: '%' })}
    <p class="note">賣權多＝避險多或看空的人多。市場上兩種讀法都有（「避險多所以底部近」與「看空的人多」），所以要看回測。</p>
    ${verdict(x)}
  </section>`;
}

function basisCard(D) {
  const x = D.basis;
  return `<section class="card">
    <h2>基差 <small>台指期近月 − 加權指數 · 點</small></h2>
    <div class="stat-grid">
      ${stat(signed(x.now), `${x.now >= 0 ? '正價差' : '逆價差'}（${signed(x.pct, 2)}%）`, dir(x.now))}
      ${stat(fmt(x.fut), '台指期近月收盤')}
      ${stat(rankText(x.rank) || '—', '在近一年的位置')}
    </div>
    ${lineChart([{ data: x.series, cls: 'fut-line--main', label: '基差' }], { zero: true, label: '基差', unit: ' 點' })}
    <p class="note">期貨比現貨貴是正價差。7～8 月除息旺季，期貨價格要扣掉到期前的股息，會被壓成逆價差——那不是看空。
      期貨 13:45 收、現貨 13:30 收，差的那 15 分鐘也會算進來。</p>
    ${verdict(x)}
  </section>`;
}

// --------------------------------------------------------------------------
function render() {
  const D = state.data;
  $('#meta').textContent = `資料 ${D.asof} · 外資約當大台 ${signed(D.net.now)} 口${D.net.fast ? ' · ⚠ 外資空單加速' : ''}${D.retail.hot ? ' · ⚠ 散戶偏多' : ''}${D.fopt.bear ? ' · ⚠ 外資選擇權偏空' : ''}`;
  $('#view').innerHTML = wallCard(D) + netCard(D) + foptCard(D) + pnlCard(D) + retailCard(D) + largeCard(D) + pcCard(D) + basisCard(D);
}

async function main() {
  try {
    const res = await fetch(`${DATA}/futpage.json`);
    if (!res.ok) throw new Error(`futpage.json ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    console.error(err);
    $('#meta').textContent = '載入失敗';
    $('#view').innerHTML = '<p class="hint">資料載不到。這一頁要等 <code>scripts/build_futures.py</code> 跑過一次才有東西。</p>';
    return;
  }
  render();
}

main();
