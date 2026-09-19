/*
 * 底部 tab bar 的自動收合：往下滑收起、往上滑出現。
 *
 * 用**方向**而不是「停止捲動」當觸發。讀清單時停頓一直在發生——滑一段、看幾列、
 * 再滑一段——用停止當條件的話，bar 會在每個停頓彈出來又在下一個手勢消失，動畫的
 * 頻率跟使用者的意圖完全無關。iOS 的慣性捲動還會讓它更糟：手指早就離開螢幕了，
 * scroll 事件還在噴，得靠 debounce 猜「這次是真的停了嗎」，猜早了就在慣性中途彈出。
 *
 * 往上滑本身就是「我要回去／我要換頁」的手勢，拿它當條件，想用導覽的那一刻它就在了。
 *
 * index.html 與 us.html 共用這一份：兩頁的 .tabs 是同一套靜態 HTML，而且都會捲很長。
 * 只在直立手機掛監聽——桌面版的 bar 在側邊，根本不會動。
 */
(function () {
  const bar = document.querySelector('.tabs');
  if (!bar) return;

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
})();
