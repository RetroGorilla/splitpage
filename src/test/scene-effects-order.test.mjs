import "./_dom.mjs";
import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";

register("./_fanout-hooks.mjs", import.meta.url);

const stubs = await import("./_fanout-stubs.mjs");
const { cycleRowStatus, updateScriptStats } = await import("../js/01-scene-status.js");
const { setSceneLength } = await import("../js/05r-read-time.js");
const bridge = await import("../legacy/session-bridge.ts");
const { migrateRows } = await import("../js/02-state.js");
const { trackDocument } = await import("../js/12a-undo.js");

function doc(rows) {
  S.state = { title: "Order", rows: rows.map((r) => Object.assign({ visualText: "", audioText: "", updatedAt: "" }, r)) };
  return S.state;
}

const STATS = ["paintRowTimes", "setRundownExtraSeconds", "renderRundown", "paintTargetOverlay"];

test("the stubs stand in for every module the two commands reach", () => {
  stubs.resetFanout();
  doc([{ id: "r1", status: "todo" }]);
  updateScriptStats();
  assert.deepEqual(stubs.calls, STATS, "01's own updateScriptStats runs and paints through the stubs");
});

test("a status click: change, stamp, dirty, then repaint one row, stats, production refresh, autosave", () => {
  stubs.resetFanout();
  doc([{ id: "r1", status: "todo" }, { id: "r2", status: "todo" }]);
  cycleRowStatus("r2");
  assert.deepEqual(stubs.calls, [
    "findRowIndex", "stampRow", "markDirty", "renderRow:r2", ...STATS, "scheduleProductionRefresh", "queueAutoSave"
  ]);
  assert.equal(S.state.rows[1].status, "ready");
  assert.equal(stubs.stamped[0].status, "ready", "the row is stamped after its status changed");
  assert.equal(stubs.dirtied[0][1].status, "ready", "and marked dirty after that");
  assert.equal(stubs.dirtied[0][1].updatedAt, "stamped", "with the stamp already on it");
  assert.equal(S.state.rows[0].updatedAt, "", "no other row is stamped");
});

test("a status click whose row does not paint renders the whole script instead", () => {
  stubs.resetFanout({ renderRow: false });
  doc([{ id: "r1", status: "ready" }]);
  cycleRowStatus("r1");
  assert.deepEqual(stubs.calls, [
    "findRowIndex", "stampRow", "markDirty", "renderRow:r1", "render", ...STATS, "scheduleProductionRefresh", "queueAutoSave"
  ]);
});

test("with shot scenes hidden, reaching shot arms the grace between dirty and the repaint", () => {
  stubs.resetFanout({ hideShot: true });
  doc([{ id: "r1", status: "ready" }, { id: "r2", status: "ready" }]);
  cycleRowStatus("r2");
  assert.equal(S.state.rows[1].status, "shot");
  assert.equal(S.state.rows[0].status, "ready");
  assert.deepEqual(stubs.calls, [
    "findRowIndex", "stampRow", "markDirty", "armShotHideGrace:r2", "renderRow:r2", ...STATS,
    "scheduleProductionRefresh", "queueAutoSave"
  ]);
});

test("with shot scenes hidden, leaving shot clears the grace in the same place", () => {
  stubs.resetFanout({ hideShot: true });
  doc([{ id: "r1", status: "shot" }, { id: "r2", status: "shot" }]);
  cycleRowStatus("r2");
  assert.equal(S.state.rows[1].status, "todo");
  assert.equal(S.state.rows[0].status, "shot");
  assert.deepEqual(stubs.calls, [
    "findRowIndex", "stampRow", "markDirty", "clearShotHideGrace:r2", "renderRow:r2", ...STATS,
    "scheduleProductionRefresh", "queueAutoSave"
  ]);
});

test("with shot scenes hidden, todo to ready touches no grace", () => {
  stubs.resetFanout({ hideShot: true });
  doc([{ id: "r1", status: "todo" }, { id: "r2", status: "todo" }]);
  cycleRowStatus("r2");
  assert.deepEqual(stubs.calls, [
    "findRowIndex", "stampRow", "markDirty", "renderRow:r2", ...STATS, "scheduleProductionRefresh", "queueAutoSave"
  ]);
});

