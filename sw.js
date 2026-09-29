var CACHE = "splitpage-3.0.0";
var SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg", "./icon-maskable.svg"];

var INDEX_URL = new URL("./index.html", self.location.href).href;
var ROOT_URL = new URL("./", self.location.href).href;

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

  if (/(^|\/)api\//.test(url.pathname)) return;

  if (/(^|\/)update-status\.json$/.test(url.pathname)) return;

  var cacheable = url.search === "";

  var isShellDoc = event.request.mode === "navigate" || url.href === INDEX_URL || url.href === ROOT_URL;

  if (isShellDoc) {
    event.respondWith(
      fetch(event.request).then(function (res) {
        if (cacheable && res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(event.request, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(url.origin + url.pathname).then(function (cached) {
          return cached || caches.match(INDEX_URL);
        });
      })
    );
    return;
  }

  if (!cacheable) return;

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      var network = fetch(event.request).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(event.request, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});
