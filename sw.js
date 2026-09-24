/* Minimal app-shell cache so Splitpage still opens offline once it has been
   loaded at least once. Network-first for the page itself, stale-while-
   revalidate for the two static files beside it, and nothing else —
   cross-origin requests (Google Fonts) are left to the network as-is.

   The cache name carries the release, and build.mjs is what puts it there:
   it rewrites the line below from VERSION, and `node build.mjs --check`
   fails when the two have drifted. Do not hand-edit the version in it.

   Why it has to be stamped (issue #79): Cache Storage is keyed by name and
   nothing ever expires it. Under one fixed name a deploy's new index.html
   lost to the previous release's cached copy — everybody ran the old client
   for a full load after every deploy — and the entries of every release that
   ever ran stayed on disk. A per-version name turns the activate handler
   below from a no-op into the thing that actually reclaims that space. */
var CACHE = "splitpage-3.0.0-beta.4";
var SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg"];

/* Resolved once, against this worker's own URL, the same way the relative
   entries in SHELL are — so these are the exact keys cache.addAll() wrote. */
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

  /* Never the launcher's status file, for the same reason one level down.
     20a-update.js fetches it with `cache: "no-store"`, which is an
     instruction to the HTTP cache and says nothing at all to a service
     worker — Cache Storage is a separate store this file writes by hand, so
     without this guard the one file explicitly asked for fresh would be the
     one file guaranteed to be stale. start.mjs rewrites it at every launch
     and the update bar is the only thing that reads it, so a cached copy
     means offering an update that is already installed, or staying silent
     about one that is not. Relative, like the fetch that asks for it. */
  if (/(^|\/)update-status\.json$/.test(url.pathname)) return;

  /* A query string means this is not the app shell. `?doc=` opens a hosted
     document, and each one is a distinct URL serving the same 1.4MB
     index.html — cached per document, which is how a few days of use filled
     Cache Storage. Nothing the app needs offline lives behind a query
     string: the fonts are cross-origin and refused above, and the document
     itself comes from the API, refused above as well. So the rule can be
     this blunt — nothing with a search is ever WRITTEN to the cache. Reading
     is the one exception, and only for a navigation; see the fallback. */
  var cacheable = url.search === "";

  /* A navigation, or the shell page asked for by URL. */
  var isShellDoc = event.request.mode === "navigate" || url.href === INDEX_URL || url.href === ROOT_URL;

  if (isShellDoc) {
    /* Network-first, so the first load after a deploy is the new build
       rather than the last one. The old worker is still the one answering
       this load — a new sw.js is not even fetched until a navigation is in
       flight — so going to the cache first here is precisely what made a
       release take two loads to appear. */
    event.respondWith(
      fetch(event.request).then(function (res) {
        /* Cloned synchronously. caches.open() resolves a turn later, by
           which point the browser is already reading the body it was handed,
           and a clone taken then throws "body is already used". */
        if (cacheable && res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(event.request, copy); });
        }
        return res;
      }).catch(function () {
        /* The cache is the fallback for a DEAD NETWORK and nothing else.
           This is fetch()'s rejection, which a 404 or a 500 does not cause:
           those are answers from a server that is plainly reachable, so they
           are passed through untouched. A broken deploy then looks broken,
           instead of being hidden behind — and, in the branch above, written
           into — the copy that has to keep working offline.

           Matched without the query string, because that is the only key
           there is: a `?doc=` URL was never written. Reloading one offline
           cannot reach the document (it lives behind the API), but serving
           the shell lets the app come up and say so in its own words rather
           than handing the reader the browser's error page. */
        return caches.match(url.origin + url.pathname).then(function (cached) {
          return cached || caches.match(INDEX_URL);
        });
      })
    );
    return;
  }

  if (!cacheable) return;

  /* Everything else same-origin: manifest.webmanifest and icon.svg. Those
     change only with a release, and the whole cache is dropped by name when
     one lands, so stale-while-revalidate is still right for them — unlike
     the page, a one-load-old icon cannot leave anybody running last
     release's client. */
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
