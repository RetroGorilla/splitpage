import { S } from "./_state.js";
import { STATE_FIELDS } from "./02-state.js";
import { applySteps, fromHtml, invertSteps, mergeCells, normalizeCell, toHtml } from "./04c-doc-model.js";

/* ================= undo and redo (issue #85, docs/DOCUMENT-MODEL.md §7) =================

   One stack per tab, for everything a person does to the document: typing,
   formatting, tags, b-roll, comments, rows (add, delete, move, split,
   join), scene status and picture, the production panel, the title,
   Replace All, an import into the document. It replaces the browser's own
   contenteditable undo (which every repaint destroyed) and the one-level
   split/move undo 06-rows.js used to keep.

   HOW A CHANGE IS RECORDED. Not by every edit path building its own undo
   record — there are dozens, and a path that forgot would be a hole — but
   by comparing. `base` is a private copy of the document as of the last
   recorded change. Every edit already ends in markDirty(); markDirty calls
   noteEdit(), which (once per task, in a microtask) diffs the live document
   against `base` (diffStates), records the difference as one entry of steps
   (04c-doc-model.js), and moves `base` on by those steps. So an edit path
   is covered by being an edit path, and a new one needs nothing.

   WHAT IS NOT RECORDED (design §7): opening a document, restoring a
   version, and someone else's changes arriving. Those change what the
   document is rather than edit it, and version history covers them. Each
   replaces S.state with a new object; a diff that finds S.state is not the
   object `base` was copied from starts again from it, with an empty stack.
   A merge that folds someone else's changes into this document tells this
   file first (noteRemoteChange), and only the entries touching what it
   changed are forgotten (design D4): Ctrl+Z never reverts their words.

   Comments on a server document (design D5) are recorded only until sent,
   and a comment is sent the moment it is posted — so on a server document
   a change to the comments list is not recorded at all, and neither is the
   cell change that anchored it.

   Undo never overwrites what it does not own. A cell is put back by a
   three-way merge (base: what the entry left, mine: what is there now,
   theirs: what the entry found), so a change made since — a registry heal,
   an idle b-roll anchoring — survives the undo; a list (the registry, the
   crew, the b-roll list) by its own merge. Where that cannot be done
   cleanly the undo refuses whole and says so, and the entry is dropped. */

/* Fields that are the document's bookkeeping, not its content. */
var SKIP_DOC_KEYS = { docId: true, rev: true, lastEditedBy: true, lastEditedAt: true, schema: true, rows: true };
var SKIP_ROW_KEYS = { id: true, updatedAt: true, updatedBy: true };
var TEXT_KEYS = { visualText: true, audioText: true };
var COALESCE_MS = 1000;
var MAX_ENTRIES = 200;

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
function same(a, b) { return a === b || JSON.stringify(a) === JSON.stringify(b); }

function docKeys(before, after) {
  var keys = {};
  STATE_FIELDS.forEach(function (f) { keys[f.key] = true; });
  Object.keys(before || {}).forEach(function (k) { keys[k] = true; });
  Object.keys(after || {}).forEach(function (k) { keys[k] = true; });
  return Object.keys(keys).filter(function (k) { return !SKIP_DOC_KEYS[k]; });
}

function rowsEqualIgnoringStamps(a, b) {
  if (!a || !b) return false;
  var keys = {};
  Object.keys(a).forEach(function (k) { keys[k] = true; });
  Object.keys(b).forEach(function (k) { keys[k] = true; });
  return Object.keys(keys).every(function (k) {
    return k === "updatedAt" || k === "updatedBy" || same(a[k], b[k]);
  });
}

/* ---- the diff ----

   Steps that take `before` to `after` (04c-doc-model.js step shapes):
   rows deleted, then every field of the rows both hold, then rows
   inserted and moved into `after`'s order. opts.skip names top-level keys
   left out. Pure. */
