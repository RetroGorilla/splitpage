import { cellSelection, setCellSelection } from "../common/cell-selection.ts";
import { isDraftBox } from "./cell-page.ts";
import { clamp, clampRange, deleteRange, insertCell, insertText, markThroughout, setMark } from "../../core/text/edits.ts";
import { toHtml } from "../../core/text/html.ts";
import { cellLength, normalizeCell, projection } from "../../core/text/runs.ts";
var ports = null;

var PUA_FIRST = 0xE000;
var PUA_LAST = 0xF8FF;
var PUA_RE = /[\uE000-\uF8FF]/g;
var HISTORY_LIMIT = 200;
var TYPING_PAUSE_MS = 800;

function isMediaEl(node) {
  if (!node || node.nodeType !== 1) return false;
  if (node.tagName === "IMG") return true;
  return node.tagName === "A" && !!node.classList && node.classList.contains("video-embed-card");
}

export function mediaTable(texts) {
  var reserved = {};
  (texts || []).forEach(function (t) {
    String(t == null ? "" : t).replace(PUA_RE, function (ch) { reserved[ch] = true; return ch; });
  });
  var next = PUA_FIRST;
  var table = {
    media: {},
    add: function (html) {
      while (next <= PUA_LAST && reserved[String.fromCharCode(next)]) next++;
      if (next > PUA_LAST) return "";
      var ch = String.fromCharCode(next++);
      reserved[ch] = true;
      table.media[ch] = html;
      return ch;
    },
    isMedia: function (ch) { return Object.prototype.hasOwnProperty.call(table.media, ch); },
    cell: function (html) { return ports.text.fromHtml(liftMedia(html, table)); },
    html: function (cell) { return dropMedia(toHtml(stripMediaMarks(cell, table.isMedia)), table); },
    markThroughout: function (cell, from, to, name) { return markThroughoutText(cell, from, to, name, table.isMedia); },
    toggleMark: function (cell, from, to, name) {
      return setMark(cell, from, to, name, !markThroughoutText(cell, from, to, name, table.isMedia));
    }
  };
  return table;
}

export function liftMedia(html, table) {
  var body = ports.text.inertBody(ports.text.sanitizeHtml(html == null ? "" : String(html)));
  var found = [];
  (function walk(node) {
    for (var c = node.firstChild; c; c = c.nextSibling) {
      if (isMediaEl(c)) found.push(c);
      else if (c.nodeType === 1) walk(c);
    }
  })(body);
  found.forEach(function (el) {
    var ch = table.add(el.outerHTML);
    if (ch) el.parentNode.replaceChild(body.ownerDocument.createTextNode(ch), el);
    else el.parentNode.removeChild(el);
  });
  return body.innerHTML;
}

function dropMedia(html, table) {
  return html.replace(PUA_RE, function (ch) { return table.isMedia(ch) ? table.media[ch] : ch; });
}

export function stripMediaMarks(cell, isMedia) {
  var out = [];
  normalizeCell(cell).forEach(function (r) {
    if (r.atom) { out.push(r); return; }
    var buf = "";
    for (var i = 0; i < r.text.length; i++) {
      var ch = r.text[i];
      if (!isMedia(ch)) { buf += ch; continue; }
      if (buf) out.push({ text: buf, marks: r.marks });
      buf = "";
      out.push({ text: ch, marks: {} });
    }
    if (buf) out.push({ text: buf, marks: r.marks });
  });
  return normalizeCell(out);
}

export function markThroughoutText(cell, from, to, name, isMedia) {
  var a = Math.min(from, to), b = Math.max(from, to);
  var proj = projection(cell);
  var seen = false, start = a;
  for (var i = a; i <= b; i++) {
    if (i < b && !isMedia(proj[i])) continue;
    if (i > start) {
      var words = proj.slice(start, i).replace(/[\n\uFFFC]/g, "");
      if (words) {
        if (!markThroughout(cell, start, i, name)) return false;
        seen = true;
      }
    }
    start = i + 1;
  }
  return seen;
}

export function newHistory(snap) {
  return { stack: [snap], index: 0, pending: false, kind: null, lastSel: null };
}

export function historyCommit(h, snap) {
  if (!h.pending) return false;
  h.pending = false;
  h.kind = null;
  if (snap.html === h.stack[h.index].html) {
    h.stack[h.index].sel = snap.sel;
    return false;
  }
  historyPush(h, snap);
  return true;
}

export function historyPush(h, snap) {
  h.stack.length = h.index + 1;
  h.stack.push(snap);
  if (h.stack.length > HISTORY_LIMIT) h.stack.splice(0, h.stack.length - HISTORY_LIMIT);
  h.index = h.stack.length - 1;
  h.pending = false;
  h.kind = null;
}

export function historyNoteSelection(h, sel) {
  if (!h.pending && sel) h.stack[h.index].sel = sel;
}

export function historyUndo(h, now) {
  historyCommit(h, now);
  if (h.index === 0) return null;
  h.index--;
  return h.stack[h.index];
}

export function historyRedo(h, now) {
  if (h.pending) { historyCommit(h, now); return null; }
  if (h.index >= h.stack.length - 1) return null;
  h.index++;
  return h.stack[h.index];
}

var histories = new WeakMap();
var timers = new Map();
var composing = new WeakSet();

function boxHtml(box) {
  var html = box.innerHTML;
  if (html.indexOf("\u200B") !== -1) html = html.replace(/\u200B/g, "");
  return ports.text.storedHtmlFromDom(html);
}

