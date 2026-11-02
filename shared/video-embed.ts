"use strict";
/* global URL, AbortController, setTimeout, clearTimeout, TextDecoder */

import * as blobPolicy from "./blob-policy.ts";

type VideoEmbedReference = { host: "youtube" | "vimeo"; id: string; hash?: string; start?: number };
type VideoEmbedFields = Partial<Record<keyof VideoEmbedReference, unknown>>;
type VideoEmbedResponse = Pick<Response, "status" | "headers" | "body" | "arrayBuffer">;
type VideoEmbedFetch = (url: string, init: RequestInit) => VideoEmbedResponse | PromiseLike<VideoEmbedResponse>;
type VideoEmbedOptions = { fetch?: VideoEmbedFetch | null; bases?: object | null; timeoutMs?: number };
type VideoEmbedThumbnail = { ok: false; code: string } | {
  ok: true; bytes: Uint8Array; mime: NonNullable<ReturnType<typeof blobPolicy.sniffImageMime>>;
};
type VideoEmbedRequestCode = "NETWORK" | "REDIRECT" | "NOT_FOUND" | "REFUSED" | "TIMEOUT" | `HTTP_${string}`;
type VideoEmbedRequestResult = { code: VideoEmbedRequestCode; res?: undefined } | { code?: undefined; res: VideoEmbedResponse };

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID_RE = /^[0-9]{1,12}$/;
const VIMEO_HASH_RE = /^[0-9a-f]{6,32}$/;
const VIDEO_REF_RE = /^(?:[A-Za-z0-9_-]{11}|[0-9]{1,12}(?::[0-9a-f]{6,32})?)$/;

const THUMB_MAX_BYTES = 1024 * 1024;
const THUMB_MIMES = ["image/jpeg", "image/png", "image/webp"];
const OEMBED_MAX_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 8000;

const VIDEO_HOSTS = {
  youtubePlayer: "https://www.youtube-nocookie.com",
  youtubeThumbs: "https://i.ytimg.com",
  vimeoPlayer: "https://player.vimeo.com",
  vimeoOembed: "https://vimeo.com",
  vimeoThumbs: "https://i.vimeocdn.com"
};

const PLAYER_ORIGINS = [VIDEO_HOSTS.youtubePlayer, VIDEO_HOSTS.vimeoPlayer];

const YOUTUBE_HOST_RE = /^(?:www\.|m\.|music\.)?youtube\.com$|^(?:www\.)?youtube-nocookie\.com$/i;
const VIMEO_HOST_RE = /^(?:www\.)?vimeo\.com$/i;

function parseStart(v: unknown) {
  if (typeof v !== "string" || !v) return 0;
  const m = /^(?:(\d{1,2})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s?)?$/i.exec(v.trim());
  if (!m || !(m[1] || m[2] || m[3])) return 0;
  const s = (parseInt(m[1] || "0", 10) * 3600) + (parseInt(m[2] || "0", 10) * 60) + parseInt(m[3] || "0", 10);
  return s > 0 && s < 86400 ? s : 0;
}

