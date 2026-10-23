import { normalizeTargetLength, targetLengthOf } from "../core/document/timing.ts";
import "./_dom.mjs";
import "./_export-services-started.mjs";
import "./_project-file-services-started.mjs";
import "./_preferences-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../legacy/session-bridge.ts";
import { targetClock } from "../core/production/timing.ts";
import { migrateRows } from "../js/02-state.js";
import { mergeTargetLength } from "../js/03-sync.js";
import { mergeStates } from "../legacy/merge-bridge.ts";
import "./_merge-started.mjs";
import { TARGET_PRESETS, targetOverlayParts } from "../features/rundown/target.js";
import { __init as initTags } from "../js/07-production-tags.js";
import { applyStepsLive, diffStates } from "../application/editing/undo/history.ts";
import { cellRuns } from "./_cell-runs.mjs";
import { invertSteps } from "../js/04c-doc-model.js";
import { applyMarkdownProject, buildMarkdownProject, buildSplitpageFile, parseMarkdownProject } from "../adapters/formats/project-file.ts";
import { exportDocumentOf } from "../js/14b-export-kit.js";
import { parseSplitpageFile } from "../adapters/formats/splitpage-file.ts";
import { loadTestDocument } from "./_document.mjs";

initTags();

const clone = (v) => JSON.parse(JSON.stringify(v));

function withState(s, fn) {
  const was = currentDocument();
  loadTestDocument(s);
  try { return fn(s); } finally { loadTestDocument(was); }
}

function doc(extra) {
  return migrateRows(Object.assign({
    title: "T",
    wordsPerMinute: 150,
    rows: [{ id: "r1", audioText: "one two three" }, { id: "r2", audioText: "four five" }]
  }, extra || {}));
}

test("normalizeTargetLength keeps whole seconds from 1 to a day and nothing else", () => {
  assert.equal(normalizeTargetLength(120), 120);
  assert.equal(normalizeTargetLength(1), 1);
  assert.equal(normalizeTargetLength(86400), 86400);
  assert.equal(normalizeTargetLength(90.4), 90);
  assert.equal(normalizeTargetLength(90.6), 91);
  for (const bad of [0, 0.4, -5, 86401, NaN, Infinity, "120", null, undefined, {}, [], true]) {
    assert.equal(normalizeTargetLength(bad), undefined, "kept " + String(bad));
  }
});

test("targetLengthOf reads a document's target, or null for none", () => {
  assert.equal(targetLengthOf({ targetSeconds: 120 }), 120);
  assert.equal(targetLengthOf({}), null);
  assert.equal(targetLengthOf({ targetSeconds: 0 }), null);
  assert.equal(targetLengthOf(null), null);
  assert.equal(targetLengthOf(undefined), null);
});

test("the presets are 0:30, 1:00, 2:00, 3:00, 5:00 and 10:00", () => {
  assert.deepEqual(TARGET_PRESETS, [30, 60, 120, 180, 300, 600]);
});

test("the length reads the target and the gap as lengths, left or over (#207: not a timecode)", () => {
  assert.deepEqual(targetClock(95, 120), { target: "2:00", delta: "0:25", over: false });
  assert.deepEqual(targetClock(125, 120), { target: "2:00", delta: "0:05", over: true });
  assert.deepEqual(targetClock(120, 120), { target: "2:00", delta: "0:00", over: false });
  assert.deepEqual(targetClock(0, 30), { target: "0:30", delta: "0:30", over: false });
  assert.deepEqual(targetClock(4000, 3600), { target: "1:00:00", delta: "6:40", over: true });
});

test("the gap is worked out on the whole seconds the length prints", () => {
  assert.equal(targetClock(95.4, 120).delta, "0:25");
  assert.equal(targetClock(95.6, 120).delta, "0:24");
  assert.equal(targetClock(120.4, 120).over, false);
  assert.equal(targetClock(120.6, 120).over, true);
});

test("under the target: the line at the target, the gap to it hatched with the time left", () => {
  const p = targetOverlayParts(95, 120, 5);
  assert.equal(p.lineX, 600);
  assert.equal(p.label, "Target 2:00");
  assert.deepEqual(p.hatch, { left: 475, width: 125, over: false, delta: "0:25 left" });
});

test("over the target: the blocks past it hatched, with the time over", () => {
  const p = targetOverlayParts(125, 120, 4);
  assert.equal(p.lineX, 480);
  assert.deepEqual(p.hatch, { left: 480, width: 20, over: true, delta: "0:05 over" });
});

test("on the target: the line and its label, nothing hatched", () => {
  const p = targetOverlayParts(120, 120, 3.3);
  assert.equal(p.lineX, 396);
  assert.equal(p.hatch, null);
});

test("nothing to draw with no target or no scale", () => {
  assert.equal(targetOverlayParts(100, 0, 5), null);
  assert.equal(targetOverlayParts(100, null, 5), null);
  assert.equal(targetOverlayParts(100, 120, 0), null);
});

test("migrateRows keeps a valid target, rounds it, and drops anything else", () => {
  assert.equal(doc({ targetSeconds: 120 }).targetSeconds, 120);
  assert.equal(doc({ targetSeconds: 119.7 }).targetSeconds, 120);
  for (const bad of [0, -1, "120", null, 90000, NaN, {}]) {
    const s = doc({ targetSeconds: bad });
    assert.ok(!("targetSeconds" in s), "kept " + JSON.stringify(bad));
  }
  const s = doc({ targetSeconds: 150 });
  assert.deepEqual(migrateRows(clone(s)), s, "migrating again changes nothing");
});

