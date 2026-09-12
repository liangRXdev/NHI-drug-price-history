// 只快取網站外殼（network-first，離線才用快取）；data/ 一律走網路，不快取：
// 藥價資料若從 SW 快取取得，會繞過 dataVersion／過期警示的設計。改版時升 CACHE 版本號。
//
// GitHub Pages 的專案頁共用同一個 origin（<user>.github.io），Cache Storage 不依 SW scope 隔離：
// 清舊版時只能刪本專案前綴，否則會刪掉同網域其他臨床工具的離線快取（codex R9）。
const PREFIX = 'nhi-price-shell-';
const CACHE = `${PREFIX}v3`;
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'engine.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/data/')) return;          // 資料不經 SW
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(e.request, { ignoreSearch: e.request.mode === 'navigate', cacheName: CACHE });
        if (hit) return hit;
        // 只有頁面導覽可退回 index.html；JS／CSS 回 HTML 會變成難以診斷的語法錯誤
        if (e.request.mode === 'navigate') {
          const shell = await caches.match('index.html', { cacheName: CACHE });
          if (shell) return shell;
        }
        return Response.error();
      }),
  );
});
