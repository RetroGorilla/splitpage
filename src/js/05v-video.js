import { S } from "./_state.js";
import { intern, persist } from "../adapters/storage/02c-blobs.js";
import { rowIndexOf } from "../core/document/rows.ts";
import { readSession } from "../legacy/session-bridge.ts";
import { render, renderRow } from "./05-render.js";
import { foldIntoEdit } from "./12a-undo.js";
import { fetchVideoThumbnail, parseVideoLink, playerUrl, videoRef } from "../../shared/video-embed.js";
import { normalizeVideoLink, setVideoThumbnail, videoLinkKey } from "../core/document/gallery.ts";
import { captureOperation, stillOwns } from "../legacy/transition-bridge.ts";
import { desktopPort } from "../adapters/desktop/desktop-port.ts";
import { runningOnDesktop } from "../application/desktop-presence.ts";
import { preferences } from "../legacy/preferences-bridge.ts";

var testHooks = { fetch: null, bases: null, protocol: null };

function noRemote() {
  return !!window.__splitpageNoRemote;
}

export function embedRefusal(v) {
  if (!v) return "";
  var protocol = testHooks.protocol || location.protocol;
  if (v.host === "youtube" && (protocol === "file:" || protocol === "data:")) {
    return "YouTube won’t play in a copy of Splitpage opened from a file.";
  }
  return "";
}

export function playerSrc(v) {
  var real = playerUrl(v, testHooks.bases);
  if (!real) return null;
  return { src: noRemote() && !testHooks.bases ? "about:blank" : real, real: real };
}

function trimLetterbox(bytes, mime) {
  return new Promise(function (resolve) {
    var url;
    try { url = URL.createObjectURL(new Blob([bytes], { type: mime })); } catch (e) { resolve(bytes); return; }
    var img = new Image();
    function done(out) { try { URL.revokeObjectURL(url); } catch (e) { } resolve(out || bytes); }
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

export function thumbnailsAllowed() {
  return preferences().videoThumbs();
}

export function fetchThumbnailRecord(href) {
  var v = parseVideoLink(href);
  if (!v) return Promise.resolve(null);
  var got;
  if (runningOnDesktop()) {
    if (typeof desktopPort().videoThumbnail !== "function") return Promise.resolve(null);
    try { got = Promise.resolve(desktopPort().videoThumbnail(v.host, videoRef(v))); } catch (e) { return Promise.resolve(null); }
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

var GALLERY_KEYS = { imageRef: true, imageLinks: true, moreImages: true, imageName: true, imageAnnotation: true };

function touchesGallery(rowId) {
  return function (s) {
    if (s.op === "rowField") return s.rowId === rowId && !!GALLERY_KEYS[s.key];
    if (s.op === "insertRow" || s.op === "deleteRow") return !!(s.row && s.row.id === rowId);
    return false;
  };
}

export function thumbnailsAfterPaste(rowId, hrefs, entry) {
  if (!S.state || !hrefs || !hrefs.length || !thumbnailsAllowed()) return;
  var ctx = captureOperation();
  hrefs.forEach(function (href) {
    var link = normalizeVideoLink({ href: href });
    if (!link || !parseVideoLink(link.href)) return;
    var key = videoLinkKey(link);
    fetchThumbnailRecord(link.href).then(function (rec) {
      if (!rec || !stillOwns(ctx) || readSession(function (doc) { return rowIndexOf(doc, rowId); }) === -1) return;
      var done = foldIntoEdit(entry, touchesGallery(rowId), function (state) {
        var idx = readSession(function (doc) { return rowIndexOf(doc, rowId); });
        return idx !== -1 && setVideoThumbnail(state.rows[idx], key, rec);
      });
      if (done && !renderRow(rowId)) render();
    });
  });
}

export function __init() {
  window.__videoTest = {
    setFetch: function (fn) { testHooks.fetch = typeof fn === "function" ? fn : null; },
    setBases: function (b) { testHooks.bases = b && typeof b === "object" ? b : null; },
    setProtocol: function (p) { testHooks.protocol = typeof p === "string" ? p : null; },
    fetchThumbnail: fetchThumbnailRecord,
    parse: parseVideoLink
  };
}