export function diffStates(before, after, opts) {
  var skip = (opts && opts.skip) || {};
  var steps = [];
  var bRows = (before && before.rows) || [], aRows = (after && after.rows) || [];
  var aById = {}, bById = {};
  aRows.forEach(function (r) { if (r && r.id) aById[r.id] = r; });
  bRows.forEach(function (r) { if (r && r.id) bById[r.id] = r; });

  /* rows gone */
  var work = bRows.map(function (r) { return r.id; });
  for (var i = work.length - 1; i >= 0; i--) {
    if (!aById[work[i]]) {
      steps.push({ op: "deleteRow", index: i, row: clone(bById[work[i]]) });
      work.splice(i, 1);
    }
  }
  /* fields of the rows both hold */
  work.forEach(function (id) {
    var b = bById[id], a = aById[id];
    var keys = {};
    Object.keys(b).forEach(function (k) { keys[k] = true; });
    Object.keys(a).forEach(function (k) { keys[k] = true; });
    Object.keys(keys).forEach(function (k) {
      if (SKIP_ROW_KEYS[k] || same(b[k], a[k])) return;
      steps.push({ op: "rowField", rowId: id, key: k, before: clone(b[k]), after: clone(a[k]) });
    });
  });
  /* rows new, and rows in a new place */
  for (i = 0; i < aRows.length; i++) {
    var want = aRows[i].id;
    if (work[i] === want) continue;
    var j = work.indexOf(want);
    if (j === -1) {
      steps.push({ op: "insertRow", index: i, row: clone(aRows[i]) });
      work.splice(i, 0, want);
    } else {
      steps.push({ op: "moveRow", from: j, to: i });
      work.splice(j, 1);
      work.splice(i, 0, want);
    }
  }
  /* everything else about the document */
  docKeys(before, after).forEach(function (k) {
    if (skip[k] || same(before[k], after[k])) return;
    steps.push({ op: "docField", key: k, before: clone(before[k]), after: clone(after[k]) });
  });
  return steps;
}

/* ---- applying steps to the live document, in place ----

   The live document is mutated where it stands (the app holds references
   into S.state.rows), and only after every step has been checked, so a
   refusal changes nothing. A step's `before` must be what is there — or,
   for a cell or a list, what is there must merge cleanly with it (see the
   top of this file). Returns {ok:true} or {ok:false, reason}. */
/* Looked up when first needed, never at evaluation time: STATE_FIELDS is
   another module's, and the import graph has cycles (_entry.js). */
var listMerges = null;
function listMergeFor(key) {
  if (!listMerges) {
    listMerges = {};
    STATE_FIELDS.forEach(function (f) { if (f.mergeList) listMerges[f.key] = f.mergeList; });
  }
  return listMerges[key] || null;
}

function resolveCell(live, step) {
  if (live === step.before) return { value: step.after };
  var mine = fromHtml(live), base = fromHtml(step.before), want = fromHtml(step.after);
  if (JSON.stringify(mine) === JSON.stringify(base)) return { value: step.after };
  var r = mergeCells(base, mine, want);
  if (r.conflict) return null;
  return { value: toHtml(normalizeCell(r.cell)) };
}

