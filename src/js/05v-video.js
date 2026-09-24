import { S } from "./_state.js";
import { videoThumbsOn } from "./00p-prefs.js";
import { intern, persist } from "./02c-blobs.js";
import { normalizeVideoLink, setVideoThumbnail, videoLinkKey } from "./02d-gallery.js";
import { findRowIndex, stampRow } from "./03-sync.js";
import { render, renderRow } from "./05-render.js";
import { markDirty } from "./12-dirty-toast.js";
import { foldIntoEdit } from "./12a-undo.js";
import { fetchVideoThumbnail, parseVideoLink, playerUrl, videoRef } from "../../shared/video-embed.js";

/* ================= YouTube and Vimeo in a scene's gallery (#141, #168) =================

   Two things, both about the two hosts shared/video-embed.js knows and no
   others (Loom, Wistia and the rest stay links):

   THE THUMBNAIL (#141). A YouTube or Vimeo link pasted or dropped into a
   scene becomes a video item with a placeholder (05c-clipboard.js,
   02d-gallery.js). Unless Settings ▸ Fetch video thumbnails is off, the
   video's own thumbnail is then fetched ONCE and its bytes put in the
   image registry (02c-blobs.js, #82) as that item's picture, like any
   pasted picture: it is in the file, the exports, the server's blob store
   and version history, and it works offline — the page never shows a
   picture from the web, and the policy's img-src names no remote host.
   The browser build asks the hosts directly (they answer with CORS
   headers, and connect-src already allows https:); the desktop app asks
   main (the bridge's videoThumbnail, which takes a host name and a video
   id and nothing else, main.js § 9e). A fetch that fails leaves the
   placeholder and says nothing; the gallery's dialog offers "Retry
   thumbnail". The picture lands in the paste's own undo entry
   (foldIntoEdit, 12a-undo.js): Ctrl+Z takes the video and its picture
   back together, and no step of its own is added.

   THE PLAYER (#168). The gallery's dialog (05e-gallery-overlay.js) plays
   such a link in its large preview — only there, never in the script's
   tiles, and only once the play button is pressed: until then nothing is
   asked of YouTube or Vimeo. YouTube plays through its no-cookie embed,
   Vimeo through its player with dnt=1 (playerSrc). The page's policy
   allows exactly those two frame origins (build.mjs). YouTube refuses to
   play in a page that sends no referrer — a copy opened from disk
   (file://) — so there the dialog says so and offers Open link instead
   of a frame that would only show an error (embedRefusal). The desktop
   app's own address sends none either; main adds one for YouTube's player
   request alone (main.js § 10b).

   The test suites run with no network: under the harness
   (window.__splitpageNoRemote, set by the drivers) nothing here reaches a
   real host — a thumbnail fetch fails at once, and a player frame loads
   about:blank with the address it would have loaded in data-src — unless
   the suite installs its own fake (window.__videoTest). */

var testHooks = { fetch: null, bases: null, protocol: null };

function noRemote() {
  return !!window.__splitpageNoRemote;
}

/* The link as {host, id, …} when it is a YouTube or Vimeo video; else null. */
export function embeddableVideo(link) {
  return link && link.href ? parseVideoLink(link.href) : null;
}

/* Why this page cannot play `v` in a frame, as words for the dialog, or
   "" when it can. */
export function embedRefusal(v) {
  if (!v) return "";
  var protocol = testHooks.protocol || location.protocol;
  if (v.host === "youtube" && (protocol === "file:" || protocol === "data:")) {
    return "YouTube won’t play in a copy of Splitpage opened from a file.";
  }
  return "";
}

/* The frame's address: the player, or about:blank under the harness. */
export function playerSrc(v) {
  var real = playerUrl(v, testHooks.bases);
  if (!real) return null;
  return { src: noRemote() && !testHooks.bases ? "about:blank" : real, real: real };
}

/* ---- thumbnails ---- */

/* A YouTube hqdefault is 4:3 with black bands above and below a 16:9
   picture; those are cut off, so the still fills the gallery's 16:9 tiles
   the way the video does. Anything else, or anything this cannot decode,
   is kept exactly as fetched. */
