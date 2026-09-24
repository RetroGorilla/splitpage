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

/* ================= copy, cut, paste and drop in a script cell (#85, design §5) =================

   What a script cell puts on the clipboard, and what it takes off it, goes
   through the document model (04c-doc-model.js) rather than the browser's
   own contenteditable copy and execCommand("insertHTML"):

   - COPY puts the selected slice of the cell on the clipboard as the
     model's own HTML (toHtml) and its plain text. It never carries a
     comment (design D6): a comment is one conversation about one place in
     the script, and a copy of its words is not that place.
   - CUT then PASTE in the same tab MOVES a comment with its words (D6).
     The cut keeps the comment marks and tags its HTML with a nonce only
     this tab knows, held in memory here and nowhere else. A paste keeps
     comment marks only from HTML carrying the live nonce, and only for
     comments this document still has; everything else pasted — another
     tab's cut, another app, a second paste of the same cut — lands with
     no comment. The moved comment's rowId/field follow its marks
     (syncCommentAnchors, 04c-doc-model.js), so its card and its "jump to"
     point at the new place.
   - PASTE and DROP read the HTML flavour (else the plain text), turn it
     into a cell with fromHtml — the sanitiser first, so nothing foreign
     gets in — and replace the selection with it as one model edit
     (editCell): one undo entry, the caret after what was pasted. Pictures
     and video cards never go in the cell (D7): a script cell holds words.
     Since #124 they are not dropped either, and since #135 each picture,
     video card, video link or video file goes into the scene's gallery —
     its Image section (attachToGallery, below) — in the same undo entry
     as the words that came with it.
   - A pasted B-ROLL KEY gets an id of its own whenever the document
     already knows its id; only a cut moving it keeps it (freshBrollIds,
     below).

   The pure half (what goes on the clipboard, what comes off it) is
   exported for src/test/clipboard.test.mjs; the DOM half is called from
   21-events.js, which keeps everything around it (the refresh of the
   breakdown, the b-roll list and the counters, the caret kept in view). */

var CUT_ATTR = "data-splitpage-cut";

/* ---- the pure half ---- */

function never() { return false; }
function always() { return true; }

/* The cell with every comment mark gone. */
export function stripComments(cell) {
  return normalizeCell(cell, { hasComment: never });
}

/* What a copy or cut of `cell` (a slice) puts on the clipboard: {html,
   text}. opts.keepComments keeps its comment marks (a cut); opts.nonce
   tags the HTML as this tab's cut. The plain text is the words as they
   read, a line break as "\n", a b-roll key as its letters. */
export function clipboardOfCell(cell, opts) {
  opts = opts || {};
  var c = opts.keepComments ? normalizeCell(cell) : stripComments(cell);
  var html = toHtml(c);
  if (opts.nonce) html = "<span " + CUT_ATTR + '="' + String(opts.nonce).replace(/[^A-Za-z0-9]/g, "") + '">' + html + "</span>";
  /* a stage direction as it is shown, "(beat)" (#167) \u2014 the plain text
     another program gets */
  var text = "";
  flattenDirections(c).forEach(function (r) { text += r.text; });
  return { html: html, text: text.replace(/\u00a0/g, " ") };
}

/* The cut nonce clipboard HTML carries, or null. Read off the raw HTML,
   before the sanitiser (which drops the attribute). */
export function cutNonceIn(html) {
  var m = new RegExp(CUT_ATTR + "\\s*=\\s*[\"']?([A-Za-z0-9]+)").exec(String(html == null ? "" : html));
  return m ? m[1] : null;
}

/* ---- what a paste attaches to its scene (#124, #135) ----

   A picture, a video card, a link to a video or a video file pasted or
   dropped into a script cell is not script (D7), and not thrown away
   either: it goes into the scene's gallery (attachToGallery). An item is
   {kind: "image", ref} (a registry record, #82), {kind: "video", href} or
   {kind: "videoFile", name, size, poster} (poster: its first frame's
   record, or null).

   A link counts as a video when it is on a host video cards are made for
   (VIDEO_HOSTS) or names a video file. A video card is one whatever its
   link: someone made it one. */
var VIDEO_HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|loom\.com|dailymotion\.com|dai\.ly|wistia\.com|wistia\.net|wi\.st|twitch\.tv|tiktok\.com|streamable\.com|frame\.io|f\.io|vidyard\.com)$/i;
var VIDEO_FILE_PATH = /\.(mp4|m4v|mov|webm|mkv|avi|ogv)$/i;
var URL_RE = /https?:\/\/[^\s<>"]+/gi;

/* The link, made safe, when it is a video's; else null. */
export function videoLink(href) {
  var safe = safeHref(String(href == null ? "" : href));
  if (!safe || !/^https?:\/\//i.test(safe)) return null;
  try {
    var u = new URL(safe);
    return VIDEO_HOSTS.test(u.hostname) || VIDEO_FILE_PATH.test(u.pathname) ? safe : null;
  } catch (e) { return null; }
}

/* A URL as it stands in text, without the punctuation that ends a sentence. */
function urlInText(u) {
  return videoLink(u.replace(/[.,;:!?)\]]+$/, ""));
}

