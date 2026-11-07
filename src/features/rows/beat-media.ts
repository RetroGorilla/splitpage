import { rowIndexOf } from "../../core/document/rows.ts";
import { addGalleryPicture, isOtherFileLink, removeGalleryLink, removeGallerySlot, replaceGalleryPicture, rowSlots, videoLinkKey } from "../../core/document/gallery.ts";

import type { PastePlace, BeatMedia, BeatMediaPorts } from "./ports.ts";
import type { CellRange } from "../../application/editing/cell-editing.ts";

import type { VideoPosterFrame } from "../../application/media/video-files.ts";
interface BeatMediaPortUse extends Omit<BeatMediaPorts, "document"> {
 readonly document: Pick<BeatMediaPorts["document"], "read" | "numbering">;
}
let ports: BeatMediaPorts | null = null;

const ALPHA_CAPABLE_TYPE = /^image\/(png|gif|webp)$/;

export function compressImageFile(file: Blob | null | undefined, maxDim: number, quality: number): Promise<string> {
  return new Promise<string>(function (resolve, reject) {
    if (!file || file.type.indexOf("image/") !== 0) { reject(new Error("not an image")); return; }
    const keepAlpha = ALPHA_CAPABLE_TYPE.test(file.type);
    const reader = new FileReader();
    reader.onerror = function () { reject(new Error("read failed")); };
    reader.onload = function () {
      const img = new Image();
      img.onerror = function () { reject(new Error("decode failed")); };
      img.onload = function () {
        try {
          const w = img.width, h = img.height;
          const scale = Math.min(1, maxDim / Math.max(w, h));
          const cw = Math.max(1, Math.round(w * scale));
          const ch = Math.max(1, Math.round(h * scale));
          const canvas = document.createElement("canvas");
          canvas.width = cw; canvas.height = ch;
          const ctx = canvas.getContext("2d");
          (ctx as CanvasRenderingContext2D).drawImage(img, 0, 0, cw, ch);
          resolve(keepAlpha ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", quality));
        } catch (e) { reject(e); }
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

function capturePastePlace(cellEl: Element) {
  return { html: (ports as BeatMediaPortUse).text.storedHtmlFromDom(cellEl.innerHTML), sel: (ports as BeatMediaPortUse).selection.of(cellEl) };
}

function restorePastePlace(cellEl: Element, place: PastePlace) {
  const unchanged = place.sel && (ports as BeatMediaPortUse).text.storedHtmlFromDom(cellEl.innerHTML) === place.html;
  (ports as BeatMediaPortUse).selection.set(cellEl, unchanged ? (place.sel as CellRange).from : Infinity, unchanged ? (place.sel as CellRange).to : Infinity);
}

function showPictureNotAdded() {
  (ports as BeatMediaPortUse).notices.show("The picture finished loading after the script changed, so it was not added.", "warn");
}

function addPicture(rowId: string, file: File, slot?: number) {
  const ctx = (ports as BeatMediaPortUse).ownership.capture();
  compressImageFile(file, 1000, 0.78).then(function (dataUrl) {
    if (!(ports as BeatMediaPortUse).ownership.stillOwns(ctx)) { showPictureNotAdded(); return; }
    const idx = (ports as BeatMediaPortUse).document.read(function (doc) { return rowIndexOf(doc, rowId); });
    if (idx === -1) return;
    const rec = (ports as BeatMediaPortUse).pictures.internDataUrl(dataUrl);
    if (!rec) throw new Error("not a picture the registry takes");
    (ports as BeatMediaPortUse).pictures.persist([rec.sha256]);
    const replacing = typeof slot === "number";
    const number = (ports as BeatMediaPortUse).document.numbering().beats[rowId]?.full ?? "";
    (ports as BeatMediaPortUse).cells.editGallery(rowId, "Picture " + (replacing ? "replaced in" : "added to") + " beat " + number, function (row) {
      if (replacing && !replaceGalleryPicture(row, slot, rec, file.name)) return false;
      if (!replacing) addGalleryPicture(row, rec, file.name);
      return true;
    });
  }).catch(function () { (ports as BeatMediaPortUse).notices.show("Could not use that image.", "error"); });
}

function removePicture(rowId: string, slot?: number) {
  (ports as BeatMediaPortUse).cells.editGallery(rowId, "Picture removed", function (row) {
    return removeGallerySlot(row, slot || 0);
  });
}

function removeLink(rowId: string, slot: number, key: string) {
  const file = (ports as BeatMediaPortUse).document.read(function (doc) {
    const s = doc ? rowSlots(doc.rows[rowIndexOf(doc, rowId)])[slot] : undefined;
    return !!s && s.links.some(function (l) { return videoLinkKey(l) === key && isOtherFileLink(l); });
  });
  (ports as BeatMediaPortUse).cells.editGallery(rowId, (file ? "File" : "Video") + " link removed", function (row) { return removeGalleryLink(row, slot, key); });
}

export function videoFirstFrame(file: Blob): Promise<VideoPosterFrame | null> {
  return new Promise<VideoPosterFrame | null>(function (resolve) {
    let url: string;
    let v: HTMLVideoElement;
    let settled = false;
    function done(result: VideoPosterFrame | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { v.removeAttribute("src"); v.load(); } catch (e) {}
      try { URL.revokeObjectURL(url); } catch (e) {}
      resolve(result);
    }
    try {
      url = URL.createObjectURL(file);
      v = document.createElement("video");
    } catch (e) { resolve(null); return; }
    v.muted = true;
    v.preload = "auto";
    v.playsInline = true;
    const timer = setTimeout(function () { done(null); }, 4000);
    v.onerror = function () { done(null); };
    v.onloadeddata = function () {
      const t = isFinite(v.duration) && v.duration > 0 ? Math.min(0.5, v.duration / 3) : 0;
      if (t > 0 && Math.abs(v.currentTime - t) > 0.01) { v.onseeked = grab; v.currentTime = t; }
      else grab();
    };
    function grab() {
      try {
        const w = v.videoWidth, h = v.videoHeight;
        if (!w || !h) { done(null); return; }
        const scale = Math.min(1, 1000 / Math.max(w, h));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        (canvas.getContext("2d") as CanvasRenderingContext2D).drawImage(v, 0, 0, canvas.width, canvas.height);
        done({ dataUrl: canvas.toDataURL("image/jpeg", 0.78), duration: isFinite(v.duration) && v.duration > 0 ? v.duration : 0 });
      } catch (e) { done(null); }
    }
    v.src = url;
  });
}

export function startBeatMedia(next: BeatMediaPorts): BeatMedia {
  ports = next;
  return {
    capturePastePlace: capturePastePlace,
    restorePastePlace: restorePastePlace,
    showPictureNotAdded: showPictureNotAdded,
    addPicture: addPicture,
    removePicture: removePicture,
    removeLink: removeLink,
    dispose: function () {
      if (ports === next) ports = null;
    }
  };
}