function trimLetterbox(bytes, mime) {
  return new Promise(function (resolve) {
    var url;
    try { url = URL.createObjectURL(new Blob([bytes], { type: mime })); } catch (e) { resolve(bytes); return; }
    var img = new Image();
    function done(out) { try { URL.revokeObjectURL(url); } catch (e) { /* gone */ } resolve(out || bytes); }
    img.onerror = function () { done(null); };
    img.onload = function () {
      try {
        var w = img.naturalWidth, h = img.naturalHeight;
        var band = Math.round((h - w * 9 / 16) / 2);
        if (!w || !h || Math.abs(w * 3 - h * 4) > 4 || band < 16) { done(null); return; }
        var c = document.createElement("canvas");
        c.width = w; c.height = h;
        var g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        /* the bands, less the rows next to the picture that JPEG's 8px
           blocks smear it into */
        var top = g.getImageData(0, 0, w, band - 8).data, bottom = g.getImageData(0, h - band + 8, w, band - 8).data;
        if (!allDark(top) || !allDark(bottom)) { done(null); return; }
        var out = document.createElement("canvas");
        out.width = w; out.height = h - band * 2;
        out.getContext("2d").drawImage(c, 0, band, w, out.height, 0, 0, w, out.height);
        out.toBlob(function (blob) {
          if (!blob) { done(null); return; }
          blob.arrayBuffer().then(function (buf) { done(new Uint8Array(buf)); }, function () { done(null); });
        }, "image/jpeg", 0.88);
      } catch (e) { done(null); }
    };
    img.src = url;
  });
}

function allDark(px) {
  var light = 0;
  for (var i = 0; i < px.length; i += 4) {
    if (px[i] > 28 || px[i + 1] > 28 || px[i + 2] > 28) light++;
  }
  return light <= (px.length / 4) * 0.01;
}

/* Whether a thumbnail may be asked for at all right now. */
export function thumbnailsAllowed() {
  return videoThumbsOn();
}

/* A video link's thumbnail, fetched and put in the registry: a promise of
   its record, or null (never a rejection) — not YouTube or Vimeo, the
   setting off, offline, a removed video, anything refused. */
export function fetchThumbnailRecord(href) {
  var v = parseVideoLink(href);
  if (!v) return Promise.resolve(null);
  var got;
  if (S.DESKTOP) {
    if (typeof S.DESKTOP.videoThumbnail !== "function") return Promise.resolve(null);
    try { got = Promise.resolve(S.DESKTOP.videoThumbnail(v.host, videoRef(v))); } catch (e) { return Promise.resolve(null); }
  } else {
    var f = testHooks.fetch || (noRemote() ? null : (typeof fetch === "function" ? fetch.bind(window) : null));
    if (!f) return Promise.resolve(null);
    got = fetchVideoThumbnail(v, { fetch: f, bases: testHooks.bases });
  }
  return got.then(function (res) {
    if (!res || !res.ok || !res.bytes) return null;
    var bytes = res.bytes instanceof Uint8Array ? res.bytes : new Uint8Array(res.bytes);
    return (v.host === "youtube" ? trimLetterbox(bytes, res.mime || "image/jpeg") : Promise.resolve(bytes)).then(function (b) {
      var rec = intern(b) || intern(bytes);
      if (rec) persist([rec.sha256]);
      return rec || null;
    });
  }).then(null, function () { return null; });
}

/* The scene's gallery keys, and the steps that are about them: what a
   thumbnail folded into a paste may not be folded past. */
var GALLERY_KEYS = { imageRef: true, imageLinks: true, moreImages: true, imageName: true };

function touchesGallery(rowId) {
  return function (s) {
    if (s.op === "rowField") return s.rowId === rowId && !!GALLERY_KEYS[s.key];
    if (s.op === "insertRow" || s.op === "deleteRow") return !!(s.row && s.row.id === rowId);
    return false;
  };
}

/* After a paste or a drop put YouTube or Vimeo links in scene `rowId`'s
   gallery (21-events.js): fetch each one's thumbnail and, when it comes,
   fold it into `entry` — the paste's own undo entry — or leave the
   placeholder when something since makes that impossible (the paste
   undone, the gallery edited again, another document open). */
export function thumbnailsAfterPaste(rowId, hrefs, entry) {
  if (!S.state || !hrefs || !hrefs.length || !thumbnailsAllowed()) return;
  var docId = S.state.docId;
  hrefs.forEach(function (href) {
    var link = normalizeVideoLink({ href: href });
    if (!link || !parseVideoLink(link.href)) return;
    var key = videoLinkKey(link);
    fetchThumbnailRecord(link.href).then(function (rec) {
      if (!rec || !S.state || S.state.docId !== docId || findRowIndex(rowId) === -1) return;
      var done = foldIntoEdit(entry, touchesGallery(rowId), function (state) {
        var idx = findRowIndex(rowId);
        return idx !== -1 && setVideoThumbnail(state.rows[idx], key, rec);
      });
      if (!done) return;
      stampRow(S.state.rows[findRowIndex(rowId)]);
      markDirty();
      if (!renderRow(rowId)) render();
    });
  });
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order. */
export function __init() {
  /* For the browser suites: a fake host in place of the network. Nothing
     in the app reads it. */
  window.__videoTest = {
    setFetch: function (fn) { testHooks.fetch = typeof fn === "function" ? fn : null; },
    setBases: function (b) { testHooks.bases = b && typeof b === "object" ? b : null; },
    setProtocol: function (p) { testHooks.protocol = typeof p === "string" ? p : null; },
    fetchThumbnail: fetchThumbnailRecord,
    parse: parseVideoLink
  };
}