function snapshot(box) {
  return { html: boxHtml(box), sel: cellSelection(box) };
}

function historyFor(box) {
  var h = histories.get(box);
  if (!h) {
    h = newHistory(snapshot(box));
    histories.set(box, h);
  }
  return h;
}

function clearTimer(box) {
  var t = timers.get(box);
  if (t) clearTimeout(t);
  timers.delete(box);
}

function commitTyping(box) {
  clearTimer(box);
  var h = histories.get(box);
  if (h && h.pending) historyCommit(h, snapshot(box));
}

export function resetDraftHistory(box) {
  if (!box) return;
  clearTimer(box);
  histories.delete(box);
}

export function draftModel(box, reserve) {
  var html = boxHtml(box);
  var table = mediaTable([html].concat(reserve || []));
  return { cell: table.cell(html), media: table, html: html };
}

export function editDraft(box, fn, reserve) {
  if (!isDraftBox(box)) return null;
  var h = historyFor(box);
  commitTyping(box);
  var sel = cellSelection(box);
  historyNoteSelection(h, sel);
  var m = draftModel(box, reserve);
  var out = fn(m.cell, sel, m.media);
  if (!out || !out.cell) return null;
  var next = m.media.html(out.cell);
  if (next !== m.html) box.innerHTML = next;
  box.focus({ preventScroll: true });
  if (out.sel) setCellSelection(box, out.sel.from, out.sel.to);
  if (next !== m.html) historyPush(h, { html: boxHtml(box), sel: out.sel || null });
  else historyNoteSelection(h, out.sel || null);
  return box;
}

function restore(box, snap) {
  box.innerHTML = snap.html;
  box.focus({ preventScroll: true });
  if (snap.sel) setCellSelection(box, snap.sel.from, snap.sel.to);
  else {
    var r = document.createRange();
    r.selectNodeContents(box);
    r.collapse(false);
    var s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }
}

export function draftUndo(box) {
  if (!isDraftBox(box) || composing.has(box)) return false;
  clearTimer(box);
  var snap = historyUndo(historyFor(box), snapshot(box));
  if (snap) restore(box, snap);
  return !!snap;
}

export function draftRedo(box) {
  if (!isDraftBox(box) || composing.has(box)) return false;
  clearTimer(box);
  var snap = historyRedo(historyFor(box), snapshot(box));
  if (snap) restore(box, snap);
  return !!snap;
}

export function noteDraftBeforeInput(box, e) {
  if (!isDraftBox(box)) return;
  var h = historyFor(box);
  if (e.isComposing || composing.has(box)) return;
  var kind = /^delete/.test(e.inputType || "") ? "delete" : "insert";
  var sel = cellSelection(box);
  if (h.pending) {
    var jumped = !sel || !h.lastSel || sel.from !== h.lastSel.to || sel.to !== h.lastSel.to;
    if (kind !== h.kind || jumped) {
      clearTimer(box);
      historyCommit(h, { html: boxHtml(box), sel: sel });
    }
  } else {
    historyNoteSelection(h, sel);
  }
  h.kind = kind;
}

export function noteDraftInput(box) {
  if (!isDraftBox(box)) return;
  var h = historyFor(box);
  h.pending = true;
  h.lastSel = cellSelection(box);
  schedulePauseCommit(box);
}

function schedulePauseCommit(box) {
  clearTimer(box);
  timers.set(box, setTimeout(function () {
    timers.delete(box);
    if (composing.has(box)) return;
    commitTyping(box);
  }, TYPING_PAUSE_MS));
}

export function noteDraftComposition(box, on) {
  if (!isDraftBox(box)) return;
  if (on) {
    var hs = historyFor(box);
    commitTyping(box);
    historyNoteSelection(hs, cellSelection(box));
    composing.add(box);
  } else {
    composing.delete(box);
    var h = histories.get(box);
    if (h && h.pending) schedulePauseCommit(box);
  }
}

export function noteDraftFocus(box) {
  if (isDraftBox(box)) historyFor(box);
}

export function pasteIntoDraft(box, html, text) {
  var clean = html ? ports.text.sanitizeHtml(html) : "";
  if (!clean && !text) return null;
  return editDraft(box, function (cell, sel, media) {
    var r = sel ? clampRange(cell, sel.from, sel.to) : { from: cellLength(cell), to: cellLength(cell) };
    var rest = deleteRange(cell, r.from, r.to);
    var from = clamp(rest, r.from);
    var next = clean ? insertCell(rest, from, media.cell(clean)).cell : insertText(rest, from, text);
    var at = from + cellLength(next) - cellLength(rest);
    return { cell: next, sel: { from: at, to: at } };
  }, [clean, text]);
}

export function appendDraftMedia(box, mediaHtml) {
  return editDraft(box, function (cell, sel, media) {
    var ch = media.add(mediaHtml);
    if (!ch) return null;
    var n = cellLength(cell);
    return { cell: insertText(cell, n, "\n" + ch + "\n", {}), sel: sel || { from: n + 2, to: n + 2 } };
  }, [mediaHtml]);
}

export function __init(given) {
  ports = given;
  histories = new WeakMap();
  composing = new WeakSet();
  var disposed = false;
  return { dispose: function () {
    if (disposed) return;
    disposed = true;
    timers.forEach(function (timer) { clearTimeout(timer); });
    timers.clear();
    histories = new WeakMap();
    composing = new WeakSet();
    ports = null;
  } };
}
