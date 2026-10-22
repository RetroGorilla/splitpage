import { STATE_FIELDS } from "./02-state.js";
import { changeSet } from "../application/session/change-set.ts";
import { STATE_FIELDS as FIELD_POLICIES } from "../core/document/fields.ts";
import { idMap } from "../core/document/id-map.ts";
import { mergeCells } from "../core/merge/cells.ts";
import { personIdRemap, personSurvives, repointOwners } from "../core/merge/lists.ts";
import { toHtml } from "../core/text/html.ts";
import { commentIds, normalizeCell } from "../core/text/runs.ts";
import { applySteps, invertSteps } from "../core/text/steps.ts";
import { fromHtml } from "../legacy/richtext.ts";
import { heldDocument } from "../legacy/session-bridge.ts";

var SKIP_DOC_KEYS = {};
FIELD_POLICIES.forEach(function (f) { if (!f.undo) SKIP_DOC_KEYS[f.key] = true; });
var SKIP_ROW_KEYS = { id: true, updatedAt: true, updatedBy: true };
var TEXT_KEYS = { visualText: true, audioText: true };
var COALESCE_MS = 1000;
var MAX_ENTRIES = 200;

var WITH_MEDIA = Object.freeze({ media: true });
function cellRunsOf(html) { return fromHtml(html == null ? "" : html, WITH_MEDIA); }

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
  var mine = cellRunsOf(live), base = cellRunsOf(step.before), want = cellRunsOf(step.after);
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

function ownerChanges(key, before, after) {
  var was = idMap(), out = idMap();
  listOf(before).forEach(function (e) { if (e) was[itemKey(key, e)] = e.owner || ""; });
  listOf(after).forEach(function (e) {
    if (!e) return;
    var k = itemKey(key, e), to = e.owner || "";
    if (was[k] !== undefined && was[k] !== to) out[k] = { from: was[k], to: to };
  });
  return out;
}

function ownersReplayed(key, live, before, after) {
  if (!Array.isArray(live)) return clone(live);
  var changes = ownerChanges(key, before, after);
  return live.map(function (e) {
    var c = e && changes[itemKey(key, e)];
    if (!c || (e.owner || "") !== c.from) return clone(e);
    return Object.assign(clone(e), { owner: c.to });
  });
}

function ownersTouched(step, items) {
  return !items || Object.keys(ownerChanges(step.key, step.before, step.after)).some(function (k) { return !!items[k]; });
}

function resolveDoc(state, p, survives, remap) {
  var live = state[p.key];
  var before = repointed(p.key, p.step.before, remap), after = repointed(p.key, p.step.after, remap);
  if (same(live, p.step.before) || sameDoc(live, before)) { p.value = after; return; }
  if (p.step.ownersOnly && OWNED_LISTS[p.key]) { p.value = ownersReplayed(p.key, live, before, after); return; }
  p.value = listMergeFor(p.key)(before, clone(live), after, survives);
  p.merged = true;
}

function resolveDocFields(state, plan) {
  var docs = plan.filter(function (p) { return p.op === "doc"; });
  if (!docs.length) return { remap: null, cleared: [] };
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
  var cleared = [], touched = false;
  var rescue = remap || personIdRemap(sides, kept);
  function orphansCleared(key, list) {
    return list.map(function (e) {
      if (!e || typeof e.owner !== "string" || !e.owner || crew[e.owner]) return e;
      if (crew[rescue[e.owner]]) {
        if (remap) return e;
        touched = true;
        return Object.assign({}, e, { owner: rescue[e.owner] });
      }
      cleared.push(itemKey(key, e));
      touched = true;
      return Object.assign({}, e, { owner: "" });
    });
  }
  docs.forEach(function (p) {
    if (OWNED_LISTS[p.key] && Array.isArray(p.value)) p.value = orphansCleared(p.key, p.value);
  });
  if (people) Object.keys(OWNED_LISTS).forEach(function (key) {
    if (docs.some(function (p) { return p.key === key; }) || !Array.isArray(state[key])) return;
    touched = false;
    var value = orphansCleared(key, state[key]);
    if (touched) plan.push({ op: "doc", key: key, value: value, scan: clone(state[key]) });
  });
  return { remap: remap, cleared: cleared };
}

function itemKey(key, e) { return key + "\u0000" + (e.id || e.name || ""); }

function ownerAt(state, w) {
  var hit = listOf(state[w.key]).filter(function (e) { return e && itemKey(w.key, e) === itemKey(w.key, w); })[0];
  return hit && hit.owner || "";
}