test("with shot scenes shown, reaching shot arms no grace", () => {
  stubs.resetFanout();
  doc([{ id: "r1", status: "ready" }]);
  cycleRowStatus("r1");
  assert.equal(S.state.rows[0].status, "shot");
  assert.ok(!stubs.calls.some((c) => c.indexOf("Grace") !== -1), stubs.calls.join(","));
});

test("a status click on a scene that is gone does nothing past the lookup", () => {
  stubs.resetFanout();
  const before = JSON.stringify(doc([{ id: "r1", status: "todo" }]));
  cycleRowStatus("gone");
  assert.deepEqual(stubs.calls, ["findRowIndex"]);
  assert.equal(JSON.stringify(S.state), before);
});

test("a status click has no review-mode check of its own today", () => {
  stubs.resetFanout({ reviewMode: true });
  doc([{ id: "r1", status: "todo" }]);
  cycleRowStatus("r1");
  assert.ok(!stubs.calls.includes("reviewMode"), "cycleRowStatus never asks");
  assert.equal(S.state.rows[0].status, "ready");
});

const reviewing = { on: false };
const published = [];
bridge.provideSessionEffects({
  dirty: function () {
    stubs.calls.push("dirty");
    stubs.dirtied.push(JSON.parse(JSON.stringify(S.state.rows)));
  },
  draft: function () { stubs.calls.push("draft"); },
  save: function (change) { stubs.calls.push(change.changes.saveNow ? "save now" : "save"); },
  edit: function () { return reviewing.on ? { allowed: false, reason: bridge.REVIEW_ONLY } : { allowed: true }; }
});
bridge.liveSession().subscribe(function (change) { published.push(change); });

function lengthDoc(rows) {
  S.state = migrateRows({ title: "Order", rows: rows.map((r) => Object.assign({ visualText: "", audioText: "", updatedAt: "" }, r)) });
  trackDocument();
  published.length = 0;
  return S.state;
}

test("a scene length: the command sets and stamps the row, one effect pass with an immediate save, then the view repaints one row and the stats", () => {
  stubs.resetFanout();
  lengthDoc([{ id: "r1", status: "todo" }, { id: "r2", status: "todo" }]);
  assert.equal(setSceneLength("r2", 90), true);
  assert.deepEqual(stubs.calls, ["dirty", "draft", "save now", "renderRow:r2", "updateScriptStats"]);
  assert.equal(stubs.dirtied[0][1].lengthSeconds, 90, "the length is set before the effects run");
  assert.notEqual(stubs.dirtied[0][1].updatedAt, "", "and the row is already stamped");
  assert.equal(S.state.rows[0].updatedAt, "", "no other row is stamped");
  assert.equal(published.length, 1);
  assert.equal(published[0].kind, "edit");
  assert.deepEqual(published[0].changes.derive, ["production", "broll"], "production and b-roll refresh through the scheduler");
});

test("a scene length whose row does not paint renders the whole script instead", () => {
  stubs.resetFanout({ renderRow: false });
  lengthDoc([{ id: "r1", status: "todo", lengthSeconds: 90 }]);
  assert.equal(setSceneLength("r1", null), true);
  assert.ok(!("lengthSeconds" in S.state.rows[0]), "clearing deletes the key");
  assert.deepEqual(stubs.calls, ["dirty", "draft", "save now", "renderRow:r1", "render", "updateScriptStats"]);
});

test("a scene length that changes nothing or a missing scene has no effect; review mode only warns; no document does nothing", () => {
  stubs.resetFanout();
  const before = JSON.stringify(lengthDoc([{ id: "r1", status: "todo", lengthSeconds: 90 }]));
  assert.equal(setSceneLength("r1", 90), false);
  assert.equal(setSceneLength("gone", 30), false);
  assert.deepEqual(stubs.calls, []);

  reviewing.on = true;
  try {
    assert.equal(setSceneLength("r1", 30), false);
  } finally {
    reviewing.on = false;
  }
  assert.deepEqual(stubs.calls, ["showToast:This is a review copy — comment on a scene instead of changing its length."]);
  assert.equal(JSON.stringify(S.state), before);
  assert.deepEqual(published, []);

  stubs.resetFanout();
  S.state = null;
  assert.equal(setSceneLength("r1", 30), false);
  assert.deepEqual(stubs.calls, []);
});
