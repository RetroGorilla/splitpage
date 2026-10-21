import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { S } from "../js/_state.js";
import { SETTINGS_APPDATA_PREFS, VIDEO_THUMBS_KEY, videoThumbsOn } from "../js/00p-prefs.js";
import { migrateRows } from "../js/02-state.js";
import { intern } from "../adapters/storage/02c-blobs.js";
import { addGalleryPicture, addGalleryVideo, setVideoThumbnail, videoLinkKey } from "../adapters/storage/02d-gallery.js";
import { flushEdits, foldIntoEdit, lastUndoEntry, noteEdit, redo, resetUndo, trackDocument, undo, undoSizes } from "../js/12a-undo.js";
import videoEmbed from "../../shared/video-embed.js";

const {
  PLAYER_ORIGINS, THUMB_MAX_BYTES, VIDEO_HOSTS, fetchVideoThumbnail, oembedThumbnailUrl, parseStart,
  parseVideoLink, parseVideoRef, playerUrl, thumbnailRefusal, videoRef
} = videoEmbed;

const jpegBytes = (w, h, salt) => new Uint8Array([0xFF, 0xD8, 0xFF, 0xC0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, salt || 0, 0xFF, 0xD9]);
function pngBytes(w, h) {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  b.set([w >>> 24, (w >> 16) & 255, (w >> 8) & 255, w & 255, h >>> 24, (h >> 16) & 255, (h >> 8) & 255, h & 255], 16);
  return b;
}
const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 4, 0, 3, 0, 0, 0, 0]);

test("a YouTube link in any of its spellings is its 11-character id, with a start time when it has one", () => {
  const id = "dQw4w9WgXcQ";
  for (const href of [
    "https://www.youtube.com/watch?v=" + id,
    "https://youtube.com/watch?v=" + id + "&list=PL123",
    "https://m.youtube.com/watch?v=" + id,
    "https://music.youtube.com/watch?v=" + id,
    "https://youtu.be/" + id,
    "https://www.youtube.com/shorts/" + id,
    "https://www.youtube.com/embed/" + id,
    "https://www.youtube-nocookie.com/embed/" + id,
    "https://www.youtube.com/live/" + id,
    "http://www.youtube.com/watch?v=" + id
  ]) {
    assert.deepEqual(parseVideoLink(href), { host: "youtube", id }, href);
  }
  assert.deepEqual(parseVideoLink("https://youtu.be/" + id + "?t=90"), { host: "youtube", id, start: 90 });
  assert.deepEqual(parseVideoLink("https://www.youtube.com/watch?v=" + id + "&t=1m30s"), { host: "youtube", id, start: 90 });
  assert.equal(parseStart("1h2m3s"), 3723);
  assert.equal(parseStart("nonsense"), 0);
});

test("a Vimeo link is its numeric id, with an unlisted video's hash", () => {
  assert.deepEqual(parseVideoLink("https://vimeo.com/76979871"), { host: "vimeo", id: "76979871" });
  assert.deepEqual(parseVideoLink("https://www.vimeo.com/76979871/"), { host: "vimeo", id: "76979871" });
  assert.deepEqual(parseVideoLink("https://vimeo.com/76979871/abcdef1234"), { host: "vimeo", id: "76979871", hash: "abcdef1234" });
  assert.deepEqual(parseVideoLink("https://player.vimeo.com/video/76979871?h=abcdef1234"), { host: "vimeo", id: "76979871", hash: "abcdef1234" });
  assert.deepEqual(parseVideoLink("https://vimeo.com/channels/staffpicks/76979871"), { host: "vimeo", id: "76979871" });
  assert.deepEqual(parseVideoLink("https://vimeo.com/groups/shortfilms/videos/76979871"), { host: "vimeo", id: "76979871" });
  assert.deepEqual(parseVideoLink("https://vimeo.com/76979871#t=45s"), { host: "vimeo", id: "76979871", start: 45 });
});