export function applyStepsLive(state, steps) {
  /* Plan on a scratch copy of the row order, so indexes are checked in
     sequence without touching the document. */
  var order = state.rows.map(function (r) { return r.id; });
  var byId = {};
  state.rows.forEach(function (r) { byId[r.id] = r; });
  var plan = [];
  for (var n = 0; n < steps.length; n++) {
    var s = steps[n];
    if (s.op === "rowField") {
      var row = byId[s.rowId];
      if (!row || order.indexOf(s.rowId) === -1) return { ok: false, reason: "a scene it changed has gone" };
      if (TEXT_KEYS[s.key]) {
        var cell = resolveCell(row[s.key] == null ? "" : row[s.key], {
          before: s.before == null ? "" : s.before, after: s.after == null ? "" : s.after
        });
        if (!cell) return { ok: false, reason: "that scene's text has changed since" };
        plan.push({ op: "set", row: row, key: s.key, value: cell.value });
      } else {
        if (!same(row[s.key], s.before)) return { ok: false, reason: "that scene has changed since" };
        plan.push({ op: "set", row: row, key: s.key, value: clone(s.after) });
      }
    } else if (s.op === "docField") {
      var live = state[s.key];
      var value;
      if (same(live, s.before)) value = clone(s.after);
      else if (listMergeFor(s.key)) value = listMergeFor(s.key)(clone(s.before), clone(live), clone(s.after));
      else return { ok: false, reason: "it has changed since" };
      plan.push({ op: "doc", key: s.key, value: value });
    } else if (s.op === "insertRow") {
      if (s.index < 0 || s.index > order.length || byId[s.row.id] && order.indexOf(s.row.id) !== -1) {
        return { ok: false, reason: "the scene list has changed since" };
      }
      order.splice(s.index, 0, s.row.id);
      byId[s.row.id] = clone(s.row);
      plan.push({ op: "insert", index: s.index, row: byId[s.row.id] });
    } else if (s.op === "deleteRow") {
      if (order[s.index] !== s.row.id || !rowsEqualIgnoringStamps(byId[s.row.id], s.row)) {
        return { ok: false, reason: "that scene has changed since" };
      }
      order.splice(s.index, 1);
      plan.push({ op: "delete", index: s.index });
    } else if (s.op === "moveRow") {
      if (!order[s.from] || s.to < 0 || s.to >= order.length) return { ok: false, reason: "the scene list has changed since" };
      order.splice(s.to, 0, order.splice(s.from, 1)[0]);
      plan.push({ op: "move", from: s.from, to: s.to });
    } else {
      return { ok: false, reason: "unknown step" };
    }
  }
  plan.forEach(function (p) {
    if (p.op === "set") {
      if (p.value === undefined) delete p.row[p.key]; else p.row[p.key] = p.value;
    } else if (p.op === "doc") {
      if (p.value === undefined) delete state[p.key]; else state[p.key] = p.value;
    } else if (p.op === "insert") {
      state.rows.splice(p.index, 0, p.row);
    } else if (p.op === "delete") {
      state.rows.splice(p.index, 1);
    } else if (p.op === "move") {
      state.rows.splice(p.to, 0, state.rows.splice(p.from, 1)[0]);
    }
  });
  return { ok: true };
}

/* ---- the history ----

   Pure over whatever state it is handed, so it is unit-tested directly.
   An entry is {steps, at, cell, textOnly, endsInSpace}: `cell` is
   "rowId\u0000field" when every step is that one cell's text, which is
   what lets typing coalesce. */

function onlyCell(steps) {
  if (steps.length !== 1) return null;
  var s = steps[0];
  return s.op === "rowField" && TEXT_KEYS[s.key] ? s.rowId + "\u0000" + s.key : null;
}

/* The text a step inserted, by common prefix and suffix of the two cells'
   words. Enough to tell "a space was typed" from "a letter was". */
function insertedText(step) {
  var a = projectionOf(step.before), b = projectionOf(step.after);
  var p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  var sa = a.length, sb = b.length;
  while (sa > p && sb > p && a[sa - 1] === b[sb - 1]) { sa--; sb--; }
  return b.slice(p, sb);
}

function projectionOf(html) {
  var out = "";
  normalizeCell(fromHtml(html == null ? "" : html)).forEach(function (r) { out += r.atom ? "\uFFFC" : r.text; });
  return out;
}