function parseVideoLink(href: unknown): VideoEmbedReference | null {
  if (typeof href !== "string" || href.length > 2048) return null;
  let u: URL;
  try { u = new URL(href); } catch (e) { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  let id: string | null = null, m: RegExpExecArray | null;
  let out: VideoEmbedReference;
  if (host === "youtu.be") {
    m = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(path);
    id = m ? m[1] as string : null;
  } else if (YOUTUBE_HOST_RE.test(host)) {
    if (path === "/watch" || path === "/watch/") id = u.searchParams.get("v");
    else if ((m = /^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})\/?$/.exec(path))) id = m[1] as string;
  }
  if (id !== null) {
    if (!YOUTUBE_ID_RE.test(id)) return null;
    out = { host: "youtube", id: id };
    const start = parseStart(u.searchParams.get("t") || u.searchParams.get("start") || "");
    if (start) out.start = start;
    return out;
  }
  let hash: string | null = null;
  if (host === "player.vimeo.com") {
    m = /^\/video\/([0-9]{1,12})\/?$/.exec(path);
    if (m) { id = m[1] as string; hash = u.searchParams.get("h"); }
  } else if (VIMEO_HOST_RE.test(host)) {
    if ((m = /^\/(?:video\/)?([0-9]{1,12})(?:\/([0-9a-f]{6,32}))?\/?$/.exec(path))) { id = m[1] as string; hash = m[2] || u.searchParams.get("h"); }
    else if ((m = /^\/(?:channels\/[A-Za-z0-9_-]+|groups\/[A-Za-z0-9_-]+\/videos|album\/[0-9]+\/video|showcase\/[0-9]+\/video)\/([0-9]{1,12})\/?$/.exec(path))) id = m[1] as string;
  }
  if (id === null || !VIMEO_ID_RE.test(id)) return null;
  out = { host: "vimeo", id: id };
  if (hash) {
    if (!VIMEO_HASH_RE.test(hash)) return null;
    out.hash = hash;
  }
  const t = /(?:^|&)t=([0-9hms]+)/i.exec((u.hash || "").replace(/^#/, ""));
  const vs = t ? parseStart(t[1]) : 0;
  if (vs) out.start = vs;
  return out;
}

function videoRef(v: VideoEmbedReference | null | undefined) {
  if (!v) return "";
  return v.host === "vimeo" && v.hash ? v.id + ":" + v.hash : v.id;
}

function parseVideoRef(host: unknown, ref: unknown): VideoEmbedReference | null {
  if (typeof ref !== "string" || !VIDEO_REF_RE.test(ref)) return null;
  if (host === "youtube") return YOUTUBE_ID_RE.test(ref) ? { host: "youtube", id: ref } : null;
  if (host !== "vimeo") return null;
  const parts = ref.split(":");
  if (!VIMEO_ID_RE.test(parts[0] as string)) return null;
  const out: VideoEmbedReference = { host: "vimeo", id: parts[0] as string };
  if (parts[1]) out.hash = parts[1];
  return out;
}

function hostsOr(bases: object | null | undefined) {
  const out: Record<string, string> = {};
  Object.keys(VIDEO_HOSTS).forEach(function (k) {
    out[k] = bases && typeof (bases as Record<string, unknown>)[k] === "string" ? ((bases as Record<string, unknown>)[k] as string).replace(/\/+$/, "") : VIDEO_HOSTS[k as keyof typeof VIDEO_HOSTS];
  });
  return out as Record<keyof typeof VIDEO_HOSTS, string>;
}

function playerUrl(v: unknown, bases?: object | null) {
  if (!v) return null;
  const h = hostsOr(bases);
  if ((v as VideoEmbedFields).host === "youtube" && YOUTUBE_ID_RE.test((v as VideoEmbedFields).id as string)) {
    return h.youtubePlayer + "/embed/" + (v as VideoEmbedFields).id + "?autoplay=1&rel=0&playsinline=1" + ((v as VideoEmbedFields).start ? "&start=" + (v as VideoEmbedFields).start : "");
  }
  if ((v as VideoEmbedFields).host === "vimeo" && VIMEO_ID_RE.test((v as VideoEmbedFields).id as string)) {
    return h.vimeoPlayer + "/video/" + (v as VideoEmbedFields).id + "?autoplay=1&dnt=1" + ((v as VideoEmbedFields).hash && VIMEO_HASH_RE.test((v as VideoEmbedFields).hash as string) ? "&h=" + (v as VideoEmbedFields).hash : "") +
      ((v as VideoEmbedFields).start ? "#t=" + (v as VideoEmbedFields).start + "s" : "");
  }
  return null;
}

function thumbnailRequest(v: VideoEmbedReference | null | undefined, bases?: object | null) {
  const h = hostsOr(bases);
  if (!v) return null;
  if (v.host === "youtube" && YOUTUBE_ID_RE.test(v.id)) {
    return { kind: "image", url: h.youtubeThumbs + "/vi/" + v.id + "/hqdefault.jpg" };
  }
  if (v.host === "vimeo" && VIMEO_ID_RE.test(v.id)) {
    const page = "https://vimeo.com/" + v.id + (v.hash && VIMEO_HASH_RE.test(v.hash) ? "/" + v.hash : "");
    return { kind: "oembed", url: h.vimeoOembed + "/api/oembed.json?url=" + encodeURIComponent(page) + "&width=640" };
  }
  return null;
}

function oembedThumbnailUrl(json: unknown, bases?: object | null) {
  const h = hostsOr(bases);
  const raw = json && typeof json === "object" ? (json as Record<string, unknown>).thumbnail_url : null;
  if (typeof raw !== "string" || raw.length > 2048) return null;
  let u: URL;
  try { u = new URL(raw); } catch (e) { return null; }
  if (u.username || u.password || u.protocol !== new URL(h.vimeoThumbs).protocol) return null;
  if (u.href.indexOf(h.vimeoThumbs + "/video/") !== 0) return null;
  return u.href;
}

function thumbnailRefusal(bytes: unknown) {
  if (!bytes || typeof (bytes as ArrayLike<unknown>).length !== "number") return "NOT_AN_IMAGE";
  if (!(bytes as ArrayLike<unknown>).length) return "EMPTY";
  if ((bytes as ArrayLike<unknown>).length > THUMB_MAX_BYTES) return "TOO_LARGE";
  const mime = blobPolicy.sniffImageMime(bytes);
  if (!mime || THUMB_MIMES.indexOf(mime) === -1 || !blobPolicy.imageDims(bytes)) return "NOT_AN_IMAGE";
  return null;
}

function fail(code: string): Extract<VideoEmbedThumbnail, { ok: false }> { return { ok: false, code: code }; }

function readCapped(res: VideoEmbedResponse, cap: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers && res.headers.get ? res.headers.get("content-length") : NaN);
  if (declared > cap) {
    try { if (res.body && res.body.cancel) res.body.cancel(); } catch (e) { }
    return Promise.resolve(null);
  }
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    const pump = function (): Promise<Uint8Array | null> {
      return reader.read().then(function (r) {
        if (r.done) {
          const out = new Uint8Array(total);
          let at = 0;
          parts.forEach(function (p) { out.set(p, at); at += p.length; });
          return out;
        }
        const chunk = r.value instanceof Uint8Array ? r.value : new Uint8Array(r.value);
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

function request(fetchImpl: VideoEmbedFetch, url: string, timeoutMs: number | undefined): Promise<VideoEmbedRequestResult> {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  let timedOut = false;
  const timer = setTimeout(function () { timedOut = true; if (ctl) ctl.abort(); }, timeoutMs);
  const init: RequestInit = { method: "GET", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" };
  if (ctl) init.signal = ctl.signal;
  let p: Promise<VideoEmbedResponse>;
  try { p = Promise.resolve(fetchImpl(url, init)); } catch (e) { p = Promise.reject(e); }
  return p.then(function (res): VideoEmbedRequestResult {
    clearTimeout(timer);
    if (!res || typeof res.status !== "number") return { code: "NETWORK" };
    if (res.status >= 300 && res.status < 400) return { code: "REDIRECT" };
    if (res.status === 404 || res.status === 410) return { code: "NOT_FOUND" };
    if (res.status === 403 || res.status === 401) return { code: "REFUSED" };
    if (res.status < 200 || res.status >= 300) return { code: "HTTP_" + res.status as `HTTP_${string}` };
    return { res: res };
  }, function (): VideoEmbedRequestResult {
    clearTimeout(timer);
    return { code: timedOut ? "TIMEOUT" : "NETWORK" };
  });
}

function fetchVideoThumbnail(v: VideoEmbedReference | null | undefined, opts?: VideoEmbedOptions | null): Promise<VideoEmbedThumbnail> {
  opts = opts || {};
  const fetchImpl = opts.fetch;
  if (typeof fetchImpl !== "function") return Promise.resolve(fail("NO_FETCH"));
  const first = thumbnailRequest(v, opts.bases);
  if (!first) return Promise.resolve(fail("BAD_REF"));
  const timeoutMs = (opts.timeoutMs as number) > 0 ? opts.timeoutMs : FETCH_TIMEOUT_MS;
  function image(url: string): Promise<VideoEmbedThumbnail> {
    return request(fetchImpl as VideoEmbedFetch, url, timeoutMs).then(function (r) {
      if (r.code) return fail(r.code);
      return readCapped(r.res, THUMB_MAX_BYTES).then(function (bytes): VideoEmbedThumbnail {
        if (!bytes) return fail("TOO_LARGE");
        const why = thumbnailRefusal(bytes);
        if (why) return fail(why);
        return { ok: true, bytes: bytes, mime: blobPolicy.sniffImageMime(bytes) as NonNullable<ReturnType<typeof blobPolicy.sniffImageMime>> };
      });
    }).then(null, function () { return fail("NETWORK"); });
  }
  if (first.kind === "image") return image(first.url);
  return request(fetchImpl, first.url, timeoutMs).then(function (r) {
    if (r.code) return fail(r.code);
    return readCapped(r.res, OEMBED_MAX_BYTES).then(function (bytes) {
      if (!bytes) return fail("BAD_OEMBED");
      let json: unknown;
      try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch (e) { return fail("BAD_OEMBED"); }
      const url = oembedThumbnailUrl(json, opts.bases);
      return url ? image(url) : fail("BAD_OEMBED");
    });
  }).then(null, function () { return fail("NETWORK"); });
}

function embeddableVideo(link: unknown) {
  return link && (link as Record<string, unknown>).href ? parseVideoLink((link as Record<string, unknown>).href) : null;
}

export {
  FETCH_TIMEOUT_MS,
  PLAYER_ORIGINS,
  THUMB_MAX_BYTES,
  THUMB_MIMES,
  VIDEO_HOSTS,
  VIDEO_REF_RE,
  embeddableVideo,
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
