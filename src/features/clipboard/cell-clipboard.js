import { rowIndexOf } from "../../core/document/rows.ts";
import { cellLength, commentIds, normalizeCell, projection } from "../../core/text/runs.ts";
import { sliceCell } from "../../core/text/edits.ts";
import { flattenDirections } from "../../core/text/directions.ts";
import { toHtml } from "../../core/text/html.ts";
import {
  attachToGallery,
  cutCommand,
  freshBrollIds as freshIds,
  pasteCommand,
  takenBrollIds
} from "../../application/commands/clipboard.ts";
import { safeHref } from "../../core/document/text-policy.ts";

export { attachToGallery };

var CUT_ATTR = "data-splitpage-cut";

var ports = null;

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

function prepareHtml(html, opts) {
  opts = opts || {};
  var body = ports.text.inertBody(html);
  var media = 0, lost = 0;
  var attach = [];
  Array.prototype.forEach.call(body.querySelectorAll("img"), function (el) {
    media++;
    if (!opts.skipImages) {
      var ref = ports.imageRefOf(el);
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
    var cell = ports.text.fromHtml(prep.html, { hasComment: fromCut ? (opts.hasComment || always) : never });
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

export function brollIdsTaken(state, rowId, field, rest, fromCut) {
  return takenBrollIds(state, rowId, field, rest, fromCut, ports.text.cellOf);
}

export function freshBrollIds(cell, taken, mint) {
  return freshIds(cell, taken, mint || function () { return ports.ids.id("bs"); });
}

function clipboardPorts() {
  return {
    clock: ports.edits.text.clock,
    editor: ports.edits.text.editor,
    cells: ports.edits.text.cells,
    ids: ports.ids,
    brollSeed: ports.brollSeed
  };
}

var cutNonce = null;

function isTextField(field) {
  return field === "visualText" || field === "audioText";
}

function holdsDocument() {
  return ports.document.read(function (doc) { return !!doc; });
}

function commentAnchoredAs(id) {
  return ports.document.read(function (doc) {
    return !!doc && (doc.comments || []).some(function (c) {
      return c.kind !== "conflict" && (c.anchorId || c.id) === id;
    });
  });
}

function anchoredInText(id, target) {
  return ports.document.read(function (doc) {
    return !!doc && doc.rows.some(function (row) {
      return ["visualText", "audioText"].some(function (field) {
        var cell = target.rowId === row.id && target.field === field ? target.rest : ports.text.cellOf(typeof row[field] === "string" ? row[field] : "");
        return commentIds(cell).indexOf(id) !== -1;
      });
    });
  });
}

function liveCellHtml(cellEl) {
  var html = cellEl.innerHTML;
  if (html.indexOf("\u200B") !== -1) html = html.replace(/\u200B/g, "");
  return ports.text.storedHtmlFromDom(html);
}

function outsideSelection(cellEl) {
  var cell = ports.text.fromHtml(liveCellHtml(cellEl));
  var sel = ports.selection(cellEl);
  if (!sel) return cell;
  var len = cellLength(cell);
  return sliceCell(cell, 0, Math.min(sel.from, len)).concat(sliceCell(cell, Math.min(sel.to, len), len));
}

export function copyFromCell(e, cellEl, cut, readOnly) {
  var cd = e.clipboardData;
  var field = cellEl.getAttribute("data-field");
  if (!cd || !holdsDocument() || !isTextField(field) || ports.document.read(function (doc) { return rowIndexOf(doc, cellEl.getAttribute("data-id")); }) === -1) return false;
  var html = liveCellHtml(cellEl);
  if (/<img|video-embed-card/.test(html)) return false;
  var sel = ports.selection(cellEl);
  if (!sel || sel.from === sel.to) return false;
  var moving = cut && !readOnly;
  var nonce = moving ? ports.nonce() : null;
  var out = clipboardOfCell(sliceCell(ports.text.fromHtml(html), sel.from, sel.to), { keepComments: moving, nonce: nonce });
  cd.setData("text/html", out.html);
  cd.setData("text/plain", out.text);
  e.preventDefault();
  if (!moving) return true;
  cutSelection(cellEl);
  cutNonce = nonce;
  return true;
}

function storedField(rowId, field) {
  return ports.document.read(function (doc) {
    var row = doc && doc.rows.find(function (r) { return r.id === rowId; });
    return row && row[field] ? row[field] : "";
  });
}

function caretOf(caret) {
  return caret === null ? null : { from: caret, to: caret };
}

function cutSelection(cellEl) {
  ports.paintGuard.whileShown(function () { cutShown(cellEl); });
}

function cutShown(cellEl) {
  var open = ports.cells.open(cellEl);
  if (!open || !open.sel || open.sel.from === open.sel.to) return;
  var cut = cutCommand(open.rowId, open.field, open.sel, clipboardPorts());
  var outcome = ports.edits.run(cut.command);
  if (outcome.kind === "failed") throw outcome.error;
  if (outcome.kind === "rejected") return;
  ports.cells.close(cellEl, storedField(open.rowId, open.field), caretOf(cut.report().caret));
}

function pasteRequest(rowId, field, range, pasted, got, attach) {
  return { rowId: rowId, field: field, range: range, pasted: pasted, fromCut: got.fromCut, comments: got.comments, attach: attach };
}

export function pasteIntoCell(cellEl, html, text, extra) {
  return ports.paintGuard.whileShown(function () { return pasteShown(cellEl, html, text, extra); });
}

function pasteShown(cellEl, html, text, extra) {
  extra = extra || {};
  var target = null;
  var hasComment = function (id) {
    if (!commentAnchoredAs(id)) return false;
    if (!target) target = { rowId: cellEl.getAttribute("data-id"), field: cellEl.getAttribute("data-field"), rest: outsideSelection(cellEl) };
    return !anchoredInText(id, target);
  };
  var got = cellFromClipboard(html, text, { nonce: cutNonce, hasComment: hasComment, skipImages: !!extra.skipImages });
  var attach = (extra.attach || []).slice();
  got.attach.forEach(function (item) { addAttachment(attach, item); });
  var rowId = cellEl.getAttribute("data-id");
  var field = cellEl.getAttribute("data-field");
  var result = { done: true, cellEl: cellEl, media: got.media, lost: got.lost, attached: null,
                 rowIndex: ports.document.read(function (doc) { return rowIndexOf(doc, rowId); }), field: field, movedComments: false };
  if (!cellLength(got.cell)) {
    if (!attach.length || result.rowIndex === -1) return result;
    ports.undo.breakCoalescing();
    var gallery = pasteCommand(pasteRequest(rowId, field, null, null, got, attach), clipboardPorts());
    var galleryOutcome = ports.edits.run(gallery.command);
    if (galleryOutcome.kind === "failed") throw galleryOutcome.error;
    result.attached = gallery.report().attached;
    ports.undo.flush();
    ports.undo.breakCoalescing();
    return result;
  }
  var open = ports.cells.open(cellEl);
  if (!open) {
    result.done = false;
    return result;
  }
  var pasted = got.text !== null ? { kind: "text", text: got.text } : { kind: "cell", runs: got.cell };
  var paste = pasteCommand(pasteRequest(rowId, field, open.sel, pasted, got, attach), clipboardPorts());
  var outcome = ports.edits.run(paste.command);
  if (outcome.kind === "failed") throw outcome.error;
  if (outcome.kind === "rejected") {
    result.done = false;
    return result;
  }
  if (got.fromCut) {
    cutNonce = null;
    result.movedComments = got.comments.length > 0;
  }
  var report = paste.report();
  result.attached = report.attached;
  result.cellEl = ports.cells.close(cellEl, storedField(rowId, field), caretOf(report.caret));
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
        var rec = got && got.dataUrl ? ports.pictures.internDataUrl(got.dataUrl) : null;
        if (!rec) return;
        ports.pictures.persist([rec.sha256]);
        item.poster = rec;
      }, function () {});
    }
    if (type.indexOf("image/") !== 0) return Promise.resolve();
    skipImages = true;
    var slot = attach.length;
    attach.push(null);
    return compress(file, 1000, 0.78).then(function (dataUrl) {
      var rec = ports.pictures.internDataUrl(dataUrl);
      if (!rec) return;
      ports.pictures.persist([rec.sha256]);
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

export function __init(given) {
  ports = given;
  cutNonce = null;
  return { dispose: function () { cutNonce = null; } };
}
