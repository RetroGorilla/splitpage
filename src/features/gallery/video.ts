import { rowIndexOf } from "../../core/document/rows.ts";
import { fetchVideoThumbnail, parseVideoLink, playerUrl, videoRef } from "../../../shared/video-embed.js";
import { normalizeVideoLink, setVideoThumbnail, videoLinkKey } from "../../core/document/gallery.ts";
import { exposeTestHook } from "../common/test-hooks.ts";

import type { GalleryVideoMount, GalleryVideoPorts } from "./ports.ts";
import type { DesktopVideoResult } from "../../application/media/desktop-video.ts";
import type { UndoEntry } from "../../application/editing/undo/history.ts";
import type { Step } from "../../core/text/steps.ts";

interface VideoTestSettings {
  fetch: typeof fetch | null;
  bases: object | null;
  protocol: string | null;
}

function noRemote() {
  return !!(window as Window & { __splitpageNoRemote?: boolean }).__splitpageNoRemote;
}

function trimLetterbox(bytes: Uint8Array, mime: string): Promise<Uint8Array> {
  return new Promise<Uint8Array>(function (resolve) {
    let url;
    try { url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime })); } catch (e) { resolve(bytes); return; }
    let img = new Image();
    function done(out: Uint8Array | null) { try { URL.revokeObjectURL(url); } catch (e) { } resolve(out || bytes); }
    img.onerror = function () { done(null); };
    img.onload = function () {
      try {
        let w = img.naturalWidth, h = img.naturalHeight;
        let band = Math.round((h - w * 9 / 16) / 2);
        if (!w || !h || Math.abs(w * 3 - h * 4) > 4 || band < 16) { done(null); return; }
        let c = document.createElement("canvas");
        c.width = w; c.height = h;
        let g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        let top = g.getImageData(0, 0, w, band - 8).data, bottom = g.getImageData(0, h - band + 8, w, band - 8).data;
        if (!allDark(top) || !allDark(bottom)) { done(null); return; }
        let out = document.createElement("canvas");
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

function allDark(px: Uint8ClampedArray) {
  let light = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] > 28 || px[i + 1] > 28 || px[i + 2] > 28) light++;
  }
  return light <= (px.length / 4) * 0.01;
}

let GALLERY_KEYS: Record<string, boolean> = { imageRef: true, imageLinks: true, moreImages: true, imageName: true, imageAnnotation: true };

function touchesGallery(rowId: string | null) {
  return function (s: Step) {
    if (s.op === "rowField") return s.rowId === rowId && !!GALLERY_KEYS[s.key];
    if (s.op === "insertRow" || s.op === "deleteRow") return !!(s.row && s.row.id === rowId);
    return false;
  };
}

export function startGalleryVideo(ports: GalleryVideoPorts): GalleryVideoMount {
  let testHooks: VideoTestSettings = { fetch: null, bases: null, protocol: null };

  function embedRefusal(v: unknown) {
    if (!v) return "";
    let protocol = testHooks.protocol || location.protocol;
    if ((v as { host?: unknown }).host === "youtube" && (protocol === "file:" || protocol === "data:")) {
      return "YouTube won’t play in a copy of Splitpage opened from a file.";
    }
    return "";
  }

  function playerSrc(v: unknown) {
    let real = playerUrl(v, testHooks.bases);
    if (!real) return null;
    return { src: noRemote() && !testHooks.bases ? "about:blank" : real, real: real };
  }

  function thumbnailsAllowed() {
    return ports.thumbnailsAllowed();
  }

  function fetchThumbnailRecord(href: string) {
    let v = parseVideoLink(href);
    if (!v) return Promise.resolve(null);
    let got: Promise<DesktopVideoResult | null> | null;
    if (ports.desktop.present()) {
      try { got = ports.desktop.thumbnail(v.host, videoRef(v)); } catch (e) { return Promise.resolve(null); }
      if (!got) return Promise.resolve(null);
    } else {
      let f = testHooks.fetch || (noRemote() ? null : (typeof fetch === "function" ? fetch.bind(window) : null));
      if (!f) return Promise.resolve(null);
      got = fetchVideoThumbnail(v, { fetch: f, bases: testHooks.bases });
    }
    return got.then(function (res) {
      if (!res || !res.ok || !res.bytes) return null;
      let bytes = res.bytes instanceof Uint8Array ? res.bytes : new Uint8Array(res.bytes as ArrayBuffer);
      return (v.host === "youtube" ? trimLetterbox(bytes, res.mime || "image/jpeg") : Promise.resolve(bytes)).then(function (b) {
        let rec = ports.pictures.intern(b) || ports.pictures.intern(bytes);
        if (rec) ports.pictures.persist([rec.sha256]);
        return rec || null;
      });
    }).then(null, function () { return null; });
  }

  function thumbnailsAfterPaste(rowId: string | null, hrefs: readonly unknown[] | null | undefined, entry: unknown) {
    if (!ports.document.current() || !hrefs || !hrefs.length || !thumbnailsAllowed()) return;
    let ctx = ports.ownership.capture();
    hrefs.forEach(function (href) {
      let link = normalizeVideoLink({ href: href });
      if (!link || !parseVideoLink(link.href)) return;
      let key = videoLinkKey(link);
      fetchThumbnailRecord(link.href).then(function (rec) {
        if (!rec || !ports.ownership.stillOwns(ctx) || ports.document.read(function (doc) { return rowIndexOf(doc, rowId); }) === -1) return;
        ports.undo.fold(entry as UndoEntry | null | undefined, touchesGallery(rowId), function (state) {
          let idx = ports.document.read(function (doc) { return rowIndexOf(doc, rowId); });
          return idx !== -1 && setVideoThumbnail(state.rows[idx], key, rec);
        });
      });
    });
  }

  let withdrawHook: (() => void) | null = null;
  exposeTestHook("__videoTest", function () { return {
    setFetch: function (fn: unknown) { testHooks.fetch = typeof fn === "function" ? fn as typeof fetch : null; },
    setBases: function (b: unknown) { testHooks.bases = b && typeof b === "object" ? b : null; },
    setProtocol: function (p: unknown) { testHooks.protocol = typeof p === "string" ? p : null; },
    fetchThumbnail: fetchThumbnailRecord,
    parse: parseVideoLink
  }; }, function (withdraw) { withdrawHook = withdraw; });

  return {
    embedRefusal: embedRefusal,
    playerSrc: playerSrc,
    thumbnailsAllowed: thumbnailsAllowed,
    fetchThumbnail: fetchThumbnailRecord,
    thumbnailsAfterPaste: thumbnailsAfterPaste,
    dispose: function () {
      if (withdrawHook) withdrawHook();
    }
  };
}
