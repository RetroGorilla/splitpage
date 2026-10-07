import { S } from "./_state.js";
import { STATE_FIELDS } from "./02-state.js";
import { STATE_FIELDS as FIELD_POLICIES } from "../core/document/fields.ts";
import { idMap } from "../core/document/id-map.ts";
import { mergeCells } from "../core/merge/cells.ts";
import { toHtml } from "../core/text/html.ts";
import { normalizeCell } from "../core/text/runs.ts";
import { applySteps, invertSteps } from "../core/text/steps.ts";
import { fromHtml } from "../legacy/richtext.ts";

var SKIP_DOC_KEYS = {};
FIELD_POLICIES.forEach(function (f) { if (!f.undo) SKIP_DOC_KEYS[f.key] = true; });
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

export function diffStates(before, after, opts) {
  var skip = (opts && opts.skip) || {};
  var steps = [];
  var bRows = (before && before.rows) || [], aRows = (after && after.rows) || [];
  var aById = idMap(), bById = idMap();
  aRows.forEach(function (r) { if (r && r.id) aById[r.id] = r; });
  bRows.forEach(function (r) { if (r && r.id) bById[r.id] = r; });

  var work = bRows.map(function (r) { return r.id; });
  for (var i = work.length - 1; i >= 0; i--) {
    if (!aById[work[i]]) {
      steps.push({ op: "deleteRow", index: i, row: clone(bById[work[i]]) });
      work.splice(i, 1);
    }
  }
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
  docKeys(before, after).forEach(function (k) {
    if (skip[k] || same(before[k], after[k])) return;
    steps.push({ op: "docField", key: k, before: clone(before[k]), after: clone(after[k]) });
  });
  return steps;
}

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
  var order = state.rows.map(function (r) { return r.id; });
  var byId = idMap();
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

function onlyCell(steps) {
  if (steps.length !== 1) return null;
  var s = steps[0];
  return s.op === "rowField" && TEXT_KEYS[s.key] ? s.rowId + "\u0000" + s.key : null;
}

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
  var serial = 0;

  function record(steps, now) {
    if (!steps.length) return;
    undone.length = 0;
    var cell = onlyCell(steps);
    var last = done[done.length - 1];
    if (cell && last && last.cell === cell && now - last.at < COALESCE_MS) {
      var ins = insertedText(steps[0]);
      var startsWord = /\S/.test(ins) && last.endsInSpace;
      if (!startsWord) {
        last.steps[0].after = steps[0].after;
        last.at = now;
        if (ins) last.endsInSpace = /\s$/.test(ins);
        return;
      }
    }
    done.push({ n: ++serial, steps: steps, at: now, cell: cell, endsInSpace: cell ? /\s$/.test(insertedText(steps[0])) : false });
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

  function standing(entry, hits) {
    var at = entry ? done.indexOf(entry) : -1;
    return {
      done: at !== -1,
      hit: at !== -1 && hits(entry),
      any: done.some(hits) || undone.some(hits),
      later: done.slice(at + 1).some(hits) || undone.some(hits)
    };
  }

  function amend(entry, steps) {
    steps.forEach(function (s) {
      var mine = s.op === "rowField" && entry.steps.filter(function (e) {
        return e.op === "rowField" && e.rowId === s.rowId && e.key === s.key;
      })[0];
      if (mine) mine.after = s.after;
      else entry.steps.push(s);
    });
    entry.cell = null;
  }

  return {
    record: record,
    undo: function (state) { return step(done, undone, state, true); },
    redo: function (state) { return step(undone, done, state, false); },
    forget: forget,
    standing: standing,
    amend: amend,
    breakCoalescing: function () { var last = done[done.length - 1]; if (last) last.cell = null; },
    clear: function () { done.length = 0; undone.length = 0; },
    sizes: function () { return { undo: done.length, redo: undone.length }; },
    top: function () { return done[done.length - 1] || null; },
    nextRedo: function () { return undone[undone.length - 1] || null; },
    mark: function () { return serial; }
  };
}