test("an older file has no target and gains no key", () => {
  const s = doc();
  assert.ok(!("targetSeconds" in s));
  assert.equal(targetLengthOf(s), null);
});

test(".splitpage carries it, and a file without one stays without", () => {
  const s = doc({ targetSeconds: 180 });
  const text = buildSplitpageFile(exportDocumentOf(s));
  assert.equal(JSON.parse(text).targetSeconds, 180);
  assert.equal(migrateRows(parseSplitpageFile(text)).targetSeconds, 180);
  const none = buildSplitpageFile(exportDocumentOf(doc()));
  assert.ok(!("targetSeconds" in JSON.parse(none)));
  assert.ok(none.indexOf("targetSeconds") === -1);
});

test("the .md data block carries it and reads it back; the table does not show it", async () => {
  const s = doc({ targetSeconds: 300 });
  const md = withState(s, (v) => buildMarkdownProject(exportDocumentOf(v)));
  const tableHalf = md.split(/^~{4,}splitpage/m)[0];
  assert.ok(tableHalf.indexOf("5:00") === -1 && tableHalf.indexOf("targetSeconds") === -1);
  const back = await withState(clone(s), () => applyMarkdownProject(parseMarkdownProject(md), { noAsk: true }));
  assert.equal((back.state || back).targetSeconds, 300);
  const plain = withState(doc(), (v) => buildMarkdownProject(exportDocumentOf(v)));
  const backPlain = await withState(doc(), () => applyMarkdownProject(parseMarkdownProject(plain), { noAsk: true }));
  assert.ok(!("targetSeconds" in (backPlain.state || backPlain)));
});

function three(target) {
  const base = doc(target ? { targetSeconds: target } : {});
  return { base, mine: clone(base), theirs: clone(base) };
}

test("the side that set, changed or cleared it since the base wins", () => {
  let { base, mine, theirs } = three();
  mine.targetSeconds = 120;
  assert.equal(mergeStates(base, mine, theirs).merged.targetSeconds, 120, "mine set");

  ({ base, mine, theirs } = three());
  theirs.targetSeconds = 90;
  assert.equal(mergeStates(base, mine, theirs).merged.targetSeconds, 90, "theirs set");

  ({ base, mine, theirs } = three(120));
  mine.targetSeconds = 180;
  assert.equal(mergeStates(base, mine, theirs).merged.targetSeconds, 180, "mine changed");

  ({ base, mine, theirs } = three(120));
  delete mine.targetSeconds;
  assert.ok(!("targetSeconds" in mergeStates(base, mine, theirs).merged), "my No target kept");

  ({ base, mine, theirs } = three(120));
  delete theirs.targetSeconds;
  assert.ok(!("targetSeconds" in mergeStates(base, mine, theirs).merged), "their No target kept");

  ({ base, mine, theirs } = three(120));
  assert.equal(mergeStates(base, mine, theirs).merged.targetSeconds, 120, "nobody changed it");
});

test("both changed it: theirs stays, with no conflict card", () => {
  const { base, mine, theirs } = three(120);
  mine.targetSeconds = 60;
  theirs.targetSeconds = 300;
  const r = mergeStates(base, mine, theirs);
  assert.equal(r.merged.targetSeconds, 300);
  assert.equal(r.merged.comments.filter((c) => c.kind === "conflict").length, 0);
  assert.equal(r.conflicts.length, 0);
});

test("with no base, a set target beats none, and theirs beats mine", () => {
  const a = three();
  a.mine.targetSeconds = 60;
  assert.equal(mergeStates(null, a.mine, a.theirs).merged.targetSeconds, 60);
  const b = three();
  b.theirs.targetSeconds = 90;
  assert.equal(mergeStates(null, b.mine, b.theirs).merged.targetSeconds, 90);
  const c = three();
  c.mine.targetSeconds = 60;
  c.theirs.targetSeconds = 90;
  assert.equal(mergeStates(null, c.mine, c.theirs).merged.targetSeconds, 90);
});

test("a document nobody gave a target merges without growing the key", () => {
  const { base, mine, theirs } = three();
  mine.title = "Mine";
  assert.ok(!("targetSeconds" in mergeStates(base, mine, theirs).merged));
  assert.ok(!("targetSeconds" in mergeStates(null, mine, theirs).merged));
});

test("mergeTargetLength reads through garbage as no target", () => {
  assert.equal(mergeTargetLength({ targetSeconds: 120 }, { targetSeconds: "x" }, { targetSeconds: 120 }), null);
  assert.equal(mergeTargetLength(null, { targetSeconds: -4 }, {}), null);
});

test("undo's diff sees it as one docField step, and the step takes it back and forth", () => {
  const before = doc();
  const after = clone(before);
  after.targetSeconds = 120;
  const steps = diffStates(before, after);
  assert.deepEqual(steps.map((s) => s.op + ":" + s.key), ["docField:targetSeconds"]);
  const live = clone(before);
  assert.deepEqual(applyStepsLive(cellRuns, live, steps), { ok: true });
  assert.equal(live.targetSeconds, 120);
  assert.deepEqual(applyStepsLive(cellRuns, live, invertSteps(steps)), { ok: true });
  assert.ok(!("targetSeconds" in live), "undo takes the key away, not sets it undefined");
});