function foldScan(entry, scanned, replayed, invert) {
  var forward = invert ? invertSteps(scanned) : scanned;
  forward.forEach(function (s) {
    s.ownersOnly = true;
    entry.steps.push(s);
  });
  replayed.forEach(function (s) {
    var at = entry.steps.findIndex(function (e) { return e.op === "docField" && e.ownersOnly && e.key === s.key; });
    entry.steps[at] = { op: "docField", key: s.key, before: clone(invert ? s.after : s.before), after: clone(invert ? s.before : s.after), ownersOnly: true };
  });
  entry.cell = null;
  var watch = entry.unassigned || (entry.unassigned = []);
  var seen = idMap();
  watch.forEach(function (w) { seen[itemKey(w.key, w)] = true; });
  scanned.concat(replayed).forEach(function (s) {
    var after = idMap();
    listOf(s.after).forEach(function (e) { if (e) after[itemKey(s.key, e)] = e; });
    listOf(s.before).forEach(function (e) {
      if (!e || !e.owner) return;
      var k = itemKey(s.key, e), now = after[k];
      if (!now || now.owner || seen[k]) return;
      seen[k] = true;
      watch.push({ key: s.key, id: e.id, name: e.name });
    });
  });
}

function repointLists(state, remap) {
  ["productionTags", "brollShots"].forEach(function (key) {
    if (!Array.isArray(state[key])) return;
    var copy = clone(state[key]);
    repointOwners([copy], remap);
    if (!same(copy, state[key])) state[key] = copy;
  });
}

function planStepsLive(state, steps) {
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
      plan.push({ op: "doc", key: s.key, step: s, live: s.ownersOnly ? clone(state[s.key]) : undefined });
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
  return { ok: true, plan: plan, resolved: resolveDocFields(state, plan) };
}

function writePlanned(state, planned, out) {
  var plan = planned.plan, resolved = planned.resolved, remap = resolved.remap;
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
  if (out) {
    out.cleared = resolved.cleared;
    out.scanned = plan.filter(function (p) { return p.scan; }).map(function (p) {
      return { op: "docField", key: p.key, before: p.scan, after: clone(state[p.key]) };
    });
    out.replayed = plan.filter(function (p) { return p.op === "doc" && p.step && p.step.ownersOnly; }).map(function (p) {
      return { op: "docField", key: p.key, before: p.live, after: clone(state[p.key]) };
    });
  }
  return resolved.cleared.length ? { ok: true, cleared: resolved.cleared.length } : { ok: true };
}

export function applyStepsLive(state, steps, out) {
  var planned = planStepsLive(state, steps);
  return planned.ok ? writePlanned(state, planned, out) : planned;
}

function replayChanges(steps, planned) {
  var cells = [], inserted = [], removed = [], docFields = [], moved = false, runsMoved = false;
  function field(rowId, key) {
    if (!cells.some(function (c) { return c.rowId === rowId && c.field === key; })) cells.push({ rowId: rowId, field: key });
  }
  function docField(key) { if (docFields.indexOf(key) === -1) docFields.push(key); }
  steps.forEach(function (s) {
    if (s.op === "rowField") {
      field(s.rowId, s.key);
      field(s.rowId, "updatedAt");
      field(s.rowId, "updatedBy");
    } else if (s.op === "insertRow") {
      inserted.push(s.row.id);
    } else if (s.op === "deleteRow") {
      removed.push(s.row.id);
    } else if (s.op === "moveRow") {
      moved = true;
    }
  });
  planned.plan.forEach(function (p) {
    if (p.op === "doc") docField(p.key);
    if (p.op === "set" && TEXT_KEYS[p.key] && !sameIds(p.row[p.key], p.value)) runsMoved = true;
  });
  if (planned.resolved.remap) Object.keys(OWNED_LISTS).forEach(docField);
  return changeSet({ cells: cells, rowsInserted: inserted, rowsRemoved: removed, rowsMoved: moved, runsMoved: runsMoved, docFields: docFields });
}

