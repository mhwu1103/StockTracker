/*
 * 離線支援：同源檔案一律 network-first，離線時才退回快取。
 *
 * 外殼檔案（app.js／style.css）不可以用 cache-first：那會讓已安裝的使用者
 * 永遠停在舊版前端，除非每次改版都記得手動換快取名稱。
 * 只有 CDN 上帶版號的第三方程式庫走 cache-first，因為同一個網址內容永不改變。
 */

const VERSION = '8';                 // 前端版號，與 index.html 的 ?v= 一起改
const CACHE = `stocktracker-v${VERSION}`;
const SHELL = ['./', 'index.html', `style.css?v=${VERSION}`, `app.js?v=${VERSION}`,
  'manifest.webmanifest', 'icons/icon.svg'];

// 外殼檔案（HTML／JS／CSS）不可以吃瀏覽器的 HTTP 快取。
// data/index.json 永遠是 cache: 'reload' 抓最新的，外殼卻可能是幾天前的舊版，
// 兩邊一錯開就是「新資料配舊前端」——舊 app.js 讀不懂新格式，整頁掛在載入失敗。
// data/ 底下的檔案不受影響：每天的資料都是新網址，內容不會變，照常吃快取。
const SHELL_FILE = /\.(html|js|css|webmanifest)$/;
const isShell = (url) => url.pathname.endsWith('/') || SHELL_FILE.test(url.pathname);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  event.respondWith(sameOrigin ? networkFirst(request, isShell(url)) : cacheFirst(request));
});

async function networkFirst(request, revalidate = false) {
  const cache = await caches.open(CACHE);
  try {
    // revalidate 的請求帶 no-cache：一定回伺服器問一次，內容沒變時仍是 304，不會多花流量
    const res = await fetch(
      revalidate ? new Request(request.url, { cache: 'no-cache', credentials: 'same-origin' }) : request
    );
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}
