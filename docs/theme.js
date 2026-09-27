/*
 * 亮／暗色系的切換開關。index.html、us.html、jp.html 三頁共用。
 *
 * ## 為什麼深色不再是純 CSS 的 prefers-color-scheme
 *
 * 原本整份深色調色盤掛在 @media (prefers-color-scheme: dark) 底下，跟著系統走，
 * 一行 JS 都不用。要能手動切，就得讓「系統說暗」與「使用者說暗」兩個條件指向同一
 * 份變數——而 CSS 沒辦法把 @media 併進選擇器清單，唯一的寫法是把那二十幾行調色盤
 * 抄成兩份（media 一份、[data-theme] 一份），再靠人記得兩份一起改。這份專案已經
 * 被同一種約定咬過一次（見 nav.js 的開頭，us.html 的導覽手抄了一份、漏同步十個版本）。
 *
 * 所以改成：調色盤只留 :root[data-theme="dark"] 一份，由這支決定該不該掛上去。
 * 代價是沒有 JS 就沒有深色——但這三頁的內容本來就全是 JS 畫的，沒有 JS 連
 * 「載入中…」都跳不掉，這個代價等於沒有代價。
 *
 * ## 為什麼是 <head> 裡的同步 script，不是 defer
 *
 * defer（或放在 </body> 前）都是在 HTML 解析完之後才套上 data-theme，深色使用者
 * 每次開頁都會先被白底閃一下。這支擋在 head 那幾毫秒，換掉的就是那個白閃。
 * 也因為它在 body 之前跑，開關的 DOM 只能等 DOMContentLoaded 才插得進去。
 *
 * ## 為什麼整支包在 IIFE 裡
 *
 * 跟 nav.js 同一個理由：app.js／us.js／pair.js 都是傳統 script，共用同一個全域語彙
 * 環境，撞名的 const 是 SyntaxError 不是覆寫。只往外露一個 window.StockTheme。
 */
window.StockTheme = (function () {
  const KEY = 'stocktracker.theme';
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');

  /**
   * 使用者「指定」的模式，null 代表沒指定、跟著系統走。
   *
   * 注意這裡存的語意是**覆寫**而不是「目前是哪個模式」，差別見 set()。
   */
  function pinned() {
    try {
      const v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : null;
    } catch (err) {
      return null;   // 無痕視窗連讀都會丟例外，當成沒指定過
    }
  }

  const systemMode = () => (system.matches ? 'dark' : 'light');
  const resolve = () => pinned() || systemMode();

  /*
   * 手機會把網址列／狀態列染成 theme-color。三頁的 <meta> 原本寫死深色 #0f1216，
   * 亮色模式下就變成深色網址列配白色頁面，接縫很明顯。跟著切。
   */
  const BAR = { light: '#ffffff', dark: '#0f1216' };

  function apply() {
    const mode = resolve();
    root.dataset.theme = mode;

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = BAR[mode];

    paint(mode);
    return mode;
  }

  /**
   * 指定模式。
   *
   * 跟系統相同的選擇**不寫進 localStorage**——存的是「覆寫」，而一個跟系統一致的
   * 覆寫不是覆寫。這不是省一個 key 的小聰明，是唯一一條回到「跟著系統」的路：
   * 這顆開關只有兩段，使用者手癢按一下之後，若把選擇一律釘死，他就再也回不到自動
   * 跟隨了（夜裡系統轉深色，這一頁還是白的）。撥回跟系統一樣的那一邊＝解除釘選。
   */
  function set(mode) {
    try {
      if (mode === systemMode()) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, mode);
    } catch (err) {
      /* 記不住就只這一次有效，下次開頁回到跟著系統——比整個切換壞掉好 */
    }
    return apply();
  }

  const toggle = () => set(resolve() === 'dark' ? 'light' : 'dark');

  /* 12px 見方的字級，太陽畫八條光芒會糊成一團，所以只留四條正向的。 */
  const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"'
    + ' stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.6"/>'
    + '<path d="M12 1.6v2.8M12 19.6v2.8M1.6 12h2.8M19.6 12h2.8"/></svg>';
  const MOON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
    + '<path d="M20.6 14.8A8.8 8.8 0 0 1 9.2 3.4a8.9 8.9 0 1 0 11.4 11.4z"/></svg>';

  /** 把開關的外觀對齊目前模式。開關還沒插進 DOM（head 階段）時是安全的 no-op。 */
  function paint(mode) {
    const el = document.getElementById('theme-switch');
    if (!el) return;
    const dark = mode === 'dark';
    // role="switch" 的讀屏播報靠 aria-checked，不是靠裡面那顆圖示
    el.setAttribute('aria-checked', String(dark));
    el.title = dark ? '切成亮色' : '切成暗色';
    const knob = el.firstElementChild;
    if (knob) knob.innerHTML = dark ? MOON : SUN;
  }

  /*
   * 開關放在 .app-bar__top 的最後一格：三頁都有這個容器，排行頁它會落在日期切換
   * 的右邊，另外兩頁就直接靠右——同一個位置，換頁時不用重新找。
   *
   * 由 JS 插而不是寫進三份 HTML，理由同 nav.js：三份手抄的副本遲早會有一份漏改。
   */
  function mount() {
    const bar = document.querySelector('.app-bar__top');
    if (!bar || document.getElementById('theme-switch')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'theme-switch';
    btn.className = 'theme-switch';
    btn.setAttribute('role', 'switch');
    btn.setAttribute('aria-label', '暗色模式');
    btn.innerHTML = '<span class="theme-switch__knob"></span>';
    btn.addEventListener('click', toggle);

    bar.appendChild(btn);
    paint(resolve());
  }

  /*
   * 沒指定過才跟著系統動。指定過的人半夜系統自己轉深色時，這一頁不該跟著翻——
   * 他按那一下的意思就是「我要的跟系統不一樣」。
   */
  system.addEventListener('change', () => {
    if (!pinned()) apply();
  });

  /*
   * 同一個站開了兩個分頁時，另一頁撥了開關，這一頁要跟著換。storage 事件只在
   * 「其他分頁」觸發，不會打到自己身上，所以不會跟 set() 打架。
   */
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) apply();
  });

  apply();   // head 階段先把 data-theme 掛上去，避開白閃
  document.addEventListener('DOMContentLoaded', mount);

  return { get: resolve, set, toggle, mount };
})();
