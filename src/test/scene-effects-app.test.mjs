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

test("in review mode a scene length is refused with a warning toast and has no other effect", async () => {
  const { liveSession } = await import("../legacy/session-bridge.ts");
  const { flushEdits, undoSizes } = await import("../js/12a-undo.js");
  window.__hostedTest.setSession({ role: "review", docId: "shared-doc" });
  flushEdits();
  const host = document.getElementById("toast-host");
  host.textContent = "";
  const seq = S.editSeq, dirty = S.dirty, generation = liveSession().generation(), sizes = undoSizes();
  const before = JSON.stringify(S.state);
  assert.equal(setSceneLength("r1", 30), false);
  const toasts = host.querySelectorAll(".toast");
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].textContent, "This is a review copy — comment on a scene instead of changing its length.");
  assert.ok(toasts[0].classList.contains("warn"));
  await Promise.resolve();
  flushEdits();
  assert.equal(JSON.stringify(S.state), before);
  assert.equal(S.editSeq, seq);
  assert.equal(S.dirty, dirty);
  assert.equal(liveSession().generation(), generation);
  assert.deepEqual(undoSizes(), sizes);
});
