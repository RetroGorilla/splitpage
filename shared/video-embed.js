"use strict";
/* ---------------------------------------------------------------------
 * shared/video-embed.js: which video links Splitpage can play in a scene's
 * gallery (#168) and fetch a thumbnail for (#141), and the fixed places it
 * talks to for them.
 *
 * Two hosts and no others: YouTube and Vimeo. A link is reduced to its
 * host and the video's id (plus, for an unlisted Vimeo video, its privacy
 * hash) and everything the app ever sends anywhere is REBUILT from those
 * two against the hosts below — never the link as the user pasted it. So
 * the player's address, the thumbnail's address and Vimeo's oEmbed call
 * can only ever name these hosts:
 *
 *   player (a frame, after the play button is pressed — never before):
 *     https://www.youtube-nocookie.com/embed/<id>   YouTube's no-cookie
 *                                                   embed
 *     https://player.vimeo.com/video/<id>?dnt=1     Vimeo's, "do not track"
 *   thumbnail (fetched once, when a link is pasted, and kept as a blob):
 *     https://i.ytimg.com/vi/<id>/hqdefault.jpg
 *     https://vimeo.com/api/oembed.json?url=…       whose thumbnail_url must
 *     https://i.vimeocdn.com/video/…                be on this host
 *
 * The same file is bundled into the page (esbuild), required by the
 * desktop main process (its thumbnail IPC takes only a host name and a
 * video ref, which it checks here, and fetches from here) and imported by
 * node --test — the reason it is CommonJS, like blob-policy.js beside it.
 * PURE: no DOM, no Electron, no network of its own. fetchVideoThumbnail
 * is handed the fetch to use, and a test hands it a fake one.
 *
 * What a thumbnail may be: a JPEG, PNG or WebP (sniffed from the bytes,
 * never the Content-Type), at most THUMB_MAX_BYTES. No redirect is
 * followed: a redirect off these hosts would be a request to an address
 * nobody checked.
 *
 * shared/ names no globals (eslint.config.mjs). The five below are the
 * exception this file needs, and each is the same object in all three
 * places it runs — a browser, Electron's main process and node — with no
 * document, filesystem or process behind it: URL parses a link, and a
 * fetch is timed out and its JSON decoded with the other four.
 * --------------------------------------------------------------------- */
/* global URL, AbortController, setTimeout, clearTimeout, TextDecoder */

var blobPolicy = require("./blob-policy.js");

var YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
var VIMEO_ID_RE = /^[0-9]{1,12}$/;
var VIMEO_HASH_RE = /^[0-9a-f]{6,32}$/;
/* A video's ref as it crosses a boundary (the desktop IPC): a YouTube id,
   or a Vimeo id with its hash after a colon when it has one. */
var VIDEO_REF_RE = /^(?:[A-Za-z0-9_-]{11}|[0-9]{1,12}(?::[0-9a-f]{6,32})?)$/;

var THUMB_MAX_BYTES = 1024 * 1024;
var THUMB_MIMES = ["image/jpeg", "image/png", "image/webp"];
var OEMBED_MAX_BYTES = 64 * 1024;
var FETCH_TIMEOUT_MS = 8000;

/* Where each thing lives. A test (the browser suites' fake host, the
   desktop's SPLITPAGE_TEST_VIDEO_BASE) passes its own copy; nothing else
   ever does. */
var VIDEO_HOSTS = {
  youtubePlayer: "https://www.youtube-nocookie.com",
  youtubeThumbs: "https://i.ytimg.com",
  vimeoPlayer: "https://player.vimeo.com",
  vimeoOembed: "https://vimeo.com",
  vimeoThumbs: "https://i.vimeocdn.com"
};

/* The two origins a player frame comes from: build.mjs's frame-src, and
   what the desktop app lets such a frame do. */
var PLAYER_ORIGINS = [VIDEO_HOSTS.youtubePlayer, VIDEO_HOSTS.vimeoPlayer];

