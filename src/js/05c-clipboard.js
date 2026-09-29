import { S } from "./_state.js";
import { makeId } from "./02-state.js";
import { randomHexBytes } from "./02b-doc-id.js";
import { internDataUrl, persist } from "./02c-blobs.js";
import { addGalleryPicture, addGalleryVideo } from "./02d-gallery.js";
import { findRowIndex, stampRow } from "./03-sync.js";
import { imageRefOf, inertBody, safeHref, storedHtmlFromDom } from "./04-richtext.js";
import {
  cellLength,
  cellOf,
  commentIds,
  deleteRange,
  flattenCues,
  flattenDirections,
  fromHtml,
  insertText,
  joinCells,
  normalizeCell,
  projection,
  sliceCell,
  syncCommentAnchors,
  toHtml
} from "./04c-doc-model.js";
import { cellSelection, editCell } from "./05b-cell-edit.js";
import { recordPastedBroll } from "./08c-broll.js";
import { markDirty } from "./12-dirty-toast.js";
import { breakUndoCoalescing, flushEdits } from "./12a-undo.js";

var CUT_ATTR = "data-splitpage-cut";

function never() { return false; }
function always() { return true; }

export function stripComments(cell) {
  return normalizeCell(cell, { hasComment: never });
}

export function clipboardOfCell(cell, opts) {
  opts = opts || {};
  var c = opts.keepComments ? normalizeCell(cell) : stripComments(cell);
  var html = toHtml(c);
  if (opts.nonce) html = "<span " + CUT_ATTR + '="' + String(opts.nonce).replace(/[^A-Za-z0-9]/g, "") + '">' + html + "</span>";
  var text = "";
  flattenDirections(c).forEach(function (r) { text += r.text; });
  return { html: html, text: text.replace(/\u00a0/g, " ") };
}

// Read from raw HTML; sanitiser drops the attribute
export function cutNonceIn(html) {
  var m = new RegExp(CUT_ATTR + "\\s*=\\s*[\"']?([A-Za-z0-9]+)").exec(String(html == null ? "" : html));
  return m ? m[1] : null;
}

var VIDEO_HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|loom\.com|dailymotion\.com|dai\.ly|wistia\.com|wistia\.net|wi\.st|twitch\.tv|tiktok\.com|streamable\.com|frame\.io|f\.io|vidyard\.com)$/i;
var VIDEO_FILE_PATH = /\.(mp4|m4v|mov|webm|mkv|avi|ogv)$/i;
var URL_RE = /https?:\/\/[^\s<>"]+/gi;

export function videoLink(href) {
  var safe = safeHref(String(href == null ? "" : href));
  if (!safe || !/^https?:\/\//i.test(safe)) return null;
  try {
    var u = new URL(safe);
    return VIDEO_HOSTS.test(u.hostname) || VIDEO_FILE_PATH.test(u.pathname) ? safe : null;
  } catch (e) { return null; }
}

function urlInText(u) {
  return videoLink(u.replace(/[.,;:!?)\]]+$/, ""));
}

function bareUrl(u) {
  return String(u).trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "").toLowerCase();
}

function attachKey(item) {
  if (item.kind === "image") return "img:" + item.ref.sha256;
  if (item.kind === "video") return "video:" + item.href;
  return "file:" + item.name + ":" + item.size;
}

export function addAttachment(list, item) {
  var key = attachKey(item);
  if (!list.some(function (x) { return attachKey(x) === key; })) list.push(item);
  return list;
}

export function videoLinksInText(text) {
  var t = String(text == null ? "" : text);
  var links = [];
  (t.match(URL_RE) || []).forEach(function (u) {
    var v = urlInText(u);
    if (v && links.indexOf(v) === -1) links.push(v);
  });
  if (!links.length) return { text: t, links: links };
  var rest = t.replace(URL_RE, function (u) { return urlInText(u) ? "" : u; });
  return { text: /\S/.test(rest) ? t : "", links: links };
}

