import { rowContentEqual } from "../core/merge/rows.ts";
import { hasSetLength, parseSceneLength } from "../core/document/timing.ts";
import "./_dom.mjs";
import "./_export-services-started.mjs";
import "./_project-file-services-started.mjs";
import "./_preferences-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../legacy/session-bridge.ts";
import {
  __init as initSceneStatus,
  normalizeSceneLength,
  totalSeconds
} from "../js/01-scene-status.js";
import { estimatedSeconds, rowSeconds } from "../core/production/timing.ts";
import { productionReaders } from "../legacy/document-ports.ts";
import { migrateRows } from "../js/02-state.js";
import { mergeStates } from "../js/03-sync.js";
import { __init as initTags } from "../js/07-production-tags.js";
import { applyStepsLive, diffStates } from "../js/12a-undo.js";
import { invertSteps } from "../js/04c-doc-model.js";
import { applyMarkdownProject, buildMarkdownProject, buildSplitpageFile, parseMarkdownProject } from "../adapters/formats/project-file.ts";
import { exportDocumentOf } from "../js/14b-export-kit.js";
import { parseSplitpageFile } from "../adapters/formats/splitpage-file.ts";
import { loadTestDocument } from "./_document.mjs";

initTags();
initSceneStatus();

const clone = (v) => JSON.parse(JSON.stringify(v));

function withState(s, fn) {
  const was = currentDocument();
  loadTestDocument(s);
  try { return fn(s); } finally { loadTestDocument(was); }
}

const TEN = "one two three four five six seven eight nine ten";

function doc(rows) {
  return migrateRows({ title: "L", wordsPerMinute: 150, rows });
}

test("the forms Adam signed off: 1:30, 90, 90s, 1m30, 1m 30s", () => {
  assert.equal(parseSceneLength("1:30"), 90);
  assert.equal(parseSceneLength("90"), 90);
  assert.equal(parseSceneLength("90s"), 90);
  assert.equal(parseSceneLength("1m30"), 90);
  assert.equal(parseSceneLength("1m 30s"), 90);
  assert.equal(parseSceneLength("1m30s"), 90);
});

test("and the forms around them", () => {
  assert.equal(parseSceneLength("0:05"), 5);
  assert.equal(parseSceneLength("12:00"), 720);
  assert.equal(parseSceneLength("1:02:03"), 3723);
  assert.equal(parseSceneLength("  45  "), 45);
  assert.equal(parseSceneLength("0"), 0);
  assert.equal(parseSceneLength("2m"), 120);
  assert.equal(parseSceneLength("2 min"), 120);
  assert.equal(parseSceneLength("1 min 30 sec"), 90);
  assert.equal(parseSceneLength("2 minutes 5 seconds"), 125);
  assert.equal(parseSceneLength("1.5m"), 90);
  assert.equal(parseSceneLength("7.4s"), 7);
  assert.equal(parseSceneLength("90 S"), 90);
  assert.equal(parseSceneLength("1h"), 3600);
  assert.equal(parseSceneLength("1h 5m"), 3900);
  assert.equal(parseSceneLength("1h30"), 5400, "a bare number after hours is minutes");
});

test("blank is the estimate, and anything else unreadable is NaN", () => {
  assert.equal(parseSceneLength(""), null);
  assert.equal(parseSceneLength("   "), null);
  assert.equal(parseSceneLength(null), null);
  for (const bad of ["abc", "1:3", "1:60", "1:30:", ":30", "-5", "5x", "30s 1m", "1m 2m", "1m30s5", "1,5", "90 90", "s", "1:30s", "25h"]) {
    assert.ok(Number.isNaN(parseSceneLength(bad)), "accepted " + JSON.stringify(bad));
  }
});

test("with nothing set, a scene's length is its Audio words at the reading speed", () => {
  const s = doc([{ id: "r1", audioText: TEN }]);
  withState(s, () => {
    assert.equal(hasSetLength(s.rows[0]), false);
    assert.equal(rowSeconds(s.rows[0], s, productionReaders), 4);
    assert.equal(estimatedSeconds(s.rows[0], s, productionReaders), 4);
  });
});

test("a set length replaces the estimate outright, shorter or longer", () => {
  const s = doc([
    { id: "r1", audioText: TEN, lengthSeconds: 2 },
    { id: "r2", audioText: TEN, lengthSeconds: 30 },
    { id: "r3", audioText: "", lengthSeconds: 12 },
    { id: "r4", audioText: TEN }
  ]);
  withState(s, () => {
    assert.deepEqual(s.rows.map((row) => rowSeconds(row, s, productionReaders)), [2, 30, 12, 4]);
    assert.equal(estimatedSeconds(s.rows[0], s, productionReaders), 4, "the estimate is still there to compare with");
    assert.equal(totalSeconds(), 48);
  });
});

test("a set length of 0 is a length, not the estimate", () => {
  const s = doc([{ id: "r1", audioText: TEN, lengthSeconds: 0 }]);
  withState(s, () => {
    assert.equal(hasSetLength(s.rows[0]), true);
    assert.equal(rowSeconds(s.rows[0], s, productionReaders), 0);
  });
});

test("the reading speed moves an estimate and never a set length", () => {
  const s = doc([{ id: "r1", audioText: TEN }, { id: "r2", audioText: TEN, lengthSeconds: 9 }]);
  s.wordsPerMinute = 300;
  withState(s, () => assert.deepEqual(s.rows.map((row) => rowSeconds(row, s, productionReaders)), [2, 9]));
});