test("anything else is not one: other sites, playlists and channels, ids of the wrong shape, other schemes", () => {
  for (const href of [
    "https://www.loom.com/share/abc", "https://example.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/playlist?list=PL123", "https://www.youtube.com/@channel",
    "https://www.youtube.com/watch?v=short", "https://youtu.be/second", "https://youtu.be/abc123",
    "https://vimeo.com/channels/staffpicks", "https://vimeo.com/1234567890123", "https://vimeo.com/123/NOTHEX",
    "https://evil.example/youtube.com/watch?v=dQw4w9WgXcQ", "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
    "javascript:alert(1)", "ftp://youtu.be/dQw4w9WgXcQ", "", null, 42
  ]) {
    assert.equal(parseVideoLink(href), null, String(href));
  }
});

test("the player: YouTube's no-cookie embed and Vimeo's player with dnt=1, both starting at once", () => {
  assert.equal(playerUrl({ host: "youtube", id: "dQw4w9WgXcQ" }),
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&playsinline=1");
  assert.equal(playerUrl({ host: "youtube", id: "dQw4w9WgXcQ", start: 90 }),
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&playsinline=1&start=90");
  assert.equal(playerUrl({ host: "vimeo", id: "76979871" }), "https://player.vimeo.com/video/76979871?autoplay=1&dnt=1");
  assert.equal(playerUrl({ host: "vimeo", id: "76979871", hash: "abcdef1234", start: 45 }),
    "https://player.vimeo.com/video/76979871?autoplay=1&dnt=1&h=abcdef1234#t=45s");
  assert.equal(playerUrl({ host: "youtube", id: "../../x" }), null);
  assert.equal(playerUrl({ host: "loom", id: "abc" }), null);
  for (const u of [playerUrl({ host: "youtube", id: "dQw4w9WgXcQ" }), playerUrl({ host: "vimeo", id: "1" })]) {
    assert.ok(PLAYER_ORIGINS.includes(new URL(u).origin), u);
  }
});

test("build.mjs's frame-src is 'self' and exactly the two player origins", () => {
  const src = readFileSync(new URL("../../build.mjs", import.meta.url), "utf8");
  const m = /"frame-src ([^"]*)"/.exec(src);
  assert.ok(m, "frame-src is in CSP_DIRECTIVES");
  assert.deepEqual(m[1].split(/\s+/).sort(), ["'self'"].concat(PLAYER_ORIGINS).sort());
  assert.match(src, /"img-src 'self' data: blob:"/);
});

test("the ref the desktop IPC carries, and its check against the host", () => {
  assert.equal(videoRef({ host: "youtube", id: "dQw4w9WgXcQ" }), "dQw4w9WgXcQ");
  assert.equal(videoRef({ host: "vimeo", id: "76979871", hash: "abcdef1234" }), "76979871:abcdef1234");
  assert.deepEqual(parseVideoRef("youtube", "dQw4w9WgXcQ"), { host: "youtube", id: "dQw4w9WgXcQ" });
  assert.deepEqual(parseVideoRef("vimeo", "76979871:abcdef1234"), { host: "vimeo", id: "76979871", hash: "abcdef1234" });
  assert.equal(parseVideoRef("vimeo", "dQw4w9WgXcQ"), null);
  assert.equal(parseVideoRef("youtube", "76979871"), null);
  assert.equal(parseVideoRef("loom", "76979871"), null);
  for (const bad of ["https://i.ytimg.com/vi/x", "../etc", "", "a".repeat(12), "1:ZZZZZZ", null]) {
    assert.equal(parseVideoRef("youtube", bad), null, String(bad));
    assert.equal(parseVideoRef("vimeo", bad), null, String(bad));
  }
});

function fakeFetch(routes) {
  const calls = [];
  const fn = (url, init) => {
    calls.push({ url, init });
    const r = routes[url];
    if (typeof r === "function") return r(init);
    if (!r) return Promise.resolve(new Response("nope", { status: 404 }));
    return Promise.resolve(new Response(r.body, { status: r.status || 200, headers: r.headers || {} }));
  };
  fn.calls = calls;
  return fn;
}

test("YouTube: hqdefault from i.ytimg.com, with no cookies, referrer or redirects", async () => {
  const jpg = jpegBytes(480, 360, 7);
  const f = fakeFetch({ "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg": { body: jpg } });
  const got = await fetchVideoThumbnail({ host: "youtube", id: "dQw4w9WgXcQ" }, { fetch: f });
  assert.equal(got.ok, true);
  assert.equal(got.mime, "image/jpeg");
  assert.deepEqual([...got.bytes], [...jpg]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.redirect, "error");
  assert.equal(f.calls[0].init.credentials, "omit");
  assert.equal(f.calls[0].init.referrerPolicy, "no-referrer");
});

