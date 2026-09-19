/*
 * 兩層導覽（群組 → 分頁），以及底部 tab bar 的收合行為。index.html 與 us.html 共用。
 *
 * ## 為什麼獨立成一支
 *
 * us.html 不是排行榜那支 SPA 的分頁——它只讀 data/us/index.json，不吃交易日與範圍
 * 那一整套狀態。以前它的導覽是照著 app.js 的 NAV **手抄一份寫死在 HTML 裡**，檔案
 * 裡還留著一句「分法改了的話這裡要跟著 app.js 一起改」。那種靠記性的約定遲早會漏，
 * 而且已經漏過一次：us.html 的前端版號卡在 25，index.html 都到 35 了。
 *
 * 現在兩頁的導覽都從這裡的同一份 NAV 畫出來，HTML 只留兩個空的 <nav>。
 *
 * ## 為什麼整支包在 IIFE 裡
 *
 * app.js 與 us.js 都是傳統 script，跟這支共用同一個全域語彙環境。兩邊都有
 * `const esc = …`，再宣告一次是 SyntaxError（不是覆寫，是整支掛掉）。所以只往外
 * 露一個 window.StockNav。
 */
window.StockNav = (function () {
  const esc = (s) => String(s).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /**
   * 導覽的兩層：群組 → 分頁。
   *
   * 十幾個分頁擠在同一列，手機上一次只看得到六個，捲出去的那幾個等於不存在。
   * 分組的軸是「這一頁回答什麼問題」，不是「資料從哪來」——使用者腦中的問題是
   * 「誰在買」而不是「這份資料來自集保還是三大法人」。
   *
   * 帶 href 的那一項是站外的獨立頁面（美股連動不吃日期與範圍那組狀態，所以它不在
   * 這支 SPA 裡）；其餘都是 hash 路由。
   */
  const NAV = [
    { key: 'rank', label: '排行', views: [
      { v: 'rank', label: '排行' }, { v: 'streak', label: '站穩' },
      { v: 'moves', label: '異動' }, { v: 'entry', label: '後續' },
      { v: 'period', label: '週月' }] },
    { key: 'tech', label: '技術', views: [
      { v: 'burst', label: '爆量' }, { v: 'ma', label: '均線' }, { v: 'macd', label: 'MACD' }] },
    { key: 'chips', label: '籌碼', views: [
      { v: 'holders', label: '大戶' }, { v: 'insti', label: '法人' },
      { v: 'instirank', label: '買超' }, { v: 'instirun', label: '連買' },
      { v: 'radar', label: '雷達' }] },
    { key: 'money', label: '資金', views: [
      { v: 'sector', label: '族群' }, { v: 'flow', label: '流向' }, { v: 'market', label: '大盤' }] },
    { key: 'world', label: '環境', views: [
      { v: 'quote', label: '報價' }, { v: 'us', label: '美股', href: 'us.html' }] },
    { key: 'find', label: '查詢', views: [
      { v: 'stock', label: '個股' }, { v: 'compare', label: '對照' }] },
  ];

  /*
   * 獨立頁面用 <body data-view="us"> 宣告「我不是 SPA，而且我停在這一頁」。
   * 沒有這個屬性的就是 index.html：連結維持純 hash，換頁才不會整支程式重載。
   */
  const standalone = document.body.dataset.view || null;
  const base = standalone ? 'index.html' : '';

  const NAV_KEY = 'stocktracker.nav';

  /** 每個群組上次停在哪一個網址。存整串 hash，回到「查詢」時才會回到原本那一檔個股。 */
  function loadNavLast() {
    try {
      const raw = JSON.parse(localStorage.getItem(NAV_KEY) || '{}');
      return raw && typeof raw === 'object' ? raw : {};
    } catch (err) {
      return {};
    }
  }

  const navLast = loadNavLast();

  const groupOf = (view) => NAV.find((g) => g.views.some((t) => t.v === view)) || NAV[0];

  /** 畫兩層導覽。在 render() 的最前面呼叫：載入中也要看得到自己在哪一頁。 */
  function paintNav(view) {
    const group = groupOf(view);

    // 只有 SPA 記得住「上次停在哪」。us.html 的網址不是 hash，記進去會讓群組鍵指到錯的地方。
    if (!standalone) {
      navLast[group.key] = location.hash || `#/${group.views[0].v}`;
      try {
        localStorage.setItem(NAV_KEY, JSON.stringify(navLast));
      } catch (err) {
        /* 記不住就算了，下次從該群組的第一頁開始 */
      }
    }

    const tabs = document.querySelector('.tabs');
    if (tabs) {
      tabs.innerHTML = NAV.map((g) => {
        const hash = navLast[g.key] || `#/${g.views[0].v}`;
        return `<a class="${g.key === group.key ? 'active' : ''}" href="${esc(base + hash)}"`
          + `>${esc(g.label)}</a>`;
      }).join('');
    }

    const subtabs = document.querySelector('.subtabs');
    if (!subtabs) return;
    subtabs.innerHTML = group.views.map((t) => {
      /*
       * ↗ 的意思固定是「這個連結會離開你現在這一頁」。在 SPA 裡是帶 href 的那種
       * 站外頁；在 us.html 上剛好相反——回排行榜的才是離開，美股那一項就是這一頁本身。
       */
      const leaves = standalone ? !t.href : !!t.href;
      const url = t.href || `${base}#/${t.v}`;
      return `<a class="${t.v === view ? 'active' : ''}" href="${esc(url)}">`
        + `${esc(t.label)}${leaves ? ' ↗' : ''}</a>`;
    }).join('');
  }

  const viewFromHash = () => location.hash.replace(/^#\/?/, '').split('?')[0].split('/')[0] || 'rank';

  paintNav(standalone || viewFromHash());

  /*
   * ## 底部 tab bar 的自動收合：往下滑收起、往上滑出現
   *
   * 用**方向**而不是「停止捲動」當觸發。讀清單時停頓一直在發生——滑一段、看幾列、
   * 再滑一段——用停止當條件的話，bar 會在每個停頓彈出來又在下一個手勢消失，動畫的
   * 頻率跟使用者的意圖完全無關。iOS 的慣性捲動還會讓它更糟：手指早就離開螢幕了，
   * scroll 事件還在噴，得靠 debounce 猜「這次是真的停了嗎」，猜早了就在慣性中途彈出。
   *
   * 往上滑本身就是「我要回去／我要換頁」的手勢，拿它當條件，想用導覽的那一刻它就在了。
   *
   * 只在直立手機掛監聽——桌面版的導覽在側邊欄，根本不會動。
   */
  const bar = document.querySelector('.tabs');
  if (bar) {
    const phone = window.matchMedia('(max-width: 767px)');
    let last = 0;
    let ticking = false;

    const show = () => bar.classList.remove('is-away');

    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const y = Math.max(0, window.scrollY);
        // 手指微抖、或橡皮筋回彈那幾 px，不該讓 bar 抽動
        if (Math.abs(y - last) < 6) return;
        // 頂端那 80px 一律顯示：剛進頁面就先把導覽藏起來是最沒道理的一種
        bar.classList.toggle('is-away', y > last && y > 80);
        last = y;
      });
    }

    function apply() {
      window.removeEventListener('scroll', onScroll);
      show();
      if (!phone.matches) return;
      last = Math.max(0, window.scrollY);
      window.addEventListener('scroll', onScroll, { passive: true });
    }

    apply();
    phone.addEventListener('change', apply);
    // 換頁之後導覽一定要在：使用者剛用完它，下一步很可能還要再用一次
    window.addEventListener('hashchange', show);
  }

  return { NAV, groupOf, paintNav };
})();
