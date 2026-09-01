/* Minimal app-shell cache so Splitpage still opens offline once it has been
   loaded at least once. Stale-while-revalidate for same-origin GETs only —
   cross-origin requests (Google Fonts) are left to the network as-is. */
var CACHE = "splitpage-v1";
var SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) { return cache.addAll(SHELL); }));
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;
  var url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  /* Never the API. These are documents and revisions, not app shell. The
     server marks every API response no-store for exactly this reason, but a
     service worker writes to the Cache Storage API regardless of HTTP cache
     semantics — so stale-while-revalidate here would hand a hosted document
     back at the revision it had on the previous page load. The client would
     then believe it was current, show "everyone sees this" about a version
     nobody else is on, and save against a stale rev: the precise situation
     the compare-and-set exists to prevent. Paths are relative to the app's
     own directory (apiFetch calls "api/docs/..."), so match on the segment
     rather than on a leading slash. */
  if (/(^|\/)api\//.test(url.pathname)) return;

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      var network = fetch(event.request).then(function (res) {
        if (res && res.ok) caches.open(CACHE).then(function (c) { c.put(event.request, res.clone()); });
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});
