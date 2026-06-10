const CACHE_NAME = "openclaw-v3";
const STATIC_ASSETS = ["/", "/manifest.json", "/app.js", "/js/core/router.js", "/js/core/state.js", "/js/core/api.js", "/js/core/events.js", "/js/utils/dom.js", "/js/utils/format.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((res) => {
        if (res.ok && res.headers.get("content-type")?.includes("json")) return res;
        const clone = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
        return res;
      }).catch(() => cached || new Response(JSON.stringify({ offline: true }), { headers: { "Content-Type": "application/json" } }));
    })
  );
});
