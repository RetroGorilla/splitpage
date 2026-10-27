import { rowIndexOf } from "../../core/document/rows.ts";
import { addGalleryPicture, removeGalleryLink, removeGallerySlot, replaceGalleryPicture } from "../../core/document/gallery.ts";

var ports = null;

var ALPHA_CAPABLE_TYPE = /^image\/(png|gif|webp)$/;

export function compressImageFile(file, maxDim, quality) {
  return new Promise(function (resolve, reject) {
    if (!file || file.type.indexOf("image/") !== 0) { reject(new Error("not an image")); return; }
    var keepAlpha = ALPHA_CAPABLE_TYPE.test(file.type);
    var reader = new FileReader();
    reader.onerror = function () { reject(new Error("read failed")); };
    reader.onload = function () {
      var img = new Image();
      img.onerror = function () { reject(new Error("decode failed")); };
      img.onload = function () {
        try {
          var w = img.width, h = img.height;
          var scale = Math.min(1, maxDim / Math.max(w, h));
          var cw = Math.max(1, Math.round(w * scale));
          var ch = Math.max(1, Math.round(h * scale));
          var canvas = document.createElement("canvas");
          canvas.width = cw; canvas.height = ch;
          var ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, cw, ch);
          resolve(keepAlpha ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", quality));
        } catch (e) { reject(e); }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function capturePastePlace(cellEl) {
  return { html: ports.text.storedHtmlFromDom(cellEl.innerHTML), sel: ports.selection.of(cellEl) };
}

function restorePastePlace(cellEl, place) {
  var unchanged = place.sel && ports.text.storedHtmlFromDom(cellEl.innerHTML) === place.html;
  ports.selection.set(cellEl, unchanged ? place.sel.from : Infinity, unchanged ? place.sel.to : Infinity);
}

function showPictureNotAdded() {
  ports.notices.show("The picture finished loading after the script changed, so it was not added.", "warn");
}

function addPicture(rowId, file, slot) {
  var ctx = ports.ownership.capture();
  compressImageFile(file, 1000, 0.78).then(function (dataUrl) {
    if (!ports.ownership.stillOwns(ctx)) { showPictureNotAdded(); return; }
    var idx = ports.document.read(function (doc) { return rowIndexOf(doc, rowId); });
    if (idx === -1) return;
    var rec = ports.pictures.internDataUrl(dataUrl);
    if (!rec) throw new Error("not a picture the registry takes");
    ports.pictures.persist([rec.sha256]);
    var replacing = typeof slot === "number";
    ports.cells.editGallery(rowId, "Picture " + (replacing ? "replaced in" : "added to") + " scene " + (idx + 1), function (row) {
      if (replacing && !replaceGalleryPicture(row, slot, rec, file.name)) return false;
      if (!replacing) addGalleryPicture(row, rec, file.name);
      return true;
    });
  }).catch(function () { ports.notices.show("Could not use that image.", "error"); });
}

function removePicture(rowId, slot) {
  ports.cells.editGallery(rowId, "Picture removed", function (row) {
    return removeGallerySlot(row, slot || 0);
  });
}

function removeLink(rowId, slot, key) {
  ports.cells.editGallery(rowId, "Video link removed", function (row) { return removeGalleryLink(row, slot, key); });
}

export function videoFirstFrame(file) {
  return new Promise(function (resolve) {
    var url, v, timer, settled = false;
    function done(result) {
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
    timer = setTimeout(function () { done(null); }, 4000);
    v.onerror = function () { done(null); };
    v.onloadeddata = function () {
      var t = isFinite(v.duration) && v.duration > 0 ? Math.min(0.5, v.duration / 3) : 0;
      if (t > 0 && Math.abs(v.currentTime - t) > 0.01) { v.onseeked = grab; v.currentTime = t; }
      else grab();
    };
    function grab() {
      try {
        var w = v.videoWidth, h = v.videoHeight;
        if (!w || !h) { done(null); return; }
        var scale = Math.min(1, 1000 / Math.max(w, h));
        var canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        canvas.getContext("2d").drawImage(v, 0, 0, canvas.width, canvas.height);
        done({ dataUrl: canvas.toDataURL("image/jpeg", 0.78), duration: isFinite(v.duration) && v.duration > 0 ? v.duration : 0 });
      } catch (e) { done(null); }
    }
    v.src = url;
  });
}

export function startSceneMedia(next) {
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
