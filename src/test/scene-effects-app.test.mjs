import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";

await bootApp();

const { cycleRowStatus } = await import("../js/01-scene-status.js");
const { migrateRows } = await import("../js/02-state.js");
const { setSceneLength } = await import("../js/05r-read-time.js");
const { openProjectFile } = await import("../js/18-local-files.js");
const { buildSplitpageFile } = await import("../js/20d-formats.js");

after(closeApp);

const doc = migrateRows({
  schema: 2,
  title: "Edit counts",
  rows: [
    { id: "r1", visualText: "Wide", audioText: "One.", status: "todo" },
    { id: "r2", visualText: "Close", audioText: "Two.", status: "todo" }
  ]
});
await openProjectFile(new File([buildSplitpageFile(doc)], "counts.splitpage", { lastModified: 1 }), null, { skipSnapshot: true });

test("the booted app holds the opened script, saved", () => {
  assert.equal(S.state.title, "Edit counts");
  assert.equal(S.dirty, false);
});

test("a status click advances S.editSeq by exactly one and marks the document dirty", () => {
  const seq = S.editSeq;
  cycleRowStatus("r2");
  assert.equal(S.editSeq, seq + 1);
  assert.equal(S.dirty, true);
  cycleRowStatus("r2");
  assert.equal(S.editSeq, seq + 2, "and one more for the next click");
});

test("a scene length advances S.editSeq by exactly one; setting it again or clearing nothing adds none", () => {
  const seq = S.editSeq;
  assert.equal(setSceneLength("r2", 90), true);
  assert.equal(S.editSeq, seq + 1);
  assert.equal(setSceneLength("r2", 90), false);
  assert.equal(setSceneLength("r1", null), false);
  assert.equal(S.editSeq, seq + 1);
  assert.equal(setSceneLength("r2", null), true);
  assert.equal(S.editSeq, seq + 2);
});

test("a status click on a scene that is gone adds none", () => {
  const seq = S.editSeq;
  cycleRowStatus("gone");
  assert.equal(S.editSeq, seq);
});