// Media extracted before fromHtml; model has no place for them
function prepareHtml(html, opts) {
  opts = opts || {};
  var body = inertBody(html);
  var media = 0, lost = 0;
  var attach = [];
  Array.prototype.forEach.call(body.querySelectorAll("img"), function (el) {
    media++;
    if (!opts.skipImages) {
      var ref = imageRefOf(el);
      if (ref) addAttachment(attach, { kind: "image", ref: ref });
      else lost++;
    }
    if (el.parentNode) el.parentNode.removeChild(el);
  });
  Array.prototype.forEach.call(body.querySelectorAll("a[href]"), function (el) {
    if (!el.parentNode) return;
    var card = el.classList.contains("video-embed-card");
    var href = card ? safeHref(el.getAttribute("href") || "") : videoLink(el.getAttribute("href"));
    if (href && !/^https?:/i.test(href)) href = null;
    if (!href && !card) return;
    media++;
    if (href) addAttachment(attach, { kind: "video", href: href });
    var words = (el.textContent || "").trim();
    if (card || !href || !words || bareUrl(words) === bareUrl(href)) el.parentNode.removeChild(el);
  });
  Array.prototype.forEach.call(body.querySelectorAll("video"), function (el) {
    if (!el.parentNode) return;
    media++;
    var source = el.querySelector("source[src]");
    var href = safeHref(el.getAttribute("src") || (source ? source.getAttribute("src") : "") || "");
    if (href && /^https?:/i.test(href)) addAttachment(attach, { kind: "video", href: href });
    el.parentNode.removeChild(el);
  });
  Array.prototype.forEach.call(body.querySelectorAll("picture"), function (el) {
    if (el.parentNode) el.parentNode.removeChild(el);
  });
  Array.prototype.forEach.call(body.querySelectorAll("style, script, template, noscript, title, meta, link"), function (el) {
    if (el.parentNode) el.parentNode.removeChild(el);
  });
  // Trailing paragraph break dropped; pasted sentence gets no extra line
  var last = body.lastChild;
  while (last && (last.nodeType === 8 || (last.nodeType === 3 && !/\S/.test(last.nodeValue)))) {
    body.removeChild(last);
    last = body.lastChild;
  }
  var endsInBlock = !!(last && last.nodeType === 1 && (last.tagName === "P" || last.tagName === "DIV"));
  return { html: body.innerHTML, media: media, lost: lost, attach: attach, endsInBlock: endsInBlock };
}

export function cellFromClipboard(html, text, opts) {
  opts = opts || {};
  var media = 0, lost = 0;
  var attach = [];
  if (html) {
    var raw = String(html);
    var fromCut = !!(opts.nonce && cutNonceIn(raw) === opts.nonce);
    var prep = prepareHtml(raw, opts);
    media = prep.media;
    lost = prep.lost;
    attach = prep.attach;
    var cell = fromHtml(prep.html, { hasComment: fromCut ? (opts.hasComment || always) : never });
    if (prep.endsInBlock && projection(cell).slice(-1) === "\n") cell = sliceCell(cell, 0, cellLength(cell) - 1);
    if (cellLength(cell)) {
      return { cell: cell, text: null, media: media, lost: lost, attach: attach, fromCut: fromCut, comments: fromCut ? commentIds(cell) : [] };
    }
  }
  var vt = videoLinksInText(text);
  vt.links.forEach(function (href) { addAttachment(attach, { kind: "video", href: href }); });
  var t = vt.text;
  return { cell: normalizeCell([{ text: t, marks: {} }]), text: t, media: media, lost: lost, attach: attach, fromCut: false, comments: [] };
}

// Items added after existing ones, never over them
export function attachToGallery(row, attach) {
  var out = { pictures: 0, videos: 0, links: [] };
  attach.forEach(function (item) {
    if (item.kind === "image") {
      addGalleryPicture(row, item.ref, item.name);
      out.pictures++;
      return;
    }
    var link = item.kind === "video" ? { href: item.href } : { name: item.name, size: item.size, duration: item.duration };
    if (addGalleryVideo(row, link, item.poster || null) !== -1) {
      out.videos++;
      if (link.href) out.links.push(link.href);
    }
  });
  return out;
}

export function brollIdsTaken(state, rowId, field, rest, fromCut) {
  var taken = Object.create(null);
  function keysOf(cell) {
    cell.forEach(function (r) { if (r.atom && r.id) taken[r.id] = true; });
  }
  (state.rows || []).forEach(function (row) {
    ["visualText", "audioText"].forEach(function (f) {
      if (row.id === rowId && f === field && rest) keysOf(rest);
      else keysOf(cellOf(row[f] || ""));
    });
  });
  if (!fromCut) {
    (state.brollShots || []).forEach(function (rec) { if (rec && rec.id) taken[rec.id] = true; });
  }
  return taken;
}

export function freshBrollIds(cell, taken, mint) {
  mint = mint || function () { return makeId("bs"); };
  var used = Object.create(null);
  var minted = [];
  var out = cell.map(function (r) {
    if (!r.atom) return r;
    var id = r.id;
    if (!id || taken[id] || used[id]) {
      var guard = 0;
      do { id = mint(); } while ((taken[id] || used[id]) && ++guard < 100);
      minted.push(id);
    }
    used[id] = true;
    return id === r.id ? r : Object.assign({}, r, { id: id });
  });
  return { cell: out, minted: minted };
}

function brollKeyIds(cell) {
  var ids = [];
  cell.forEach(function (r) { if (r.atom && r.id) ids.push(r.id); });
  return ids;
}

var cutNonce = null;

function isTextField(field) {
  return field === "visualText" || field === "audioText";
}

function commentAnchoredAs(id) {
  return !!S.state && (S.state.comments || []).some(function (c) {
    return c.kind !== "conflict" && (c.anchorId || c.id) === id;
  });
}

function liveCellHtml(cellEl) {
  var html = cellEl.innerHTML;
  if (html.indexOf("\u200B") !== -1) html = html.replace(/\u200B/g, "");
  return storedHtmlFromDom(html);
}