export function createUndoHistory() {
  var done = [], undone = [];

  function record(steps, now) {
    if (!steps.length) return;
    undone.length = 0;
    var cell = onlyCell(steps);
    var last = done[done.length - 1];
    if (cell && last && last.cell === cell && now - last.at < COALESCE_MS) {
      var ins = insertedText(steps[0]);
      /* A letter typed after a space starts the next word's entry. The
         browser often rewrites the space before it as it goes (a no-break
         space becomes a plain one), so the inserted text can begin with
         whitespace: what counts is that it holds something that is not. */
      var startsWord = /\S/.test(ins) && last.endsInSpace;
      if (!startsWord) {
        last.steps[0].after = steps[0].after;
        last.at = now;
        if (ins) last.endsInSpace = /\s$/.test(ins);
        return;
      }
    }
    done.push({ steps: steps, at: now, cell: cell, endsInSpace: cell ? /\s$/.test(insertedText(steps[0])) : false });
    if (done.length > MAX_ENTRIES) done.shift();
  }

  function step(from, to, state, invert) {
    var entry = from.pop();
    if (!entry) return { ok: false, empty: true };
    var steps = invert ? invertSteps(entry.steps) : entry.steps;
    var r = applyStepsLive(state, steps);
    if (!r.ok) return { ok: false, reason: r.reason, steps: steps };
    to.push(entry);
    return { ok: true, steps: steps };
  }

  /* Forget every entry that touches what `touched` says changed:
     {cells: {"rowId\u0000field": true}, rowFields: {"rowId\u0000key": true},
      structure: bool, doc: {key: true}}. */
  function forget(touched) {
    function hits(entry) {
      return entry.steps.some(function (s) {
        if (s.op === "rowField") return !!touched.rowFields[s.rowId + "\u0000" + s.key];
        if (s.op === "docField") return !!touched.doc[s.key];
        return !!touched.structure;
      });
    }
    function keep(list) {
      var kept = list.filter(function (e) { return !hits(e); });
      list.length = 0;
      kept.forEach(function (e) { list.push(e); });
    }
    keep(done);
    keep(undone);
  }

  return {
    record: record,
    undo: function (state) { return step(done, undone, state, true); },
    redo: function (state) { return step(undone, done, state, false); },
    forget: forget,
    breakCoalescing: function () { var last = done[done.length - 1]; if (last) last.cell = null; },
    clear: function () { done.length = 0; undone.length = 0; },
    sizes: function () { return { undo: done.length, redo: undone.length }; }
  };
}

/* What changed between two versions of the document, as forget() takes
   it: which rows' fields, whether the scene list's membership or order,
   which document fields. */
export function changedBetween(prev, next) {
  var out = { rowFields: {}, structure: false, doc: {} };
  var p = (prev && prev.rows) || [], n = (next && next.rows) || [];
  var pById = {};
  p.forEach(function (r) { if (r) pById[r.id] = r; });
  if (p.length !== n.length || p.some(function (r, i) { return !n[i] || n[i].id !== r.id; })) out.structure = true;
  n.forEach(function (r) {
    var o = pById[r.id];
    if (!o) return;
    var keys = {};
    Object.keys(o).forEach(function (k) { keys[k] = true; });
    Object.keys(r).forEach(function (k) { keys[k] = true; });
    Object.keys(keys).forEach(function (k) {
      if (!SKIP_ROW_KEYS[k] && !same(o[k], r[k])) out.rowFields[r.id + "\u0000" + k] = true;
    });
  });
  docKeys(prev, next).forEach(function (k) {
    if (!same(prev && prev[k], next && next[k])) out.doc[k] = true;
  });
  return out;
}

/* ================= the app's one history ================= */

var history = createUndoHistory();
var base = null;          /* a private copy of the document as last recorded */
var tracked = null;       /* the S.state object `base` was copied from */
var flushQueued = false;
var applying = false;
/* Set by the page (21-events.js): is this a document whose comments are
   sent the moment they are posted? (design D5) */
var commentsAreSent = function () { return false; };
var hooks = { afterApply: null, onRefused: null };

export function configureUndo(opts) {
  if (opts.commentsAreSent) commentsAreSent = opts.commentsAreSent;
  if (opts.afterApply) hooks.afterApply = opts.afterApply;
  if (opts.onRefused) hooks.onRefused = opts.onRefused;
}

function restart() {
  history.clear();
  tracked = S.state || null;
  base = tracked ? clone(tracked) : null;
}

/* The document on screen is not the one the stack is about (it was opened,
   restored, replaced): start again from it. render() calls this first, so
   the copy is taken before anyone can type into what it drew. */
export function trackDocument() {
  if (applying || S.state === tracked) return;
  flushQueued = false;
  restart();
}

/* Record whatever changed since the last time. Called in a microtask after
   markDirty (noteEdit), and first thing before an undo, a redo or a remote
   change, so nothing typed a moment ago is left out of the stack. */
