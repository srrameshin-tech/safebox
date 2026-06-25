const CACHE_NAME = "safebox-v8";
const ASSETS = ["./", "./index.html", "./app.js", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting(); // activate new SW immediately, don't wait for old tabs to close
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim()) // take control of open pages immediately
  );
});

self.addEventListener("fetch", e => {
  // Never intercept Firebase calls
  if (e.request.url.includes("firebaseio.com") || e.request.url.includes("googleapis.com")) {
    return;
  }
  // Network-first for our own app shell files (html/js) so updates show up immediately
  const url = e.request.url;
  const isAppShell = url.endsWith(".html") || url.endsWith(".js") || url.endsWith("/") || url.includes("index.html");
  if (isAppShell) {
    e.respondWith(
      fetch(e.request).then(resp => {
        const respClone = resp.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, respClone));
        return resp;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  // Cache-first for everything else (icons, manifest)
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).catch(() => cached))
  );
});