test("what a thumbnail may be: JPEG, PNG or WebP, at most 1 MiB, sniffed from the bytes", async () => {
  const url = "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg";
  const v = { host: "youtube", id: "dQw4w9WgXcQ" };
  let got = await fetchVideoThumbnail(v, { fetch: fakeFetch({ [url]: { body: pngBytes(4, 3), headers: { "content-type": "image/jpeg" } } }) });
  assert.equal(got.ok, true);
  assert.equal(got.mime, "image/png");
  got = await fetchVideoThumbnail(v, { fetch: fakeFetch({ [url]: { body: gifBytes } }) });
  assert.deepEqual(got, { ok: false, code: "NOT_AN_IMAGE" });
  got = await fetchVideoThumbnail(v, { fetch: fakeFetch({ [url]: { body: "<svg xmlns='http://www.w3.org/2000/svg'/>", headers: { "content-type": "image/svg+xml" } } }) });
  assert.deepEqual(got, { ok: false, code: "NOT_AN_IMAGE" });
  got = await fetchVideoThumbnail(v, { fetch: fakeFetch({ [url]: { body: "x", headers: { "content-length": String(THUMB_MAX_BYTES + 1) } } }) });
  assert.deepEqual(got, { ok: false, code: "TOO_LARGE" });
  const big = new Uint8Array(THUMB_MAX_BYTES + 10);
  big.set(jpegBytes(480, 360, 1));
  got = await fetchVideoThumbnail(v, { fetch: fakeFetch({ [url]: { body: big } }) });
  assert.deepEqual(got, { ok: false, code: "TOO_LARGE" });
  assert.equal(thumbnailRefusal(new Uint8Array(0)), "EMPTY");
});

test("a failure is a code, never a rejection: gone, refused, redirected, offline, slow", async () => {
  const url = "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg";
  const v = { host: "youtube", id: "dQw4w9WgXcQ" };
  const code = async (route, opts) => (await fetchVideoThumbnail(v, Object.assign({ fetch: fakeFetch({ [url]: route }) }, opts))).code;
  assert.equal(await code({ status: 404, body: jpegBytes(120, 90) }), "NOT_FOUND");
  assert.equal(await code({ status: 403, body: "" }), "REFUSED");
  assert.equal(await code({ status: 302, body: "", headers: { location: "https://elsewhere.example/x.jpg" } }), "REDIRECT");
  assert.equal(await code({ status: 500, body: "" }), "HTTP_500");
  assert.equal(await code(() => Promise.reject(new TypeError("Failed to fetch"))), "NETWORK");
  assert.equal(await code((init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
  }), { timeoutMs: 30 }), "TIMEOUT");
  assert.equal((await fetchVideoThumbnail({ host: "youtube", id: "nope" }, { fetch: fakeFetch({}) })).code, "BAD_REF");
  assert.equal((await fetchVideoThumbnail({ host: "youtube", id: "dQw4w9WgXcQ" }, {})).code, "NO_FETCH");
});

