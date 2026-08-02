/* NutriDaily service worker — app-shell caching for installable/offline use. */
const CACHE = "nutridaily-v26";
const SHELL = [
  ".", "index.html", "css/style.css", "manifest.webmanifest",
  "js/config.js", "js/data-foods.js", "js/foodmatch.js", "js/parse.js", "js/foods.js",
  "js/share.js", "js/ledger.js", "js/phases.js", "js/phase-prompt.js", "js/gdrive.js", "js/sync.js", "js/ui.js", "js/app.js",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png", "icons/favicon-32.png", "icons/favicon-48.png",
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
