// Weight Projection — service worker (Next.js build)
//
// The original single-file app precached a fixed asset list. A Next.js build
// emits hashed chunks under /_next/static, so we can't hand-list them. Instead:
//   • navigations + same-origin GETs are network-first, falling back to cache
//     (so updates land when online, and the app still opens offline);
//   • hashed static assets (/_next/static, icons) are cache-first (immutable).
// Cross-origin requests (fonts, the WebLLM CDN) are left to the network.
const CACHE_VERSION = "wp-next-v1";
const OFFLINE_URL = "/";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll([OFFLINE_URL, "/manifest.webmanifest"]))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // leave fonts / CDN to the network

  const isNavigation = req.mode === "navigate";
  // Immutable, content-hashed assets → cache-first.
  const isImmutable = url.pathname.startsWith("/_next/static/") || /\.(png|svg|ico|woff2?)$/.test(url.pathname);

  if (isImmutable) {
    event.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
            return res;
          })
      )
    );
    return;
  }

  // Everything else (navigations, RSC payloads, manifest) → network-first.
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(isNavigation ? OFFLINE_URL : req, copy));
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) => cached || (isNavigation ? caches.match(OFFLINE_URL) : undefined))
      )
  );
});
