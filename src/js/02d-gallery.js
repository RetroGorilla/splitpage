import { bytesForSync, internDataUrl, queuePersist, rowImage } from "./02c-blobs.js";
import { plainText, safeHref, safeImageSrc } from "./04-richtext.js";
import { normalizeImageRef } from "../../shared/blob-policy.js";

var MAX_LINKS = 20;
var MAX_MORE = 60;
var MAX_MARKS = 500;
var MAX_POINTS = 2000;
var MAX_TEXT = 500;

export var ANNOTATION_COLORS = ["#e5383b", "#ffb703", "#2a9d8f", "#3a86ff", "#111111", "#ffffff"];

function fraction(v, lo, hi) {
  if (typeof v !== "number" || !isFinite(v)) return null;
  return Math.round(Math.min(hi, Math.max(lo, v)) * 10000) / 10000;
}

function normalizeMark(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  var color = typeof m.color === "string" ? m.color.toLowerCase() : "";
  if (ANNOTATION_COLORS.indexOf(color) === -1) return null;
  if (m.kind === "pen" || m.kind === "highlight") {
    var width = fraction(m.width, 0.001, 0.2);
    if (width === null || !Array.isArray(m.points) || m.points.length < 2) return null;
    var pts = [];
    for (var i = 0; i + 1 < m.points.length && pts.length < MAX_POINTS * 2; i += 2) {
      var x = fraction(m.points[i], 0, 1), y = fraction(m.points[i + 1], 0, 1);
      if (x === null || y === null) return null;
      pts.push(x, y);
    }
    return { kind: m.kind, color: color, width: width, points: pts };
  }
  if (m.kind === "text") {
    var size = fraction(m.size, 0.01, 0.3);
    var tx = fraction(m.x, 0, 1), ty = fraction(m.y, 0, 1);
    if (size === null || tx === null || ty === null || typeof m.text !== "string") return null;
    /* eslint-disable-next-line no-control-regex -- controls are what goes */
    var text = m.text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000B-\u001F\u007F]+/g, " ").slice(0, MAX_TEXT);
    if (!text.trim()) return null;
    return { kind: "text", color: color, size: size, x: tx, y: ty, text: text };
  }
  return null;
}

export function normalizeMarks(list) {
  var out = [];
  (Array.isArray(list) ? list : []).forEach(function (m) {
    if (out.length >= MAX_MARKS) return;
    var n = normalizeMark(m);
    if (n) out.push(n);
  });
  return out;
}

function normalizeAnnotation(a, flat) {
  if (!a || typeof a !== "object" || Array.isArray(a) || !flat) return null;
  var legacy = safeImageSrc(a.visualImage);
  var rec = legacy ? internDataUrl(legacy) : null;
  if (rec) queuePersist([rec.sha256]);
  var ref = rec || normalizeImageRef(a.imageRef);
  if (!ref || ref.sha256 === flat.sha256) return null;
  var marks = normalizeMarks(a.marks);
  return marks.length ? { imageRef: ref, marks: marks } : null;
}

export function slotOriginal(slot) {
  return slot && slot.annotation ? slot.annotation.imageRef : (slot ? slot.ref : null);
}