var YOUTUBE_HOST_RE = /^(?:www\.|m\.|music\.)?youtube\.com$|^(?:www\.)?youtube-nocookie\.com$/i;
var VIMEO_HOST_RE = /^(?:www\.)?vimeo\.com$/i;

/* "90", "90s", "1m30s", "1h2m3s" (YouTube's t=) as whole seconds, or 0. */
function parseStart(v) {
  if (typeof v !== "string" || !v) return 0;
  var m = /^(?:(\d{1,2})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s?)?$/i.exec(v.trim());
  if (!m || !(m[1] || m[2] || m[3])) return 0;
  var s = (parseInt(m[1] || "0", 10) * 3600) + (parseInt(m[2] || "0", 10) * 60) + parseInt(m[3] || "0", 10);
  return s > 0 && s < 86400 ? s : 0;
}

/* A pasted link as {host: "youtube" | "vimeo", id, hash?, start?}, or null
   for anything else — another site, a channel or a playlist rather than
   one video, an id of the wrong shape. */
function parseVideoLink(href) {
  if (typeof href !== "string" || href.length > 2048) return null;
  var u;
  try { u = new URL(href); } catch (e) { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  var host = u.hostname.toLowerCase();
  var path = u.pathname;
  var id = null, m;
  var out;
  if (host === "youtu.be") {
    m = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(path);
    id = m ? m[1] : null;
  } else if (YOUTUBE_HOST_RE.test(host)) {
    if (path === "/watch" || path === "/watch/") id = u.searchParams.get("v");
    else if ((m = /^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})\/?$/.exec(path))) id = m[1];
  }
  if (id !== null) {
    if (!YOUTUBE_ID_RE.test(id)) return null;
    out = { host: "youtube", id: id };
    var start = parseStart(u.searchParams.get("t") || u.searchParams.get("start") || "");
    if (start) out.start = start;
    return out;
  }
  var hash = null;
  if (host === "player.vimeo.com") {
    m = /^\/video\/([0-9]{1,12})\/?$/.exec(path);
    if (m) { id = m[1]; hash = u.searchParams.get("h"); }
  } else if (VIMEO_HOST_RE.test(host)) {
    if ((m = /^\/(?:video\/)?([0-9]{1,12})(?:\/([0-9a-f]{6,32}))?\/?$/.exec(path))) { id = m[1]; hash = m[2] || u.searchParams.get("h"); }
    else if ((m = /^\/(?:channels\/[A-Za-z0-9_-]+|groups\/[A-Za-z0-9_-]+\/videos|album\/[0-9]+\/video|showcase\/[0-9]+\/video)\/([0-9]{1,12})\/?$/.exec(path))) id = m[1];
  }
  if (id === null || !VIMEO_ID_RE.test(id)) return null;
  out = { host: "vimeo", id: id };
  if (hash) {
    if (!VIMEO_HASH_RE.test(hash)) return null;
    out.hash = hash;
  }
  var t = /(?:^|&)t=([0-9hms]+)/i.exec((u.hash || "").replace(/^#/, ""));
  var vs = t ? parseStart(t[1]) : 0;
  if (vs) out.start = vs;
  return out;
}

/* The ref a video crosses the desktop IPC as ("dQw4w9WgXcQ", "76979871",
   "76979871:abcdef1234"), and back. */
function videoRef(v) {
  if (!v) return "";
  return v.host === "vimeo" && v.hash ? v.id + ":" + v.hash : v.id;
}

function parseVideoRef(host, ref) {
  if (typeof ref !== "string" || !VIDEO_REF_RE.test(ref)) return null;
  if (host === "youtube") return YOUTUBE_ID_RE.test(ref) ? { host: "youtube", id: ref } : null;
  if (host !== "vimeo") return null;
  var parts = ref.split(":");
  if (!VIMEO_ID_RE.test(parts[0])) return null;
  var out = { host: "vimeo", id: parts[0] };
  if (parts[1]) out.hash = parts[1];
  return out;
}

function hostsOr(bases) {
  var out = {};
  Object.keys(VIDEO_HOSTS).forEach(function (k) {
    out[k] = bases && typeof bases[k] === "string" ? bases[k].replace(/\/+$/, "") : VIDEO_HOSTS[k];
  });
  return out;
}

/* The player's address for a parsed link: YouTube's no-cookie embed or
   Vimeo's player with dnt=1, both starting at once (the play button was
   the click that asked for it). */
function playerUrl(v, bases) {
  if (!v) return null;
  var h = hostsOr(bases);
  if (v.host === "youtube" && YOUTUBE_ID_RE.test(v.id)) {
    return h.youtubePlayer + "/embed/" + v.id + "?autoplay=1&rel=0&playsinline=1" + (v.start ? "&start=" + v.start : "");
  }
  if (v.host === "vimeo" && VIMEO_ID_RE.test(v.id)) {
    return h.vimeoPlayer + "/video/" + v.id + "?autoplay=1&dnt=1" + (v.hash && VIMEO_HASH_RE.test(v.hash) ? "&h=" + v.hash : "") +
      (v.start ? "#t=" + v.start + "s" : "");
  }
  return null;
}

/* The first request for a video's thumbnail: the picture itself
   (YouTube), or Vimeo's oEmbed answer that names it. */
function thumbnailRequest(v, bases) {
  var h = hostsOr(bases);
  if (!v) return null;
  if (v.host === "youtube" && YOUTUBE_ID_RE.test(v.id)) {
    return { kind: "image", url: h.youtubeThumbs + "/vi/" + v.id + "/hqdefault.jpg" };
  }
  if (v.host === "vimeo" && VIMEO_ID_RE.test(v.id)) {
    var page = "https://vimeo.com/" + v.id + (v.hash && VIMEO_HASH_RE.test(v.hash) ? "/" + v.hash : "");
    return { kind: "oembed", url: h.vimeoOembed + "/api/oembed.json?url=" + encodeURIComponent(page) + "&width=640" };
  }
  return null;
}

/* The picture an oEmbed answer names, if it is on Vimeo's image host and
   nowhere else; else null. */
function oembedThumbnailUrl(json, bases) {
  var h = hostsOr(bases);
  var raw = json && typeof json === "object" ? json.thumbnail_url : null;
  if (typeof raw !== "string" || raw.length > 2048) return null;
  var u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (u.username || u.password || u.protocol !== new URL(h.vimeoThumbs).protocol) return null;
  if (u.href.indexOf(h.vimeoThumbs + "/video/") !== 0) return null;
  return u.href;
}

/* Why these bytes may not be a thumbnail, or null when they may. */
function thumbnailRefusal(bytes) {
  if (!bytes || typeof bytes.length !== "number") return "NOT_AN_IMAGE";
  if (!bytes.length) return "EMPTY";
  if (bytes.length > THUMB_MAX_BYTES) return "TOO_LARGE";
  var mime = blobPolicy.sniffImageMime(bytes);
  if (!mime || THUMB_MIMES.indexOf(mime) === -1 || !blobPolicy.imageDims(bytes)) return "NOT_AN_IMAGE";
  return null;
}

function fail(code) { return { ok: false, code: code }; }

/* A response's body as bytes, stopping (and failing) past `cap` — read in
   pieces when the body is a stream, so a huge answer is never all held. */
function readCapped(res, cap) {
  var declared = Number(res.headers && res.headers.get ? res.headers.get("content-length") : NaN);
  if (declared > cap) {
    try { if (res.body && res.body.cancel) res.body.cancel(); } catch (e) { /* nothing to cancel */ }
    return Promise.resolve(null);
  }
  if (res.body && typeof res.body.getReader === "function") {
    var reader = res.body.getReader();
    var parts = [], total = 0;
    var pump = function () {
      return reader.read().then(function (r) {
        if (r.done) {
          var out = new Uint8Array(total), at = 0;
          parts.forEach(function (p) { out.set(p, at); at += p.length; });
          return out;
        }
        var chunk = r.value instanceof Uint8Array ? r.value : new Uint8Array(r.value);
        total += chunk.length;
        if (total > cap) { try { reader.cancel(); } catch (e) { /* done anyway */ } return null; }
        parts.push(chunk);
        return pump();
      });
    };
    return pump();
  }
  return res.arrayBuffer().then(function (buf) {
    return buf.byteLength > cap ? null : new Uint8Array(buf);
  });
}

/* One request to a fixed address: no cookies, no referrer, no redirects,
   a timeout. Resolves {res} or {code}. */
function request(fetchImpl, url, timeoutMs) {
  var ctl = typeof AbortController === "function" ? new AbortController() : null;
  var timedOut = false;
  var timer = setTimeout(function () { timedOut = true; if (ctl) ctl.abort(); }, timeoutMs);
  var init = { method: "GET", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" };
  if (ctl) init.signal = ctl.signal;
  var p;
  try { p = Promise.resolve(fetchImpl(url, init)); } catch (e) { p = Promise.reject(e); }
  return p.then(function (res) {
    clearTimeout(timer);
    if (!res || typeof res.status !== "number") return { code: "NETWORK" };
    if (res.status >= 300 && res.status < 400) return { code: "REDIRECT" };
    if (res.status === 404 || res.status === 410) return { code: "NOT_FOUND" };
    if (res.status === 403 || res.status === 401) return { code: "REFUSED" };
    if (res.status < 200 || res.status >= 300) return { code: "HTTP_" + res.status };
    return { res: res };
  }, function () {
    clearTimeout(timer);
    return { code: timedOut ? "TIMEOUT" : "NETWORK" };
  });
}

/* A video's thumbnail, fetched: resolves {ok: true, bytes, mime} or
   {ok: false, code}, and never rejects. opts: {fetch (required), bases?,
   timeoutMs?}. */
function fetchVideoThumbnail(v, opts) {
  opts = opts || {};
  var fetchImpl = opts.fetch;
  if (typeof fetchImpl !== "function") return Promise.resolve(fail("NO_FETCH"));
  var first = thumbnailRequest(v, opts.bases);
  if (!first) return Promise.resolve(fail("BAD_REF"));
  var timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : FETCH_TIMEOUT_MS;
  function image(url) {
    return request(fetchImpl, url, timeoutMs).then(function (r) {
      if (r.code) return fail(r.code);
      return readCapped(r.res, THUMB_MAX_BYTES).then(function (bytes) {
        if (!bytes) return fail("TOO_LARGE");
        var why = thumbnailRefusal(bytes);
        if (why) return fail(why);
        return { ok: true, bytes: bytes, mime: blobPolicy.sniffImageMime(bytes) };
      });
    }).then(null, function () { return fail("NETWORK"); });
  }
  if (first.kind === "image") return image(first.url);
  return request(fetchImpl, first.url, timeoutMs).then(function (r) {
    if (r.code) return fail(r.code);
    return readCapped(r.res, OEMBED_MAX_BYTES).then(function (bytes) {
      if (!bytes) return fail("BAD_OEMBED");
      var json;
      try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch (e) { return fail("BAD_OEMBED"); }
      var url = oembedThumbnailUrl(json, opts.bases);
      return url ? image(url) : fail("BAD_OEMBED");
    });
  }).then(null, function () { return fail("NETWORK"); });
}

module.exports = {
  FETCH_TIMEOUT_MS,
  PLAYER_ORIGINS,
  THUMB_MAX_BYTES,
  THUMB_MIMES,
  VIDEO_HOSTS,
  VIDEO_REF_RE,
  fetchVideoThumbnail,
  oembedThumbnailUrl,
  parseStart,
  parseVideoLink,
  parseVideoRef,
  playerUrl,
  thumbnailRefusal,
  thumbnailRequest,
  videoRef
};
