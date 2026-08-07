/* NutriDaily service worker — app-shell caching for installable/offline use.
 * Bump CACHE to force-refresh cached assets after a deploy.
 */
const CACHE = "nutridaily-v76";
const SHELL = [
  ".", "index.html", "css/style.css", "manifest.webmanifest", "js/boot.js",
  "js/config.js", "js/data-foods.js", "js/foodmatch.js", "js/parse.js", "js/foods.js",
  "js/share.js", "js/ledger.js", "js/phases.js", "js/analytics.js", "js/phase-prompt.js", "js/gap-prompt.js",
  "js/gdrive.js", "js/sync.js", "js/redact.js", "js/feedback.js", "js/ui.js", "js/app.js",
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
  if (url.pathname.indexOf("/api/") === 0) return; // auth: network only
  // The network response and cache update are deliberately separate promises:
  // quota/cache failures must never discard a response that already arrived.
  const fresh = fetch(e.request);
  const cacheUpdate = fresh.then((res) => {
    if (!res || !res.ok || res.status !== 200 || res.type === "opaque") return undefined;
    return caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
  }).catch(() => undefined);
  // Extend the event synchronously. Calling waitUntil from inside a later
  // caches.match callback can happen after the dispatch has already ended.
  e.waitUntil(cacheUpdate);
  e.respondWith(
    caches.match(e.request).then((cached) => {
      return cached || fresh;
    })
  );
});
