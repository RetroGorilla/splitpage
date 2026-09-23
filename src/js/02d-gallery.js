import { bytesForSync, internDataUrl, queuePersist, rowImage } from "./02c-blobs.js";
import { plainText, safeHref, safeImageSrc } from "./04-richtext.js";
import { normalizeImageRef } from "../../shared/blob-policy.js";

/* ================= a scene's pictures: the gallery (#135) =================

   A scene's Image section holds a small gallery: pictures shown one at a
   time as a carousel, each with a caption of video links under it. In the
   document a row keeps its first picture exactly where it always did, so
   every reader of one picture — and every older copy of the app — goes on
   working, and the rest beside it:

     imageRef     the first picture (#82), or null
     imageLinks   the first picture's caption: [link], absent when empty
     moreImages   the pictures after it: [{imageRef, links?}], absent when
                  there are none

   A link is {href} (an http(s) address, through safeHref) or {name, size}
   (a video file: its name only — its bytes and where it sits on someone's
   disk are not the document's). `poster: true` on a link says the
   picture above it IS that video's thumbnail, so clicking the picture
   opens it too.

   The first slot may have links and no picture: a video pasted into a
   scene with no picture gets a placeholder there. Every slot after it has
   a picture. migrateRows (02-state.js) calls migrateGallery for each row;
   the merge (03-sync.js) merges imageLinks and moreImages as sets
   (mergeGalleryField), so two people adding pictures both keep theirs. */

var MAX_LINKS = 20;
var MAX_MORE = 60;

/* A caption link, made safe, or null. */
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
  if (x.poster === true) out.poster = true;
  return out;
}

/* One key per distinct video: what a caption holds once, and what the
   merge matches links by. */
export function videoLinkKey(l) {
  if (!l) return "";
  return l.href ? "u:" + l.href : "f:" + l.name + ":" + (l.size || 0);
}

/* Each once, at most MAX_LINKS, at most one poster. */
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

/* A further picture: its record — or, in a file, its inline data: URI,
   the way a row's first picture is carried (inlineStateImages,
   02c-blobs.js), interned here — and its links. null when it is not one. */
function normalizeGalleryItem(it) {
  if (!it || typeof it !== "object" || Array.isArray(it)) return null;
  var legacy = safeImageSrc(it.visualImage);
  var rec = legacy ? internDataUrl(legacy) : null;
  if (rec) queuePersist([rec.sha256]);
  var ref = rec || normalizeImageRef(it.imageRef);
  if (!ref) return null;
  var out = { imageRef: ref };
  var links = normalizeVideoLinks(it.links);
  if (links.length) out.links = links;
  return out;
}

/* migrateRows' part: the row's first picture is already settled (its
   imageRef). Absent keys stay absent, so a document with no gallery reads
   and writes exactly as it did. A picture repeated is one picture. A
   first slot left with nothing in it while pictures follow takes the next. */
export function migrateGallery(r) {
  var links = normalizeVideoLinks(r.imageLinks);
  if (links.length) r.imageLinks = links; else delete r.imageLinks;
  var seen = {};
  if (r.imageRef && r.imageRef.sha256) seen[r.imageRef.sha256] = true;
  var more = [];
  (Array.isArray(r.moreImages) ? r.moreImages : []).forEach(function (x) {
    var it = normalizeGalleryItem(x);
    if (!it || seen[it.imageRef.sha256] || more.length >= MAX_MORE) return;
    seen[it.imageRef.sha256] = true;
    more.push(it);
  });
  if (!r.imageRef && !r.imageLinks && more.length) {
    var first = more.shift();
    r.imageRef = first.imageRef;
    if (first.links) r.imageLinks = first.links;
  }
  if (more.length) r.moreImages = more; else delete r.moreImages;
}

/* ---- reading and writing a row's slots ----

   A slot is {ref, dataUrl, links}: ref a record (or null), dataUrl a
   legacy inline picture (the first slot of a row that has not been
   through migrateRows), links its caption. Slot 0 is there when the row
   has a first picture or first-slot links. */
export function rowSlots(row) {
  var out = [];
  if (!row || typeof row !== "object") return out;
  var img = rowImage(row);
  var links = Array.isArray(row.imageLinks) ? row.imageLinks : [];
  if (img || links.length) out.push({ ref: img ? img.ref : null, dataUrl: img ? img.dataUrl : null, links: links });
  (Array.isArray(row.moreImages) ? row.moreImages : []).forEach(function (it) {
    var ref = it && normalizeImageRef(it.imageRef);
    if (ref) out.push({ ref: ref, dataUrl: null, links: Array.isArray(it.links) ? it.links : [] });
  });
  return out;
}

/* How many pictures (and placeholders) the scene's gallery shows. */
export function gallerySize(row) {
  return rowSlots(row).length;
}

/* Every picture of the row after its first, as records — what the
   exports draw beside it. */
export function morePictureRefs(row) {
  return rowSlots(row).slice(1).map(function (s) { return s.ref; }).filter(Boolean);
}

/* A further picture's bytes, as rowImageBytes (02c-blobs.js) gives a
   first one's: {bytes, mime, width, height}, or null when they are not
   in memory (the exports ensureBytes first). */
export function pictureBytes(ref) {
  var held = ref ? bytesForSync(ref.sha256) : null;
  return held ? { bytes: held, mime: ref.mime, width: ref.width, height: ref.height } : null;
}

/* A caption link as a line of text for the text exports: its address, or
   a file's name. */
export function videoLinkText(l) {
  return l.href ? l.href : l.name + " (video file)";
}

/* Every caption link of the row, in slot order. */
export function rowVideoLinks(row) {
  var out = [];
  rowSlots(row).forEach(function (s) { out = out.concat(s.links); });
  return out;
}