export function flushEdits() {
  flushQueued = false;
  if (applying) return;
  if (!S.state) { tracked = null; base = null; history.clear(); return; }
  if (S.state !== tracked || !base) { restart(); return; }
  var skip = {};
  if (commentsAreSent()) skip.comments = true;
  var steps = diffStates(base, S.state);
  /* A change to a server document's comments is not recorded (D5), and
     nor is anything that came with it — the anchor wrapped round the
     words it is about. */
  var sent = skip.comments && steps.some(function (s) { return s.op === "docField" && s.key === "comments"; });
  /* A cell written out again in a different form with the same content
     (the sanitiser's nesting, then the model's) is not something anyone
     did: `base` follows it, and no entry is made for it. */
  var content = steps.filter(function (s) { return !cosmetic(s); });
  if (!sent && content.length) history.record(content, Date.now());
  /* `base` moves on by the same steps rather than by a fresh copy of the
     whole document: this runs after every keystroke, and applySteps shares
     every row the steps did not touch. */
  try { base = applySteps(base, steps); } catch (e) { base = clone(S.state); }
}

function cosmetic(step) {
  if (step.op !== "rowField" || !TEXT_KEYS[step.key]) return false;
  return JSON.stringify(fromHtml(step.before || "")) === JSON.stringify(fromHtml(step.after || ""));
}

export function noteEdit() {
  if (applying || flushQueued) return;
  flushQueued = true;
  Promise.resolve().then(flushEdits);
}

/* Someone else's changes are about to replace the document (a merge on
   save, a pull, a reload from disk): record what this tab did first, then
   forget what the change touches (design D4) and carry on from `next`. */
export function noteRemoteChange(next) {
  flushEdits();
  if (!next) { restart(); return; }
  if (base) history.forget(changedBetween(base, next));
  tracked = next;
  base = clone(next);
}

/* The same, for a change already made in place (a reload from disk that
   swapped the rows in the same document object): the caller flushed first,
   so everything between `base` and now is theirs. */
export function absorbRemoteChange() {
  if (!S.state || S.state !== tracked || !base) { restart(); return; }
  history.forget(changedBetween(base, S.state));
  base = clone(S.state);
}

/* Forget the history outright — a new document, a restored version. */
export function resetUndo() {
  tracked = null;
  restart();
}

function run(dir) {
  flushEdits();
  if (!S.state) return { ok: false, empty: true };
  applying = true;
  var r;
  try {
    r = dir === "undo" ? history.undo(S.state) : history.redo(S.state);
  } finally {
    applying = false;
  }
  if (r.ok) {
    base = clone(S.state);
    tracked = S.state;
    if (hooks.afterApply) hooks.afterApply(r.steps, dir);
  } else if (!r.empty) {
    base = clone(S.state);
    if (hooks.onRefused) hooks.onRefused(r.reason, dir);
  }
  return r;
}

export function undo() { return run("undo"); }
export function redo() { return run("redo"); }

/* An action that is its own unit (a toolbar format, a paste) ends the
   typing entry before it, so Ctrl+Z does not take both at once. */
export function breakUndoCoalescing() {
  flushEdits();
  history.breakCoalescing();
}

export function undoSizes() { return history.sizes(); }

/* Where a text step leaves the caret: the end of what differs, in the
   target cell's text as the DOM counts it (no line breaks; a b-roll key by
   its letters) — 19-writer.js placeCaretAtTextOffset's coordinates. */
export function caretAfterStep(step, dir) {
  var fromHtmlStr = dir === "undo" ? step.after : step.before;
  var toHtmlStr = dir === "undo" ? step.before : step.after;
  function domText(h) {
    var out = "";
    normalizeCell(fromHtml(h == null ? "" : h)).forEach(function (r) { out += r.text.replace(/\n/g, ""); });
    return out;
  }
  var a = domText(fromHtmlStr), b = domText(toHtmlStr);
  var p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  var sa = a.length, sb = b.length;
  while (sa > p && sb > p && a[sa - 1] === b[sb - 1]) { sa--; sb--; }
  return sb;
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  /* For the browser suites (tests/73-undo.txt): how deep the stacks are. */
  window.__undoTest = { sizes: undoSizes, flush: flushEdits };
}
