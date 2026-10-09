import { S } from "./_state.js";
import { STATE_FIELDS } from "./02-state.js";
import { STATE_FIELDS as FIELD_POLICIES } from "../core/document/fields.ts";
import { idMap } from "../core/document/id-map.ts";
import { mergeCells } from "../core/merge/cells.ts";
import { personIdRemap, personSurvives, repointOwners } from "../core/merge/lists.ts";
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

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (!v || typeof v !== "object") return v;
  var out = {};
  Object.keys(v).sort().forEach(function (k) { out[k] = canon(v[k]); });
  return out;
}

function sameDoc(a, b) { return same(canon(a), canon(b)); }

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

var OWNED_LISTS = { productionTags: true, brollShots: true };

function ownerNames(key, before, after) {
  if (!OWNED_LISTS[key]) return null;
  var names = idMap(), out = idMap(), any = false;
  [before, after].forEach(function (st) {
    listOf(st && st.people).forEach(function (p) { if (p && p.id && p.name) names[p.id] = p.name; });
  });
  [before, after].forEach(function (st) {
    listOf(st && st[key]).forEach(function (e) {
      var id = e && e.owner;
      if (typeof id === "string" && id && names[id]) { out[id] = names[id]; any = true; }
    });
  });
  return any ? out : null;
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
    var step = { op: "docField", key: k, before: clone(before[k]), after: clone(after[k]) };
    var owners = ownerNames(k, before, after);
    if (owners) step.owners = owners;
    steps.push(step);
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

function listOf(v) { return Array.isArray(v) ? v : []; }

function repointed(key, value, remap) {
  var copy = clone(value);
  if (remap && OWNED_LISTS[key] && Array.isArray(copy)) repointOwners([copy], remap);
  return copy;
}

function resolveDoc(state, p, survives, remap) {
  var live = state[p.key];
  var before = repointed(p.key, p.step.before, remap), after = repointed(p.key, p.step.after, remap);
  if (same(live, p.step.before) || sameDoc(live, before)) { p.value = after; return; }
  p.value = listMergeFor(p.key)(before, clone(live), after, survives);
  p.merged = true;
}

function resolveDocFields(state, plan) {
  var docs = plan.filter(function (p) { return p.op === "doc"; });
  if (!docs.length) return { remap: null, cleared: 0 };
  var people = docs.filter(function (p) { return p.key === "people"; })[0];
  if (people) resolveDoc(state, people);
  var sides = listOf(state.people).concat(people ? listOf(people.step.after) : []);
  docs.forEach(function (p) {
    var owners = p.step.owners;
    if (owners) Object.keys(owners).forEach(function (id) { sides.push({ id: id, name: owners[id] }); });
  });
  var kept = people ? people.value : state.people;
  var survives = personSurvives(sides, kept);
  var remap = !people || people.merged ? personIdRemap(sides, kept) : null;
  docs.forEach(function (p) { if (p !== people) resolveDoc(state, p, survives, remap); });
  var crew = idMap();
  listOf(kept).forEach(function (e) { if (e && e.id) crew[e.id] = true; });
  var cleared = 0;
  docs.forEach(function (p) {
    if (!OWNED_LISTS[p.key] || !Array.isArray(p.value)) return;
    p.value = p.value.map(function (e) {
      if (!e || typeof e.owner !== "string" || !e.owner || crew[e.owner]) return e;
      cleared++;
      return Object.assign({}, e, { owner: "" });
    });
  });
  return { remap: remap, cleared: cleared };
}

function repointLists(state, remap) {
  ["productionTags", "brollShots"].forEach(function (key) {
    if (!Array.isArray(state[key])) return;
    var copy = clone(state[key]);
    repointOwners([copy], remap);
    if (!same(copy, state[key])) state[key] = copy;
  });
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
      if (!same(state[s.key], s.before) && !listMergeFor(s.key)) return { ok: false, reason: "it has changed since" };
      plan.push({ op: "doc", key: s.key, step: s });
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
  var resolved = resolveDocFields(state, plan);
  var remap = resolved.remap;
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
  if (remap) repointLists(state, remap);
  return resolved.cleared ? { ok: true, cleared: resolved.cleared } : { ok: true };
}

function onlyCell(steps) {
  if (steps.length !== 1) return null;
  var s = steps[0];
  return s.op === "rowField" && TEXT_KEYS[s.key] ? s.rowId + "\u0000" + s.key : null;
}

function insertedText(a, b) {
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
  var parked = null;
  var current = null;

  function backAtPark(text) {
    var top = done[done.length - 1] || null;
    if (!parked || top !== parked.top) return false;
    if (top && top.steps[0].after !== parked.after) {
      if (!onlyCell(top.steps)) return false;
      if ((text === undefined ? projectionOf(top.steps[0].after) : text) !== parked.text) return false;
      if (!cosmetic({ op: "rowField", key: top.steps[0].key, before: parked.after, after: top.steps[0].after })) return false;
    }
    return true;
  }

  function park(top) {
    parked = {
      redo: undone.slice(), top: top || null,
      after: top && top.steps[0].after,
      text: top && onlyCell(top.steps) ? projectionOf(top.steps[0].after) : null
    };
    undone.length = 0;
  }

  function unpark(text) {
    if (undone.length || !backAtPark(text)) return;
    for (var i = 0; i < parked.redo.length; i++) undone.push(parked.redo[i]);
    parked = null;
  }

  function record(steps, now) {
    if (!steps.length) return;
    var cell = onlyCell(steps);
    var last = done[done.length - 1];
    if (undone.length) park(last);
    var from = cell ? projectionOf(steps[0].before) : "", to = cell ? projectionOf(steps[0].after) : "";
    var ins = cell ? insertedText(from, to) : "";
    if (cell && last && last.cell === cell && now - last.at < COALESCE_MS) {
      var startsWord = /\S/.test(ins) && last.endsInSpace;
      if (!startsWord) {
        last.steps[0].after = steps[0].after;
        last.at = now;
        if (ins) last.endsInSpace = /\s$/.test(ins);
        if (last.from === to && cosmetic(last.steps[0])) {
          dropFrom(done.length - 1);
          if (current && last === current.top) current.lost = below();
          unpark();
        } else if (parked) {
          unpark(to);
        }
        return;
      }
    }
    push({ n: ++serial, steps: steps, at: now, cell: cell, endsInSpace: /\s$/.test(ins), from: from, evicted: null });
  }

  function push(entry) {
    done.push(entry);
    if (done.length > MAX_ENTRIES) {
      entry.evicted = done.shift();
      entry.evicted.evicted = null;
    }
  }

  function dropFrom(k) {
    var gone = done.splice(k);
    for (var i = gone.length - 1; i >= 0; i--) if (gone[i].evicted) done.unshift(gone[i].evicted);
  }

  function below() {
    var under = done[done.length - 1] || null;
    return { under: under, after: under && under.steps[0].after };
  }

  function fill(mark, value) {
    var top = done[done.length - 1] || null;
    mark.n = serial;
    mark.value = value;
    mark.top = top;
    mark.after = top && top.steps[0].after;
    mark.at = top && top.at;
    mark.endsInSpace = top && top.endsInSpace;
    mark.lost = null;
    return mark;
  }

  function markCell(rowId, key, value) {
    current = fill({ rowId: rowId, cell: rowId + "\u0000" + key, key: key, ended: false }, value);
    return current;
  }

  function joinedTop(mark) {
    var top = mark.top;
    return !!top && onlyCell(top.steps) === mark.cell && (top.steps[0].after !== mark.after || top.at !== mark.at);
  }

  function putBack(mark) {
    mark.top.steps[0].after = mark.after;
    mark.top.at = mark.at;
    mark.top.endsInSpace = mark.endsInSpace;
  }

  function remark(state) {
    if (joinedTop(current)) putBack(current);
    var rows = (state && state.rows) || [], value;
    for (var i = 0; i < rows.length; i++) if (rows[i] && rows[i].id === current.rowId) value = rows[i][current.key];
    fill(current, value);
  }

  function dropEmptySince(mark, cancelled) {
    if (mark !== current) return false;
    mark.ended = true;
    var k = done.length;
    while (k > 0 && done[k - 1].n > mark.n) k--;
    var top = mark.top;
    var joined = done[k - 1] === top && joinedTop(mark);
    var lost = !!mark.lost && (done[k - 1] || null) === mark.lost.under &&
      (!mark.lost.under || mark.lost.under.steps[0].after === mark.lost.after);
    if (k === done.length && !joined) return false;
    if (!joined && !lost && !cosmetic({ op: "rowField", key: mark.key, before: mark.value, after: done[k].steps[0].before })) return false;
    for (var i = k; i < done.length; i++) if (onlyCell(done[i].steps) !== mark.cell) return false;
    var end = k < done.length ? done[done.length - 1] : top;
    var after = end.steps[0].after;
    var back = cosmetic({ op: "rowField", key: mark.key, before: mark.value, after: after });
    if (!back && (!cancelled || k === done.length)) return false;
    var from = projectionOf(mark.value);
    var one = back ? null : {
      n: done[k].n,
      steps: [{ op: "rowField", rowId: end.steps[0].rowId, key: mark.key, before: mark.value, after: after }],
      at: end.at, cell: mark.cell, endsInSpace: /\s$/.test(insertedText(from, projectionOf(after))), from: from, evicted: null
    };
    dropFrom(k);
    if (joined || lost) putBack(mark);
    if (lost) push(top);
    if (one) {
      push(one);
      return false;
    }
    unpark();
    return true;
  }

  function step(from, to, state, invert) {
    var entry = from.pop();
    if (!entry) return { ok: false, empty: true };
    var steps = invert ? invertSteps(entry.steps) : entry.steps;
    var r = applyStepsLive(state, steps);
    if (r.ok) to.push(entry);
    else parked = null;
    if (current && !current.ended) {
      if (entry.n <= current.n) remark(state);
      if (r.ok) current.ended = true;
    }
    if (r.ok && r.cleared) return { ok: true, steps: steps, cleared: r.cleared };
    return r.ok ? { ok: true, steps: steps } : { ok: false, reason: r.reason, steps: steps };
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
    var had = done.length + undone.length;
    keep(done);
    keep(undone);
    if (done.length + undone.length !== had) parked = null;
    if (parked) keep(parked.redo);
    done.forEach(function (e) { if (e.evicted && hits(e.evicted)) e.evicted = null; });
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
    markCell: markCell,
    dropEmptySince: dropEmptySince,
    clear: function () { done.length = 0; undone.length = 0; parked = null; current = null; },
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

function announceCleared(count) {
  if (typeof document === "undefined") return;
  var Ctor = (document.defaultView && document.defaultView.CustomEvent) || (typeof CustomEvent === "function" ? CustomEvent : null);
  if (Ctor) document.dispatchEvent(new Ctor("undo-owner-cleared", { detail: { count: count } }));
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
    if (r.cleared) announceCleared(r.cleared);
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

export function undoSerial() { flushEdits(); return history.mark(); }

export function compositionUndoMark(rowId, key) {
  flushEdits();
  var rows = (S.state && S.state.rows) || [], value;
  for (var i = 0; i < rows.length; i++) if (rows[i] && rows[i].id === rowId) value = rows[i][key];
  return history.markCell(rowId, key, value);
}

export function dropEmptyStepsSince(mark, cancelled) { flushEdits(); return history.dropEmptySince(mark, cancelled); }

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