test("Vimeo: the oEmbed answer's thumbnail, and only from Vimeo's image host", async () => {
  const oembed = "https://vimeo.com/api/oembed.json?url=" + encodeURIComponent("https://vimeo.com/76979871") + "&width=640";
  const thumb = "https://i.vimeocdn.com/video/145027281-abc-d_640?region=us";
  const jpg = jpegBytes(640, 360, 9);
  let f = fakeFetch({ [oembed]: { body: JSON.stringify({ thumbnail_url: thumb }) }, [thumb]: { body: jpg } });
  let got = await fetchVideoThumbnail({ host: "vimeo", id: "76979871" }, { fetch: f });
  assert.equal(got.ok, true);
  assert.deepEqual(f.calls.map((c) => c.url), [oembed, thumb]);
  const hashed = "https://vimeo.com/api/oembed.json?url=" + encodeURIComponent("https://vimeo.com/76979871/abcdef1234") + "&width=640";
  f = fakeFetch({ [hashed]: { body: JSON.stringify({ thumbnail_url: thumb }) }, [thumb]: { body: jpg } });
  got = await fetchVideoThumbnail({ host: "vimeo", id: "76979871", hash: "abcdef1234" }, { fetch: f });
  assert.equal(got.ok, true);
  for (const other of ["https://evil.example/video/1.jpg", "http://i.vimeocdn.com/video/1.jpg", "https://i.vimeocdn.com.evil.example/video/1.jpg",
    "https://user:pw@i.vimeocdn.com/video/1.jpg", "https://i.vimeocdn.com/other/1.jpg", 42]) {
    f = fakeFetch({ [oembed]: { body: JSON.stringify({ thumbnail_url: other }) } });
    got = await fetchVideoThumbnail({ host: "vimeo", id: "76979871" }, { fetch: f });
    assert.deepEqual(got, { ok: false, code: "BAD_OEMBED" }, String(other));
    assert.equal(f.calls.length, 1, String(other));
  }
  f = fakeFetch({ [oembed]: { body: "not json" } });
  assert.equal((await fetchVideoThumbnail({ host: "vimeo", id: "76979871" }, { fetch: f })).code, "BAD_OEMBED");
  assert.equal(oembedThumbnailUrl({ thumbnail_url: thumb }), thumb);
});

test("a fake host stands in for all five, as the suites and the desktop's test mode use it", async () => {
  const base = "http://127.0.0.1:9";
  const bases = {};
  for (const k of Object.keys(VIDEO_HOSTS)) bases[k] = base + "/" + k;
  const jpg = jpegBytes(480, 360, 3);
  const f = fakeFetch({ [base + "/youtubeThumbs/vi/dQw4w9WgXcQ/hqdefault.jpg"]: { body: jpg } });
  assert.equal((await fetchVideoThumbnail({ host: "youtube", id: "dQw4w9WgXcQ" }, { fetch: f, bases })).ok, true);
  assert.equal(playerUrl({ host: "vimeo", id: "5" }, bases), base + "/vimeoPlayer/video/5?autoplay=1&dnt=1");
  assert.equal(oembedThumbnailUrl({ thumbnail_url: base + "/vimeoThumbs/video/1.jpg" }, bases), base + "/vimeoThumbs/video/1.jpg");
  assert.equal(oembedThumbnailUrl({ thumbnail_url: "https://i.vimeocdn.com/video/1.jpg" }, bases), null);
});

test("Settings ▸ Fetch video thumbnails: on unless switched off, and carried by Export app data", () => {
  localStorage.removeItem(VIDEO_THUMBS_KEY);
  assert.equal(videoThumbsOn(), true);
  localStorage.setItem(VIDEO_THUMBS_KEY, "0");
  assert.equal(videoThumbsOn(), false);
  localStorage.setItem(VIDEO_THUMBS_KEY, "1");
  assert.equal(videoThumbsOn(), true);
  localStorage.removeItem(VIDEO_THUMBS_KEY);
  const row = SETTINGS_APPDATA_PREFS.filter((p) => p.key === VIDEO_THUMBS_KEY)[0];
  assert.ok(row, "in the bundle's prefs");
  assert.equal(row.valid("0"), true);
  assert.equal(row.valid("1"), true);
  assert.equal(row.valid("off"), false);
  assert.doesNotMatch(row.name, /token|api[-_]?key|client[-_]?id|secret|password|\bpin\b/i);
});

const T1 = intern(jpegBytes(480, 270, 11));
const T2 = intern(jpegBytes(480, 270, 12));
const P1 = intern(jpegBytes(300, 200, 13));