test("migrateRows keeps whole seconds from 0 to a day, rounds, and drops the rest", () => {
  assert.equal(normalizeSceneLength(12), 12);
  assert.equal(normalizeSceneLength(12.6), 13);
  assert.equal(normalizeSceneLength(0), 0);
  assert.equal(normalizeSceneLength(86400), 86400);
  for (const bad of [-1, 86401, NaN, Infinity, "12", null, undefined, {}, [], true]) {
    assert.equal(normalizeSceneLength(bad), undefined, "kept " + String(bad));
  }
  const s = doc([
    { id: "a", lengthSeconds: 12.4 },
    { id: "b", lengthSeconds: "90" },
    { id: "c", lengthSeconds: -3 },
    { id: "d" }
  ]);
  assert.equal(s.rows[0].lengthSeconds, 12);
  for (const r of s.rows.slice(1)) assert.ok(!("lengthSeconds" in r), r.id + " kept a length");
  assert.deepEqual(migrateRows(clone(s)).rows, s.rows);
});

test("an older file has no key and reads as the estimate", () => {
  const s = doc([{ id: "r1", audioText: TEN }]);
  assert.ok(!("lengthSeconds" in s.rows[0]));
  withState(s, () => assert.equal(rowSeconds(s.rows[0], s, productionReaders), 4));
});

test(".splitpage and .md both carry it, and read it back", async () => {
  const s = doc([{ id: "r1", audioText: TEN, lengthSeconds: 75 }, { id: "r2", audioText: "Two." }]);
  const back = migrateRows(parseSplitpageFile(buildSplitpageFile(exportDocumentOf(s))));
  assert.equal(back.rows[0].lengthSeconds, 75);
  assert.ok(!("lengthSeconds" in back.rows[1]));
  const md = withState(s, (v) => buildMarkdownProject(exportDocumentOf(v)));
  const fromMd = await withState(clone(s), () => applyMarkdownProject(parseMarkdownProject(md), { noAsk: true }));
  const got = fromMd.state || fromMd;
  assert.equal(got.rows[0].lengthSeconds, 75);
  assert.ok(!("lengthSeconds" in got.rows[1]));
});

function three() {
  const base = doc([{ id: "r1", audioText: TEN }, { id: "r2", audioText: "Two." }]);
  return { base, mine: clone(base), theirs: clone(base) };
}

test("a length one side set, changed or cleared since the base is the one kept", () => {
  let { base, mine, theirs } = three();
  mine.rows[0].lengthSeconds = 20;
  assert.equal(mergeStates(base, mine, theirs).merged.rows[0].lengthSeconds, 20);

  ({ base, mine, theirs } = three());
  theirs.rows[0].lengthSeconds = 25;
  assert.equal(mergeStates(base, mine, theirs).merged.rows[0].lengthSeconds, 25);

  ({ base, mine, theirs } = three());
  base.rows[0].lengthSeconds = mine.rows[0].lengthSeconds = theirs.rows[0].lengthSeconds = 30;
  delete mine.rows[0].lengthSeconds;
  assert.ok(!("lengthSeconds" in mergeStates(base, mine, theirs).merged.rows[0]), "my clear kept");

  ({ base, mine, theirs } = three());
  base.rows[0].lengthSeconds = mine.rows[0].lengthSeconds = theirs.rows[0].lengthSeconds = 30;
  delete theirs.rows[0].lengthSeconds;
  assert.ok(!("lengthSeconds" in mergeStates(base, mine, theirs).merged.rows[0]), "their clear kept");
});

test("both changed it: theirs stays, with no conflict card; and it sits beside a text merge", () => {
  const { base, mine, theirs } = three();
  mine.rows[0].lengthSeconds = 20;
  theirs.rows[0].lengthSeconds = 40;
  mine.rows[1].audioText = "Two, and more.";
  const r = mergeStates(base, mine, theirs);
  assert.equal(r.merged.rows[0].lengthSeconds, 40);
  assert.equal(r.merged.rows[1].audioText, "Two, and more.");
  assert.equal(r.merged.comments.filter((c) => c.kind === "conflict").length, 0);
});

test("with no base, a set length beats none", () => {
  const { mine, theirs } = three();
  mine.rows[0].lengthSeconds = 20;
  assert.equal(mergeStates(null, mine, theirs).merged.rows[0].lengthSeconds, 20);
  const t2 = three();
  t2.theirs.rows[0].lengthSeconds = 15;
  assert.equal(mergeStates(null, t2.mine, t2.theirs).merged.rows[0].lengthSeconds, 15);
});

test("setting a length is an edit: it outranks the other side's delete", () => {
  const { base, mine, theirs } = three();
  assert.equal(rowContentEqual(base.rows[0], mine.rows[0]), true);
  theirs.rows[0].lengthSeconds = 12;
  assert.equal(rowContentEqual(base.rows[0], theirs.rows[0]), false);
  mine.rows.splice(0, 1);
  assert.equal(mergeStates(base, mine, theirs).merged.rows[0].lengthSeconds, 12);
});

test("undo's diff sees it as one rowField step, and the step takes it back and forth", () => {
  const before = doc([{ id: "r1", audioText: TEN }]);
  const after = clone(before);
  after.rows[0].lengthSeconds = 42;
  const steps = diffStates(before, after);
  assert.deepEqual(steps.map((s) => s.op + ":" + s.key), ["rowField:lengthSeconds"]);
  const live = clone(before);
  assert.deepEqual(applyStepsLive(live, steps), { ok: true });
  assert.equal(live.rows[0].lengthSeconds, 42);
  assert.deepEqual(applyStepsLive(live, invertSteps(steps)), { ok: true });
  assert.ok(!("lengthSeconds" in live.rows[0]), "undo clears the key, not sets it undefined");
});