function sameIds(before, after) {
  return same(commentIds(cellRunsOf(before)), commentIds(cellRunsOf(after)));
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
  normalizeCell(cellRunsOf(html)).forEach(function (r) { out += r.atom ? "\uFFFC" : r.text; });
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

  function prepare(dir, state) {
    var invert = dir === "undo";
    var from = invert ? done : undone, to = invert ? undone : done;
    var entry = from[from.length - 1];
    if (!entry) return null;
    var steps = invert ? invertSteps(entry.steps) : entry.steps.slice();
    var planned = planStepsLive(state, steps);
    function marked(ok) {
      if (!current || current.ended) return;
      if (entry.n <= current.n) remark(state);
      if (ok) current.ended = true;
    }
    if (!planned.ok) {
      return {
        refused: planned.reason,
        steps: steps,
        drop: function () {
          if (from[from.length - 1] === entry) from.pop();
          parked = null;
          marked(false);
        }
      };
    }
    var watch = entry.unassigned || [];
    var had = watch.map(function (w) { return ownerAt(state, w); });
    var out = null;
    return {
      steps: steps,
      changes: replayChanges(steps, planned),
      write: function () {
        out = {};
        writePlanned(state, planned, out);
      },
      finish: function () {
        var ids = idMap();
        out.cleared.forEach(function (k) { ids[k] = true; });
        watch.forEach(function (w, i) { if (had[i] && !ownerAt(state, w)) ids[itemKey(w.key, w)] = true; });
        if (out.scanned.length || out.replayed.length) foldScan(entry, out.scanned, out.replayed, invert);
        from.pop();
        to.push(entry);
        marked(true);
        var count = Object.keys(ids).length;
        return count ? { ok: true, steps: steps, cleared: count } : { ok: true, steps: steps };
      }
    };
  }

  function step(dir, state) {
    var p = prepare(dir, state);
    if (!p) return { ok: false, empty: true };
    if (p.refused) {
      p.drop();
      return { ok: false, reason: p.refused, steps: p.steps };
    }
    p.write();
    return p.finish();
  }

  function forget(touched) {
    function hits(entry) {
      return entry.steps.some(function (s) {
        if (s.op === "rowField") return !!touched.rowFields[s.rowId + "\u0000" + s.key];
        if (s.op === "docField") return !!touched.doc[s.key] && (!s.ownersOnly || ownersTouched(s, touched.items && touched.items[s.key]));
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
    undo: function (state) { return step("undo", state); },
    redo: function (state) { return step("redo", state); },
    prepare: prepare,
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
  var out = { rowFields: {}, structure: false, doc: {}, items: {} };
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
    if (same(prev && prev[k], next && next[k])) return;
    out.doc[k] = true;
    if (OWNED_LISTS[k]) out.items[k] = itemsChanged(k, prev && prev[k], next && next[k]);
  });
  return out;
}

function itemsChanged(key, prev, next) {
  function byItem(list) {
    var out = idMap();
    listOf(list).forEach(function (e) {
      var k = itemKey(key, e || {});
      (out[k] || (out[k] = [])).push(e);
    });
    return out;
  }
  var was = byItem(prev), now = byItem(next), out = idMap();
  Object.keys(was).concat(Object.keys(now)).forEach(function (k) {
    if (!sameDoc(was[k], now[k])) out[k] = true;
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
var hooks = { afterApply: null, onRefused: null };
var UNROUTED = Object.freeze({ run: replayUnwired, amend: replayUnwired, stamps: null });
var replays = UNROUTED;

export function configureUndo(opts) {
  var was = { commentsAreSent: commentsAreSent, afterApply: hooks.afterApply, onRefused: hooks.onRefused };
  if (opts.commentsAreSent) commentsAreSent = opts.commentsAreSent;
  if (opts.afterApply) hooks.afterApply = opts.afterApply;
  if (opts.onRefused) hooks.onRefused = opts.onRefused;
  return function () {
    if (opts.commentsAreSent && commentsAreSent === opts.commentsAreSent) commentsAreSent = was.commentsAreSent;
    if (opts.afterApply && hooks.afterApply === opts.afterApply) hooks.afterApply = was.afterApply;
    if (opts.onRefused && hooks.onRefused === opts.onRefused) hooks.onRefused = was.onRefused;
  };
}

export function routeUndoReplays(run, stamps, amend) {
  var mine = Object.freeze({ run: run, amend: amend || run, stamps: stamps });
  replays = mine;
  return function () {
    if (replays === mine) replays = UNROUTED;
  };
}

function replayUnwired(task) {
  var live = heldDocument();
  var plan = task.plan(live);
  if (!plan) return { kind: "noop" };
  if (plan.refused) return { kind: "rejected", reason: plan.refused };
  plan.apply(live);
  plan.settle();
  return { kind: "applied" };
}

function restart(doc) {
  history.clear();
  lifetime++;
  tracked = doc || null;
  base = tracked ? clone(tracked) : null;
}

export function adoptDocument(doc) {
  if (applying || (doc || null) === tracked) return;
  flushQueued = false;
  restart(doc);
}

export function trackDocument() {
  adoptDocument(heldDocument());
}

export function flushEdits() {
  var reported = flushQueued;
  flushQueued = false;
  if (applying) return;
  var live = heldDocument();
  if (!live || live !== tracked || !base) { restart(live); return; }
  var skip = {};
  if (commentsAreSent()) skip.comments = true;
  var steps = diffStates(base, live);
  var sent = skip.comments && steps.some(function (s) { return s.op === "docField" && s.key === "comments"; });
  var content = steps.filter(function (s) { return !cosmetic(s); });
  if (reported && !sent && content.length) history.record(content, Date.now());
  try { base = applySteps(base, steps); } catch (e) { base = clone(live); }
}

function cosmetic(step) {
  if (step.op !== "rowField" || !TEXT_KEYS[step.key]) return false;
  return JSON.stringify(cellRunsOf(step.before)) === JSON.stringify(cellRunsOf(step.after));
}

export function noteEdit() {
  if (applying || flushQueued) return;
  flushQueued = true;
  Promise.resolve().then(flushEdits);
}

export function noteRemoteChange(next) {
  flushEdits();
  if (!next) { restart(null); return; }
  if (base) history.forget(changedBetween(base, next));
  tracked = next;
  base = clone(next);
}

export function absorbRemoteChange() {
  var live = heldDocument();
  if (!live || live !== tracked || !base) { restart(live); return; }
  history.forget(changedBetween(base, live));
  base = clone(live);
  lifetime++;
}

export function resetUndo() {
  restart(heldDocument());
}

function announceCleared(count) {
  if (typeof document === "undefined") return;
  var Ctor = (document.defaultView && document.defaultView.CustomEvent) || (typeof CustomEvent === "function" ? CustomEvent : null);
  if (Ctor) document.dispatchEvent(new Ctor("undo-owner-cleared", { detail: { count: count } }));
}

function stamp(state, steps) {
  var stamps = replays.stamps;
  if (!stamps) return;
  steps.forEach(function (st) {
    if (st.op !== "rowField") return;
    var row = state.rows.find(function (r) { return r.id === st.rowId; });
    if (!row) return;
    row.updatedAt = stamps.clock.nowIso();
    row.updatedBy = stamps.editor.name();
  });
}

function replayTask(dir, seen) {
  return {
    name: dir,
    plan: function (state) {
      var p = history.prepare(dir, state);
      seen.prepared = p;
      if (!p) return null;
      if (p.refused) return { refused: p.refused };
      return {
        changes: p.changes,
        apply: function (live) {
          p.write();
          stamp(live, p.steps);
        },
        settle: function () {
          var next = clone(state);
          seen.result = p.finish();
          base = next;
          tracked = state;
        }
      };
    }
  };
}

function run(dir) {
  flushEdits();
  if (!heldDocument()) return { ok: false, empty: true };
  var seen = { prepared: null, result: null };
  var outcome;
  applying = true;
  try {
    outcome = replays.run(replayTask(dir, seen));
  } finally {
    applying = false;
  }
  var p = seen.prepared;
  if (outcome.kind === "failed") throw outcome.error;
  if (outcome.kind === "applied" || outcome.kind === "committed") {
    var r = seen.result;
    if (hooks.afterApply) hooks.afterApply(r.steps, dir);
    if (r.cleared) announceCleared(r.cleared);
    return r;
  }
  if (p && p.refused) {
    p.drop();
    base = clone(heldDocument());
    if (hooks.onRefused) hooks.onRefused(p.refused, dir);
    return { ok: false, reason: p.refused, steps: p.steps };
  }
  if (outcome.kind === "rejected") return { ok: false, reason: outcome.reason };
  return { ok: false, empty: true };
}

export function settleAfterApply() {
  var live = heldDocument();
  if (!live || live !== tracked) return;
  base = clone(live);
}

function foldTask(entry, touches, change) {
  return {
    name: "fold",
    plan: function (state) {
      function hits(e) { return e.steps.some(touches); }
      var where = history.standing(entry, hits);
      if (where.any && (!where.hit || where.later)) return { refused: "the edit it belongs to is no longer the latest about it" };
      var draft = clone(state);
      if (!change(draft)) return null;
      var steps = diffStates(state, draft);
      if (!steps.length) return null;
      var planned = planStepsLive(state, steps);
      if (!planned.ok) return { refused: planned.reason };
      return {
        changes: replayChanges(steps, planned),
        apply: function (live) {
          writePlanned(live, planned);
          stamp(live, steps);
        },
        settle: function () {
          var next;
          try { next = applySteps(base, steps); } catch (e) { next = clone(state); }
          if (where.any) history.amend(entry, steps.filter(function (s) { return !cosmetic(s); }));
          base = next;
        }
      };
    }
  };
}

export function foldIntoEdit(entry, touches, change) {
  flushEdits();
  var live = heldDocument();
  if (!live || live !== tracked || !base) return false;
  var outcome;
  applying = true;
  try {
    outcome = replays.amend(foldTask(entry, touches, change));
  } finally {
    applying = false;
  }
  if (outcome.kind === "failed") throw outcome.error;
  return outcome.kind === "applied" || outcome.kind === "committed";
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
  var live = heldDocument();
  var rows = (live && live.rows) || [], value;
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