function copy(v) { return JSON.parse(JSON.stringify(v)); }

/* Writes `slots` ({ref, links}) back as the row's three keys — only
   what changed is changed, and empty ones are left out. A slot after the
   first with no picture has nowhere to go and is dropped. */
export function setRowSlots(row, slots) {
  delete row.visualImage;
  var first = slots[0] || null;
  row.imageRef = first && first.ref ? copy(first.ref) : null;
  if (first && first.links && first.links.length) row.imageLinks = copy(first.links); else delete row.imageLinks;
  var more = [];
  slots.slice(1).forEach(function (s) {
    if (!s || !s.ref) return;
    var it = { imageRef: copy(s.ref) };
    if (s.links && s.links.length) it.links = copy(s.links);
    more.push(it);
  });
  if (more.length) row.moreImages = more; else delete row.moreImages;
}

function slotsOf(row) {
  return rowSlots(row).map(function (s) {
    return { ref: s.ref, links: s.links.slice() };
  });
}

/* Adds a picture (a record) to the row: into an empty first slot — no
   picture yet, whatever its caption — or after the others. A picture the
   gallery already shows is not added twice. Returns the slot it is in. */
export function addGalleryPicture(row, ref) {
  var slots = slotsOf(row);
  for (var i = 0; i < slots.length; i++) {
    if (slots[i].ref && slots[i].ref.sha256 === ref.sha256) return i;
  }
  var at;
  if (!slots.length) { slots.push({ ref: ref, links: [] }); at = 0; }
  else if (!slots[0].ref) { slots[0].ref = ref; at = 0; }
  else { slots.push({ ref: ref, links: [] }); at = slots.length - 1; }
  setRowSlots(row, slots);
  return at;
}

/* Adds a video's link. An empty gallery gets a first slot for it, whose
   picture is `poster` (a record: a local file's first frame) or none — a
   placeholder — and the link is marked as that picture's video. Otherwise
   the link goes on the caption of slot `at` (the one on screen) with no
   thumbnail: the picture there stays the picture. Returns the slot. */
export function addGalleryVideo(row, link, at, poster) {
  var l = normalizeVideoLink(link);
  if (!l) return -1;
  delete l.poster;
  var slots = slotsOf(row);
  if (!slots.length) {
    l.poster = true;
    slots.push({ ref: poster || null, links: [l] });
    setRowSlots(row, slots);
    return 0;
  }
  var i = at >= 0 && at < slots.length ? at : 0;
  var key = videoLinkKey(l);
  if (!slots[i].links.some(function (x) { return videoLinkKey(x) === key; })) slots[i].links.push(l);
  setRowSlots(row, slots);
  return i;
}

/* Replaces slot i's picture, keeping its caption. */
export function replaceGalleryPicture(row, i, ref) {
  var slots = slotsOf(row);
  if (!slots[i]) return false;
  if (slots.some(function (s, k) { return k !== i && s.ref && s.ref.sha256 === ref.sha256; })) {
    /* already elsewhere in the gallery: this slot goes, that one stays */
    slots.splice(i, 1);
  } else {
    slots[i].ref = ref;
  }
  setRowSlots(row, slots);
  return true;
}

/* Takes slot i away — its picture and its caption. */
export function removeGallerySlot(row, i) {
  var slots = slotsOf(row);
  if (!slots[i]) return false;
  slots.splice(i, 1);
  setRowSlots(row, slots);
  return true;
}

/* Takes one link off slot i's caption. A placeholder left with no link
   is nothing, and goes. */
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

/* What a caption shows for a link: a web address without its scheme and
   "www.", shortened; a file by its name. */
export function videoLinkLabel(l) {
  if (!l) return "";
  if (!l.href) return l.name;
  var s = String(l.href).replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
  return s.length > 48 ? s.slice(0, 45) + "…" : s;
}

/* ---- the merge ----

   imageLinks and moreImages merge as sets, three ways: what either side
   added is kept, what either side removed (and the other left as it was
   in base) goes. Order is theirs, then what only I added. Never a
   conflict: two people adding pictures to one scene both keep theirs. A
   picture both sides still have merges its caption the same way. */
function mergeSet(base, mine, theirs, key, both) {
  var b = {}, m = {}, t = {};
  (base || []).forEach(function (x) { b[key(x)] = x; });
  (mine || []).forEach(function (x) { m[key(x)] = x; });
  (theirs || []).forEach(function (x) { t[key(x)] = x; });
  var out = [];
  (theirs || []).forEach(function (x) {
    var k = key(x);
    if (!m[k]) { if (b[k]) return; out.push(copy(x)); return; }   /* I removed it / they added it */
    out.push(both ? both(b[k], m[k], x) : copy(x));
  });
  (mine || []).forEach(function (x) {
    var k = key(x);
    if (t[k] || b[k]) return;                                       /* theirs has it / they removed it */
    out.push(copy(x));
  });
  return out;
}

function itemKey(it) { return it && it.imageRef ? it.imageRef.sha256 : ""; }

/* The merged value of row field f ("imageLinks" or "moreImages") for
   base b (or null), mine m and theirs t — undefined when empty, so the
   key stays absent. */
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

/* A gallery field as one comparable string, for "did it change". */
export function galleryFieldKey(row, f) {
  var v = row && row[f];
  if (!Array.isArray(v) || !v.length) return null;
  if (f === "imageLinks") return v.map(function (l) { return videoLinkKey(l) + (l.poster ? "*" : ""); }).join("\n");
  return v.map(function (it) {
    return itemKey(it) + "[" + (Array.isArray(it.links) ? it.links.map(videoLinkKey).join("\n") : "") + "]";
  }).join("\n");
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {}
