// Weight Projection — service worker
// Bump CACHE_VERSION when you change any cached asset.
const CACHE_VERSION = "wp-v11";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./apple-touch-icon.png",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./meal-plan/food-lookup.js",
  "./meal-plan/solver.js",
  "./meal-plan/planner.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for HTML AND our own JS (so code/markup updates always land when
// online — no CACHE_VERSION bump required, which is too easy to forget); cache-first
// only for truly static assets (icons, manifest). Everything falls back to cache
// offline.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  const isHTML = req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");
  const isCode = url.pathname.endsWith(".js");

  if (isHTML || isCode) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(isHTML ? "./index.html" : req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((c) => c || (isHTML ? caches.match("./index.html") : undefined)))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        return res;
      }).catch(() => cached)
    )
  );
});