export function copyFromCell(e, cellEl, cut, readOnly) {
  var cd = e.clipboardData;
  var field = cellEl.getAttribute("data-field");
  if (!cd || !S.state || !isTextField(field) || findRowIndex(cellEl.getAttribute("data-id")) === -1) return false;
  var html = liveCellHtml(cellEl);
  if (/<img|video-embed-card/.test(html)) return false;
  var sel = cellSelection(cellEl);
  if (!sel || sel.from === sel.to) return false;
  var moving = cut && !readOnly;
  var nonce = moving ? randomHexBytes(16) : null;
  var out = clipboardOfCell(sliceCell(fromHtml(html), sel.from, sel.to), { keepComments: moving, nonce: nonce });
  cd.setData("text/html", out.html);
  cd.setData("text/plain", out.text);
  e.preventDefault();
  if (!moving) return true;
  cutNonce = nonce;
  editCell(cellEl, function (cell, s) {
    if (!s || s.from === s.to) return null;
    return { cell: deleteRange(cell, s.from, s.to), sel: { from: s.from, to: s.from } };
  });
  return true;
}

export function pasteIntoCell(cellEl, html, text, extra) {
  extra = extra || {};
  var got = cellFromClipboard(html, text, { nonce: cutNonce, hasComment: commentAnchoredAs, skipImages: !!extra.skipImages });
  var attach = (extra.attach || []).slice();
  got.attach.forEach(function (item) { addAttachment(attach, item); });
  var rowId = cellEl.getAttribute("data-id");
  var field = cellEl.getAttribute("data-field");
  var result = { done: true, cellEl: cellEl, media: got.media, lost: got.lost, attached: null,
                 rowIndex: findRowIndex(rowId), field: field, movedComments: false };
  function attachAll() {
    var row = S.state.rows[findRowIndex(rowId)];
    if (!row || !attach.length) return;
    var got2 = attachToGallery(row, attach);
    if (!got2.pictures && !got2.videos) return;
    stampRow(row);
    result.attached = got2;
  }
  if (!cellLength(got.cell)) {
    if (!attach.length || result.rowIndex === -1) return result;
    breakUndoCoalescing();
    attachAll();
    markDirty();
    flushEdits();
    breakUndoCoalescing();
    return result;
  }
  var fresh = editCell(cellEl, function (cell, sel) {
    var from = sel ? sel.from : cellLength(cell);
    var rest = sel ? deleteRange(cell, sel.from, sel.to) : cell;
    var piece = got.text !== null ? got.cell
      : freshBrollIds(got.cell, brollIdsTaken(S.state, rowId, field, rest, got.fromCut)).cell;
    // Visual column has no directions
    if (field === "visualText") piece = flattenDirections(piece);
    if (field === "visualText") piece = flattenCues(piece);
    var next = got.text !== null
      ? insertText(rest, from, got.text)
      : joinCells(joinCells(sliceCell(rest, 0, from), piece), sliceCell(rest, from));
    if (field === "visualText") recordPastedBroll(rowId, next, brollKeyIds(piece));
    var at = from + cellLength(next) - cellLength(rest);
    // Comment move joins paste's undo entry
    var also = null;
    if (got.fromCut || attach.length) {
      also = function () {
        if (got.fromCut) {
          cutNonce = null;
          if (got.comments.length) syncCommentAnchors(S.state);
          result.movedComments = got.comments.length > 0;
        }
        attachAll();
      };
    }
    return { cell: next, sel: { from: at, to: at }, also: also };
  });
  if (!fresh) {
    result.done = false;
    return result;
  }
  result.cellEl = fresh;
  return result;
}

export function readClipboardFiles(files, compress, video) {
  video = video || {};
  var list = Array.prototype.slice.call(files || []);
  var attach = [];
  var skipImages = false;
  var jobs = list.map(function (file) {
    var type = String(file && file.type || "");
    if (type.indexOf("video/") === 0) {
      var item = { kind: "videoFile", name: String(file.name || ""), size: file.size || 0, poster: null };
      attach.push(item);
      if (video.grant) video.grant(file, { name: item.name, size: item.size });
      if (!video.frame) return Promise.resolve();
      return Promise.resolve(video.frame(file)).then(function (got) {
        if (got && got.duration) item.duration = got.duration;
        var rec = got && got.dataUrl ? internDataUrl(got.dataUrl) : null;
        if (!rec) return;
        persist([rec.sha256]);
        item.poster = rec;
      }, function () {});
    }
    if (type.indexOf("image/") !== 0) return Promise.resolve();
    skipImages = true;
    var slot = attach.length;
    attach.push(null);
    return compress(file, 1000, 0.78).then(function (dataUrl) {
      var rec = internDataUrl(dataUrl);
      if (!rec) return;
      persist([rec.sha256]);
      attach[slot] = { kind: "image", ref: rec, name: String(file.name || "") };
    }, function () {});
  });
  return Promise.all(jobs).then(function () {
    var kept = attach.filter(Boolean);
    return { attach: kept, skipImages: skipImages, lost: attach.length - kept.length };
  });
}

export function hasMediaFiles(files) {
  return Array.prototype.some.call(files || [], function (f) {
    return /^(image|video)\//.test(String(f && f.type || ""));
  });
}

export function __init() {}
