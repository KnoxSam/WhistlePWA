/* Service worker: rende l'app disponibile offline e riceve file condivisi (Android). */
const VERSION = "whistle-v2";
const SHELL = [
  "./", "index.html", "app.js", "segments.js", "whistle-worker.js", "manifest.webmanifest",
  "icon.svg", "icon-192.png", "icon-512.png", "icon-180.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== "whistle-share-inbox" && k !== "whistle-runtime")
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Web Share Target: Android "Condividi → Whistle"
  if (e.request.method === "POST" && url.pathname.endsWith("/share-target")) {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const file = form.get("audio");
      if (file && typeof file !== "string") {
        const cache = await caches.open("whistle-share-inbox");
        await cache.put("shared-file", new Response(file, {
          headers: { "content-type": file.type || "application/octet-stream",
                     "x-file-name": encodeURIComponent(file.name || "audio-condiviso") },
        }));
      }
      return Response.redirect("./?shared=1", 303);
    })());
    return;
  }

  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  // cache-first per i file dell'app, poi rete (e aggiorna la cache)
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return res;
    })),
  );
});
