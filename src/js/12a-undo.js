import { applySteps } from "../core/text/steps.ts";
import { normalizeCell } from "../core/text/runs.ts";
import { changedBetween, cosmetic as cosmeticFor, createUndoHistory, diffStates, planSteps, replayChanges, writePlanned } from "../application/editing/undo/history.ts";
import { fromHtml } from "../legacy/richtext.ts";
import { heldDocument } from "../legacy/session-bridge.ts";

var WITH_MEDIA = Object.freeze({ media: true });
function cellRunsOf(html) { return fromHtml(html == null ? "" : html, WITH_MEDIA); }

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

var history = createUndoHistory(cellRunsOf);
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
  return cosmeticFor(cellRunsOf, step);
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
      var planned = planSteps(cellRunsOf, state, steps);
      if (!planned.ok) return { refused: planned.reason };
      return {
        changes: replayChanges(cellRunsOf, steps, planned),
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