test("setVideoThumbnail gives a video with no picture its thumbnail, once, first slot or later", () => {
  const row = { id: "r1", imageRef: null };
  addGalleryVideo(row, { href: "https://youtu.be/dQw4w9WgXcQ" });
  addGalleryPicture(row, P1);
  addGalleryVideo(row, { href: "https://vimeo.com/76979871" });
  const yt = videoLinkKey({ href: "https://youtu.be/dQw4w9WgXcQ" });
  const vm = videoLinkKey({ href: "https://vimeo.com/76979871" });
  assert.equal(setVideoThumbnail(row, yt, T1), true);
  assert.equal(row.imageRef.sha256, T1.sha256);
  assert.deepEqual(row.imageLinks, [{ href: "https://youtu.be/dQw4w9WgXcQ", poster: true }]);
  assert.equal(setVideoThumbnail(row, yt, T2), false);
  assert.equal(row.imageRef.sha256, T1.sha256);
  assert.equal(setVideoThumbnail(row, vm, T1), false);
  assert.equal(setVideoThumbnail(row, vm, T2), true);
  assert.equal(row.moreImages[1].imageRef.sha256, T2.sha256);
  assert.equal(row.moreImages[1].links[0].href, "https://vimeo.com/76979871");
  assert.equal(setVideoThumbnail(row, "u:https://nowhere.example/", T2), false);
});

function freshDoc() {
  S.state = migrateRows({ schema: 2, title: "Fold", comments: [], rows: [
    { id: "r1", visualText: "one", audioText: "Alpha", status: "todo" },
    { id: "r2", visualText: "two", audioText: "Bravo", status: "todo" }
  ] });
  resetUndo();
  trackDocument();
}

function edit(fn) {
  fn(S.state);
  noteEdit();
  flushEdits();
  return lastUndoEntry();
}

const ytKey = videoLinkKey({ href: "https://youtu.be/dQw4w9WgXcQ" });
const touchesR1 = (s) => s.op === "rowField" && s.rowId === "r1" && /^(imageRef|imageLinks|moreImages|imageName)$/.test(s.key);
const giveThumb = (ref) => (state) => setVideoThumbnail(state.rows[0], ytKey, ref);

test("the thumbnail lands in the paste's own entry: one undo takes both back, one redo brings both", () => {
  freshDoc();
  const entry = edit((s) => { s.rows[0].audioText = "Alpha pasted"; addGalleryVideo(s.rows[0], { href: "https://youtu.be/dQw4w9WgXcQ" }); });
  edit((s) => { s.rows[1].audioText = "Bravo typed"; });
  const sizes = undoSizes();
  assert.equal(foldIntoEdit(entry, touchesR1, giveThumb(T1)), true);
  noteEdit();
  flushEdits();
  assert.deepEqual(undoSizes(), sizes, "no entry of its own");
  assert.equal(S.state.rows[0].imageRef.sha256, T1.sha256);
  undo();
  assert.equal(S.state.rows[1].audioText, "Bravo");
  undo();
  assert.equal(S.state.rows[0].imageRef, null);
  assert.equal(S.state.rows[0].imageLinks, undefined);
  assert.equal(S.state.rows[0].audioText, "Alpha");
  redo();
  assert.equal(S.state.rows[0].imageRef.sha256, T1.sha256);
  assert.equal(S.state.rows[0].imageLinks[0].href, "https://youtu.be/dQw4w9WgXcQ");
});

test("nothing lands when something since is about the gallery, or the paste was undone", () => {
  freshDoc();
  let entry = edit((s) => { addGalleryVideo(s.rows[0], { href: "https://youtu.be/dQw4w9WgXcQ" }); });
  edit((s) => { addGalleryPicture(s.rows[0], P1); });
  assert.equal(foldIntoEdit(entry, touchesR1, giveThumb(T1)), false);
  assert.equal(S.state.rows[0].imageRef, null);

  freshDoc();
  entry = edit((s) => { addGalleryVideo(s.rows[0], { href: "https://youtu.be/dQw4w9WgXcQ" }); });
  undo();
  assert.equal(foldIntoEdit(entry, touchesR1, giveThumb(T1)), false);
  assert.equal(S.state.rows[0].imageLinks, undefined);
});

test("with no entry about it at all (the stack was cleared), it is taken in without one", () => {
  freshDoc();
  edit((s) => { addGalleryVideo(s.rows[0], { href: "https://youtu.be/dQw4w9WgXcQ" }); });
  resetUndo();
  trackDocument();
  assert.equal(foldIntoEdit(null, touchesR1, giveThumb(T1)), true);
  noteEdit();
  flushEdits();
  assert.deepEqual(undoSizes(), { undo: 0, redo: 0 });
  assert.equal(S.state.rows[0].imageRef.sha256, T1.sha256);
});