export function normalizeVideoLink(x) {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  var out;
  if (typeof x.href === "string") {
    var href = safeHref(x.href);
    if (!href || !/^https?:\/\//i.test(href) || href.length > 2048) return null;
    out = { href: href };
  } else if (typeof x.name === "string") {
    /* eslint-disable-next-line no-control-regex -- a file name is one line */
    var name = plainText(x.name).replace(/[\u0000-\u001F]+/g, " ").trim().slice(0, 200);
    if (!name) return null;
    out = { name: name };
    if (typeof x.size === "number" && isFinite(x.size) && x.size >= 0) out.size = Math.floor(x.size);
  } else {
    return null;
  }
  if (typeof x.duration === "number" && isFinite(x.duration) && x.duration > 0 && x.duration < 1e7) {
    out.duration = Math.round(x.duration * 10) / 10;
  }
  if (x.poster === true) out.poster = true;
  return out;
}

export function normalizePictureName(v) {
  if (typeof v !== "string") return "";
  /* eslint-disable-next-line no-control-regex -- a file name is one line */
  return plainText(v).replace(/[\u0000-\u001F]+/g, " ").trim().slice(0, 200);
}

export function videoLinkKey(l) {
  if (!l) return "";
  return l.href ? "u:" + l.href : "f:" + l.name + ":" + (l.size || 0);
}

export function normalizeVideoLinks(list) {
  var out = [], seen = {}, poster = false;
  (Array.isArray(list) ? list : []).forEach(function (x) {
    var l = normalizeVideoLink(x);
    if (!l || out.length >= MAX_LINKS) return;
    var k = videoLinkKey(l);
    if (seen[k]) return;
    seen[k] = true;
    if (l.poster) { if (poster) delete l.poster; poster = true; }
    out.push(l);
  });
  return out;
}

function normalizeGalleryItem(it) {
  if (!it || typeof it !== "object" || Array.isArray(it)) return null;
  var legacy = safeImageSrc(it.visualImage);
  var rec = legacy ? internDataUrl(legacy) : null;
  if (rec) queuePersist([rec.sha256]);
  var ref = rec || normalizeImageRef(it.imageRef);
  var links = normalizeVideoLinks(it.links);
  if (!ref && !links.some(function (l) { return l.poster; })) return null;
  var out = {};
  if (ref) out.imageRef = ref;
  var name = ref ? normalizePictureName(it.name) : "";
  if (name) out.name = name;
  if (links.length) out.links = links;
  var ann = normalizeAnnotation(it.annotation, ref);
  if (ann) out.annotation = ann;
  return out;
}

function itemKey(it) {
  if (!it) return "";
  if (it.imageRef && it.imageRef.sha256) return it.imageRef.sha256;
  var poster = (Array.isArray(it.links) ? it.links : []).filter(function (l) { return l && l.poster; })[0];
  return poster ? "v:" + videoLinkKey(poster) : "";
}

export function migrateGallery(r) {
  var imageName = r.imageRef ? normalizePictureName(r.imageName) : "";
  if (imageName) r.imageName = imageName; else delete r.imageName;
  var links = normalizeVideoLinks(r.imageLinks);
  if (links.length) r.imageLinks = links; else delete r.imageLinks;
  var ann = normalizeAnnotation(r.imageAnnotation, normalizeImageRef(r.imageRef));
  if (ann) r.imageAnnotation = ann; else delete r.imageAnnotation;
  var seen = {};
  var firstKey = itemKey({ imageRef: r.imageRef, links: r.imageLinks });
  if (firstKey) seen[firstKey] = true;
  var more = [];
  (Array.isArray(r.moreImages) ? r.moreImages : []).forEach(function (x) {
    var it = normalizeGalleryItem(x);
    if (!it || seen[itemKey(it)] || more.length >= MAX_MORE) return;
    seen[itemKey(it)] = true;
    more.push(it);
  });
  if (!r.imageRef && !r.imageLinks && more.length) {
    var first = more.shift();
    r.imageRef = first.imageRef || null;
    if (first.name) r.imageName = first.name;
    if (first.links) r.imageLinks = first.links;
    if (first.annotation) r.imageAnnotation = first.annotation;
  }
  if (more.length) r.moreImages = more; else delete r.moreImages;
}

export function rowSlots(row) {
  var out = [];
  if (!row || typeof row !== "object") return out;
  var img = rowImage(row);
  var links = Array.isArray(row.imageLinks) ? row.imageLinks : [];
  if (img || links.length) {
    out.push({ ref: img ? img.ref : null, dataUrl: img ? img.dataUrl : null, links: links,
               name: img && typeof row.imageName === "string" ? row.imageName : "",
               annotation: img && img.ref ? readAnnotation(row.imageAnnotation) : null });
  }
  (Array.isArray(row.moreImages) ? row.moreImages : []).forEach(function (it) {
    if (!it || typeof it !== "object") return;
    var ref = normalizeImageRef(it.imageRef);
    var itLinks = Array.isArray(it.links) ? it.links : [];
    if (!ref && !itLinks.some(function (l) { return l && l.poster; })) return;
    out.push({ ref: ref, dataUrl: null, links: itLinks, name: ref && typeof it.name === "string" ? it.name : "",
               annotation: ref ? readAnnotation(it.annotation) : null });
  });
  return out;
}

function readAnnotation(a) {
  if (!a || typeof a !== "object") return null;
  var ref = normalizeImageRef(a.imageRef);
  return ref && Array.isArray(a.marks) && a.marks.length ? { imageRef: ref, marks: a.marks } : null;
}

function isVideoSlot(s) {
  return s.links.some(function (l) { return l.poster; });
}

export function gallerySize(row) {
  return rowSlots(row).length;
}

export function morePictureRefs(row) {
  return rowSlots(row).slice(1).map(function (s) { return s.ref; }).filter(Boolean);
}

export function pictureBytes(ref) {
  var held = ref ? bytesForSync(ref.sha256) : null;
  return held ? { bytes: held, mime: ref.mime, width: ref.width, height: ref.height } : null;
}

export function videoLinkText(l) {
  return l.href ? l.href : l.name + " (video file)";
}

export function rowVideoLinks(row) {
  var out = [];
  rowSlots(row).forEach(function (s) { out = out.concat(s.links); });
  return out;
}

function copy(v) { return JSON.parse(JSON.stringify(v)); }

export function setRowSlots(row, slots) {
  delete row.visualImage;
  var first = slots[0] || null;
  row.imageRef = first && first.ref ? copy(first.ref) : null;
  if (first && first.ref && first.name) row.imageName = first.name; else delete row.imageName;
  if (first && first.links && first.links.length) row.imageLinks = copy(first.links); else delete row.imageLinks;
  if (first && first.ref && first.annotation) row.imageAnnotation = copy(first.annotation); else delete row.imageAnnotation;
  var more = [];
  slots.slice(1).forEach(function (s) {
    if (!s || (!s.ref && !isVideoSlot(s))) return;
    var it = {};
    if (s.ref) it.imageRef = copy(s.ref);
    if (s.ref && s.name) it.name = s.name;
    if (s.links && s.links.length) it.links = copy(s.links);
    if (s.ref && s.annotation) it.annotation = copy(s.annotation);
    more.push(it);
  });
  if (more.length) row.moreImages = more; else delete row.moreImages;
}

function slotsOf(row) {
  return rowSlots(row).map(function (s) {
    return { ref: s.ref, links: s.links.slice(), name: s.name, annotation: s.annotation };
  });
}

export function addGalleryPicture(row, ref, name) {
  var slots = slotsOf(row);
  for (var i = 0; i < slots.length; i++) {
    if (slots[i].ref && slots[i].ref.sha256 === ref.sha256) return i;
  }
  var at;
  name = normalizePictureName(name);
  if (!slots.length) { slots.push({ ref: ref, links: [], name: name }); at = 0; }
  else if (!slots[0].ref && !isVideoSlot(slots[0])) { slots[0].ref = ref; slots[0].name = name; at = 0; }
  else { slots.push({ ref: ref, links: [], name: name }); at = slots.length - 1; }
  setRowSlots(row, slots);
  return at;
}

export function addGalleryVideo(row, link, poster) {
  var l = normalizeVideoLink(link);
  if (!l) return -1;
  l.poster = true;
  var key = videoLinkKey(l);
  var slots = slotsOf(row);
  for (var i = 0; i < slots.length; i++) {
    if (slots[i].links.some(function (x) { return videoLinkKey(x) === key; })) return i;
  }
  var slot = { ref: poster || null, links: [l], name: "" };
  if (slots.length === 1 && !slots[0].ref && !isVideoSlot(slots[0])) {
    slot.links = slots[0].links.concat([l]);
    slots[0] = slot;
    setRowSlots(row, slots);
    return 0;
  }
  slots.push(slot);
  setRowSlots(row, slots);
  return slots.length - 1;
}

export function setVideoThumbnail(row, key, ref) {
  var slots = slotsOf(row);
  if (!ref || slots.some(function (s) { return s.ref && s.ref.sha256 === ref.sha256; })) return false;
  for (var i = 0; i < slots.length; i++) {
    var s = slots[i];
    if (s.ref || !s.links.some(function (l) { return l.poster && videoLinkKey(l) === key; })) continue;
    s.ref = ref;
    setRowSlots(row, slots);
    return true;
  }
  return false;
}

export function replaceGalleryPicture(row, i, ref, name) {
  var slots = slotsOf(row);
  if (!slots[i]) return false;
  if (slots.some(function (s, k) { return k !== i && s.ref && s.ref.sha256 === ref.sha256; })) {
    slots.splice(i, 1);
  } else {
    slots[i].ref = ref;
    slots[i].name = normalizePictureName(name);
    slots[i].annotation = null;
  }
  setRowSlots(row, slots);
  return true;
}

export function annotateGallerySlot(row, i, flat, original, marks) {
  var slots = slotsOf(row);
  var s = slots[i];
  var orig = normalizeImageRef(original);
  if (!s || !s.ref || isVideoSlot(s) || !orig) return false;
  var clean = normalizeMarks(marks);
  var ref = clean.length ? normalizeImageRef(flat) : orig;
  if (!ref || (clean.length && ref.sha256 === orig.sha256)) return false;
  if (slots.some(function (o, k) { return k !== i && o.ref && o.ref.sha256 === ref.sha256; })) return false;
  s.ref = ref;
  s.annotation = clean.length ? { imageRef: orig, marks: clean } : null;
  setRowSlots(row, slots);
  return true;
}

export function moveGallerySlot(row, from, to) {
  var slots = slotsOf(row);
  if (!slots[from] || to < 0 || to >= slots.length || from === to) return false;
  var s = slots.splice(from, 1)[0];
  slots.splice(to, 0, s);
  setRowSlots(row, slots);
  return true;
}

export function removeGallerySlot(row, i) {
  var slots = slotsOf(row);
  if (!slots[i]) return false;
  slots.splice(i, 1);
  setRowSlots(row, slots);
  return true;
}

export function removeGalleryLink(row, i, key) {
  var slots = slotsOf(row);
  if (!slots[i]) return false;
  var before = slots[i].links.length;
  slots[i].links = slots[i].links.filter(function (l) { return videoLinkKey(l) !== key; });
  if (slots[i].links.length === before) return false;
  if (!slots[i].ref && !slots[i].links.length) slots.splice(i, 1);
  setRowSlots(row, slots);
  return true;
}

export function videoLinkLabel(l) {
  if (!l) return "";
  if (!l.href) return l.name;
  var s = String(l.href).replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
  return s.length > 48 ? s.slice(0, 45) + "…" : s;
}

function mergeSet(base, mine, theirs, key, both) {
  var b = {}, m = {}, t = {};
  (base || []).forEach(function (x) { b[key(x)] = x; });
  (mine || []).forEach(function (x) { m[key(x)] = x; });
  (theirs || []).forEach(function (x) { t[key(x)] = x; });
  var out = [];
  (theirs || []).forEach(function (x) {
    var k = key(x);
    if (!m[k]) { if (b[k]) return; out.push(copy(x)); return; }
    out.push(both ? both(b[k], m[k], x) : copy(x));
  });
  (mine || []).forEach(function (x) {
    var k = key(x);
    if (t[k] || b[k]) return;
    out.push(copy(x));
  });
  return out;
}


export function mergeGalleryField(f, b, m, t) {
  var list;
  if (f === "imageLinks") {
    list = mergeSet(b && b.imageLinks, m.imageLinks, t.imageLinks, videoLinkKey);
  } else {
    list = mergeSet(b && b.moreImages, m.moreImages, t.moreImages, itemKey, function (bi, mi, ti) {
      var out = copy(ti);
      var links = mergeSet(bi && bi.links, mi.links, ti.links, videoLinkKey);
      if (links.length) out.links = links; else delete out.links;
      return out;
    });
  }
  return list.length ? list : undefined;
}

export function galleryFieldKey(row, f) {
  var v = row && row[f];
  if (!Array.isArray(v) || !v.length) return null;
  if (f === "imageLinks") return v.map(function (l) { return videoLinkKey(l) + (l.poster ? "*" : ""); }).join("\n");
  return v.map(function (it) {
    return itemKey(it) + "[" + (Array.isArray(it.links) ? it.links.map(videoLinkKey).join("\n") : "") + "]";
  }).join("\n");
}

export function __init() {}