/* An address without its scheme, "www." or a closing slash: how a link
   whose words are its own address may spell it. */
function bareUrl(u) {
  return String(u).trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "").toLowerCase();
}

/* A key per distinct thing attached, so one paste attaches each once. */
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

/* Plain text's video links: {text, links}. Links standing on their own —
   the whole paste is links and space, a URL copied from the address bar —
   are the attachment and nothing else, so text comes back empty; links
   inside other words stay in the words, and are attached as well. */
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

/* The clipboard's HTML without its pictures and videos — listed in
   `attach`, counted in `media`, and `lost` counting the pictures that only
   name one on the web, which cannot be kept — and whether it ends in a
   paragraph. Taken out BEFORE fromHtml: the model has no place for them.
   opts.skipImages: the paste carries its pictures as files too, and the
   files are what is attached. */
function prepareHtml(html, opts) {
  opts = opts || {};
  var body = inertBody(html);
  var media = 0, lost = 0;
  var attach = [];
  Array.prototype.forEach.call(body.querySelectorAll("img"), function (el) {
    media++;
    if (!opts.skipImages) {
      /* the sanitiser's own reading (#82): a known sha, or an inline
         picture interned; an http src is neither */
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
    /* A card, or a link whose words are only its own address, IS the
       video; a link on other words keeps them, as a link. */
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
  /* What a word processor or a page puts on the clipboard beside the
     words — a style sheet, a script, a title — is not words anyone
     copied; the sanitiser would keep its text as if it were. */
  Array.prototype.forEach.call(body.querySelectorAll("style, script, template, noscript, title, meta, link"), function (el) {
    if (el.parentNode) el.parentNode.removeChild(el);
  });
  /* A copy from a web page or a word processor ends in a paragraph, and
     the sanitiser reads each paragraph as its text plus a line break — so
     one pasted sentence would land with a line break after it. The last
     block's own break is dropped; a blank line copied after it stays.
     Whitespace and HTML comments after it show nothing, and go. */
  var last = body.lastChild;
  while (last && (last.nodeType === 8 || (last.nodeType === 3 && !/\S/.test(last.nodeValue)))) {
    body.removeChild(last);
    last = body.lastChild;
  }
  var endsInBlock = !!(last && last.nodeType === 1 && (last.tagName === "P" || last.tagName === "DIV"));
  return { html: body.innerHTML, media: media, lost: lost, attach: attach, endsInBlock: endsInBlock };
}

/* What a paste or a drop inserts, from the clipboard's HTML (or, when
   that gives nothing, its plain text):
     {cell, text, media, lost, attach, fromCut, comments}
   text is non-null when it came from the plain text, which is inserted as
   typing is (taking on the formatting where it lands); cell is what goes
   in otherwise. media is how many pictures and videos the HTML had, attach
   what is to be attached to the scene (above), lost the pictures that
   cannot be. fromCut: the HTML is this tab's live cut (opts.nonce), and
   only then do comment marks survive — the ones opts.hasComment(id)
   knows, listed in comments. opts.skipImages: see prepareHtml. */
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
  /* A link to a video, as plain text, is attached; so is one the HTML
     gave as a link, whose plain text is its address. */
  var vt = videoLinksInText(text);
  vt.links.forEach(function (href) { addAttachment(attach, { kind: "video", href: href }); });
  var t = vt.text;
  return { cell: normalizeCell([{ text: t, marks: {} }]), text: t, media: media, lost: lost, attach: attach, fromCut: false, comments: [] };
}

/* What a paste attaches, put in the scene's gallery (#135, 02d-gallery.js)
   rather than a comment (#124 made comments; the ones it made stay as
   they are). Each picture and each video is an item of its own, added
   after the ones there (the cover only when the gallery is empty), never
   over them: a video with its thumbnail (a video file's first frame,
   `poster`) or a placeholder, and its link in the lines under the
   gallery, not in the words. Returns {pictures, videos, links}: how many
   of each went in, and the web links among the videos — the ones whose
   thumbnail may be fetched next (#141, 05v-video.js). */
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

/* ---- b-roll keys: one id, one line ----

   A b-roll key carries the id its shot's record is found by (08c-broll.js),
   and a copy of it carries the same id — so a pasted key would be a
   second line claiming the first one's shot. A pasted key keeps its id
   only when nothing in the document has it; otherwise it gets a new one
   (makeId("bs"), as a typed key does):

   - A COPY (and a drop, and a second paste of the same cut) is a new line
     to shoot. Its key's id is taken if any key in the document has it, or
     any record in the b-roll list does — a shot whose line was deleted
     since the copy keeps its status, notes and owner to itself rather than
     handing them to the copy. The new id's record is made fresh, seeded
     from the scene the copy landed in as a typed key's is
     (recordPastedBroll); nothing of the copied shot's own record — shot
     or not, notes, owner, location — comes with it: two identical lines
     are two shots to go and get, and the second one has not been shot.
   - A CUT then its PASTE in this tab (the live cut nonce, design D6) is a
     MOVE: the cut took the key out of the document, so its id is free
     again, and its record — still in the list, orphaned for the moment —
     is found by it once more, status and all. Only another key having the
     id (the cut undone before the paste, say) makes it a new one.

   Several keys in one paste are several lines: a repeat within the paste
   gets a new id too. */

/* The ids a pasted key may not keep, as {id: true}: every key in `state`'s
   script (both columns; the cell being pasted into as `rest`, the cell
   without the selection the paste replaces), and — unless the paste is
   this tab's live cut — every record in the b-roll list. */
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

/* `cell` with every b-roll key whose id is in `taken`, or repeats an
   earlier key's, given a new one from mint() (makeId("bs") by default).
   Returns {cell, minted}: minted lists the new ids. */
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

/* The ids of the b-roll keys in a cell, in order. */
function brollKeyIds(cell) {
  var ids = [];
  cell.forEach(function (r) { if (r.atom && r.id) ids.push(r.id); });
  return ids;
}

/* ---- the DOM half ---- */

/* This tab's live cut: set by a cut, spent by the paste that uses it. */
var cutNonce = null;

function isTextField(field) {
  return field === "visualText" || field === "audioText";
}

/* A comment this document has, named by the id its anchor spans carry. */
function commentAnchoredAs(id) {
  return !!S.state && (S.state.comments || []).some(function (c) {
    return c.kind !== "conflict" && (c.anchorId || c.id) === id;
  });
}

/* The cell's model as it is on screen right now — what syncFieldFromDom
   would store — without storing it: a copy changes nothing. */
function liveCellHtml(cellEl) {
  var html = cellEl.innerHTML;
  if (html.indexOf("\u200B") !== -1) html = html.replace(/\u200B/g, "");
  return storedHtmlFromDom(html);
}

/* A copy (cut false) or cut of the selection inside one script cell.
   Returns false when it is not one this handles — nothing selected, a
   selection reaching outside the cell, a cell still holding a picture —
   and the browser's own copy runs; otherwise the clipboard is written
   and, for a cut, the selection deleted as one model edit. readOnly (a
   review session) makes a cut a copy: nothing there may be deleted. */
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

/* A paste or a drop into a script cell, replacing the selection (or at the
   end of the cell when the selection is elsewhere). `extra` (optional):
   {attach, skipImages} — what the clipboard's files gave (the DOM caller
   reads them, readClipboardFiles below), and whether its pictures replace
   the HTML's. Returns
     {done, cellEl, media, lost, attached, rowIndex, field, movedComments}
   attached: null, or attachToGallery's {pictures, videos} for what
   went into the scene's gallery, in the same undo entry as the words
   (#135). done false
   means nothing went in: the cell holds a picture or a video card, which
   editCell does not edit (05b-cell-edit.js) and which no cell does since
   design D7. */
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
    /* Nothing but what is attached: one edit of its own, as editCell
       would make it — whatever was typed a moment ago is its own entry. */
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
    /* a pasted b-roll key is a line of its own, with an id of its own
       unless this is a cut moving it (see freshBrollIds) */
    var piece = got.text !== null ? got.cell
      : freshBrollIds(got.cell, brollIdsTaken(S.state, rowId, field, rest, got.fromCut)).cell;
    /* The Visual column has no stage directions (#167): one pasted there
       is its words again, in the brackets it was shown with. */
    if (field === "visualText") piece = flattenDirections(piece);
    var next = got.text !== null
      ? insertText(rest, from, got.text)
      : joinCells(joinCells(sliceCell(rest, 0, from), piece), sliceCell(rest, from));
    if (field === "visualText") recordPastedBroll(rowId, next, brollKeyIds(piece));
    var at = from + cellLength(next) - cellLength(rest);
    /* The comment moving is part of the same paste, so it goes in with the
       cell as one undo entry (editCell's also, run once the pasted cell is
       in state, where syncCommentAnchors finds its marks). A cut of part
       of a comment's words leaves the rest marked where they were, and the
       comment points at whichever comes first in the script. What the
       paste attaches goes in the same entry. */
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

/* What a paste's or a drop's files attach (#124), as a promise of
   {attach, skipImages, lost}: each picture made small and put in the
   image registry the way a scene picture is (#82), each video file by its
   name, with its first frame as a picture and its length when
   `video.frame(file)` can read them ({dataUrl, duration}, or null) and `video.grant(file)` told about it —
   the desktop app remembers where it is, for its caption's link to open
   (#135). skipImages is true when a picture came as a file — the HTML
   beside it (a picture copied from a page) names the same one. Anything
   else is not this paste's to attach. */
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
        /* {dataUrl, duration}, or null */
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
    /* lost: pictures that would not read as one */
    return { attach: kept, skipImages: skipImages, lost: attach.length - kept.length };
  });
}

/* Whether a paste or a drop carries files this attaches. */
export function hasMediaFiles(files) {
  return Array.prototype.some.call(files || [], function (f) {
    return /^(image|video)\//.test(String(f && f.type || ""));
  });
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {}
