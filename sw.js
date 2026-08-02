/* NutriChat service worker — app-shell caching for installable/offline use.
 * Strategy: same-origin GETs are served stale-while-revalidate; cross-origin
 * (Google sign-in, Drive) always goes to the network untouched.
 */
const CACHE = "nutrichat-v2";
const SHELL = [
  ".", "index.html", "css/style.css", "manifest.webmanifest",
  "js/config.js", "js/data-foods.js", "js/foodmatch.js", "js/parse.js", "js/foods.js",
  "js/share.js", "js/ledger.js", "js/gdrive.js", "js/sync.js", "js/ui.js", "js/app.js",
  "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fresh = fetch(e.request)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
