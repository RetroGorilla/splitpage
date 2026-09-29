"use strict";
/* global URL, AbortController, setTimeout, clearTimeout, TextDecoder */

var blobPolicy = require("./blob-policy.js");

var YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
var VIMEO_ID_RE = /^[0-9]{1,12}$/;
var VIMEO_HASH_RE = /^[0-9a-f]{6,32}$/;
var VIDEO_REF_RE = /^(?:[A-Za-z0-9_-]{11}|[0-9]{1,12}(?::[0-9a-f]{6,32})?)$/;

var THUMB_MAX_BYTES = 1024 * 1024;
var THUMB_MIMES = ["image/jpeg", "image/png", "image/webp"];
var OEMBED_MAX_BYTES = 64 * 1024;
var FETCH_TIMEOUT_MS = 8000;

var VIDEO_HOSTS = {
  youtubePlayer: "https://www.youtube-nocookie.com",
  youtubeThumbs: "https://i.ytimg.com",
  vimeoPlayer: "https://player.vimeo.com",
  vimeoOembed: "https://vimeo.com",
  vimeoThumbs: "https://i.vimeocdn.com"
};

var PLAYER_ORIGINS = [VIDEO_HOSTS.youtubePlayer, VIDEO_HOSTS.vimeoPlayer];

var YOUTUBE_HOST_RE = /^(?:www\.|m\.|music\.)?youtube\.com$|^(?:www\.)?youtube-nocookie\.com$/i;
var VIMEO_HOST_RE = /^(?:www\.)?vimeo\.com$/i;

function parseStart(v) {
  if (typeof v !== "string" || !v) return 0;
  var m = /^(?:(\d{1,2})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s?)?$/i.exec(v.trim());
  if (!m || !(m[1] || m[2] || m[3])) return 0;
  var s = (parseInt(m[1] || "0", 10) * 3600) + (parseInt(m[2] || "0", 10) * 60) + parseInt(m[3] || "0", 10);
  return s > 0 && s < 86400 ? s : 0;
}

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

function thumbnailRefusal(bytes) {
  if (!bytes || typeof bytes.length !== "number") return "NOT_AN_IMAGE";
  if (!bytes.length) return "EMPTY";
  if (bytes.length > THUMB_MAX_BYTES) return "TOO_LARGE";
  var mime = blobPolicy.sniffImageMime(bytes);
  if (!mime || THUMB_MIMES.indexOf(mime) === -1 || !blobPolicy.imageDims(bytes)) return "NOT_AN_IMAGE";
  return null;
}

function fail(code) { return { ok: false, code: code }; }

function readCapped(res, cap) {
  var declared = Number(res.headers && res.headers.get ? res.headers.get("content-length") : NaN);
  if (declared > cap) {
    try { if (res.body && res.body.cancel) res.body.cancel(); } catch (e) { }
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
        if (total > cap) { try { reader.cancel(); } catch (e) { } return null; }
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