export function changedBetween(prev, next) {
  var out = { rowFields: {}, structure: false, doc: {} };
  var p = (prev && prev.rows) || [], n = (next && next.rows) || [];
  var pById = idMap();
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

var history = createUndoHistory();
var lifetime = 0;
var base = null;
var tracked = null;
var flushQueued = false;
var applying = false;
var commentsAreSent = function () { return false; };
var hooks = { afterApply: null, onRefused: null, adopted: null };

export function configureUndo(opts) {
  if (opts.commentsAreSent) commentsAreSent = opts.commentsAreSent;
  if (opts.afterApply) hooks.afterApply = opts.afterApply;
  if (opts.onRefused) hooks.onRefused = opts.onRefused;
  if (opts.adopted) hooks.adopted = opts.adopted;
}

function restart() {
  var was = tracked;
  history.clear();
  lifetime++;
  tracked = S.state || null;
  if (hooks.adopted && tracked !== was) hooks.adopted(tracked);
  base = tracked ? clone(tracked) : null;
}

export function trackDocument() {
  if (applying || S.state === tracked) return;
  flushQueued = false;
  restart();
}

export function flushEdits() {
  var reported = flushQueued;
  flushQueued = false;
  if (applying) return;
  if (!S.state) { restart(); return; }
  if (S.state !== tracked || !base) { restart(); return; }
  var skip = {};
  if (commentsAreSent()) skip.comments = true;
  var steps = diffStates(base, S.state);
  var sent = skip.comments && steps.some(function (s) { return s.op === "docField" && s.key === "comments"; });
  var content = steps.filter(function (s) { return !cosmetic(s); });
  if (reported && !sent && content.length) history.record(content, Date.now());
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

export function noteRemoteChange(next) {
  flushEdits();
  if (!next) { restart(); return; }
  if (base) history.forget(changedBetween(base, next));
  tracked = next;
  base = clone(next);
}

export function absorbRemoteChange() {
  if (!S.state || S.state !== tracked || !base) { restart(); return; }
  history.forget(changedBetween(base, S.state));
  base = clone(S.state);
  lifetime++;
}

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

export function settleAfterApply() {
  if (!S.state || S.state !== tracked) return;
  base = clone(S.state);
}

export function foldIntoEdit(entry, touches, apply) {
  flushEdits();
  if (!S.state || S.state !== tracked || !base) return false;
  function hits(e) { return e.steps.some(touches); }
  var where = history.standing(entry, hits);
  if (where.any && (!where.hit || where.later)) return false;
  if (!apply(S.state)) return false;
  var steps = diffStates(base, S.state);
  if (where.any) history.amend(entry, steps.filter(function (s) { return !cosmetic(s); }));
  try { base = applySteps(base, steps); } catch (e) { base = clone(S.state); }
  return true;
}

export function undo() { return run("undo"); }
export function redo() { return run("redo"); }

export function breakUndoCoalescing() {
  flushEdits();
  history.breakCoalescing();
}

export function undoSizes() { return history.sizes(); }

export function lastUndoEntry() { flushEdits(); return history.top(); }

export function nextRedoEntry() { flushEdits(); return history.nextRedo(); }

export function undoLifetime() { flushEdits(); return lifetime; }

export function undoMark() { flushEdits(); history.breakCoalescing(); return history.mark(); }

export function caretAfterStep(step) {
  function domChars(h) {
    var text = "", keys = [];
    normalizeCell(fromHtml(h == null ? "" : h)).forEach(function (r) {
      var t = r.text.replace(/\n/g, "");
      var key = (r.atom ? r.atom + ":" + r.id : "") + JSON.stringify(r.marks || {});
      for (var i = 0; i < t.length; i++) keys.push(t[i] + key);
      text += t;
    });
    return { text: text, keys: keys };
  }
  var a = domChars(step.before).keys, bc = domChars(step.after), b = bc.text, bk = bc.keys;
  var s = 0;
  while (s < a.length && s < bk.length && a[a.length - 1 - s] === bk[bk.length - 1 - s]) s++;
  var offset = b.length - s;
  if (offset > 0 && offset < b.length) {
    var hi = b.charCodeAt(offset - 1), lo = b.charCodeAt(offset);
    if (hi >= 0xD800 && hi <= 0xDBFF && lo >= 0xDC00 && lo <= 0xDFFF) offset--;
  }
  return offset;
}

export function __init() {
  window.__undoTest = { sizes: undoSizes, flush: flushEdits };
}
