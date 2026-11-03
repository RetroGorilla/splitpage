import "./_dom.mjs";
import "./_preferences-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";

const stubs = await import("./_fanout-stubs.mjs");
const { createBeatStatus } = await import("../features/rows/beat-status.ts");
const { cycleRowStatus, onScriptStats, statsFollowChange, updateScriptStats } = createBeatStatus(stubs.beatStatusPorts());
const { startReadTime: mountReadTime, setBeatLength } = await import("../features/rows/read-time.ts");
mountReadTime(stubs.readTimePorts());
const bridge = await import("../bootstrap/wiring/session-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { loadTestDocument } = await import("./_document.mjs");

const STATS = ["setRundownExtraSeconds", "renderRundown", "paintTargetOverlay"];

const published = [];
const wired = stubs.wireSession({
  dirty: function () {
    stubs.calls.push("dirty");
    stubs.dirtied.push(JSON.parse(JSON.stringify(currentDocument().rows)));
  },
  draft: function () { stubs.calls.push("draft"); },
  save: function (change) { stubs.calls.push(change.changes.saveNow ? "save now" : "save"); }
});
bridge.liveSession().subscribe(function (change) { published.push(change); });
onScriptStats(function (targetSeconds) { stubs.setRundownExtraSeconds(targetSeconds); stubs.renderRundown(); stubs.paintTargetOverlay(); });
bridge.liveSession().subscribe(statsFollowChange);

function lengthDoc(rows) {
  const opening = migrateRows({ title: "Order", rows: rows.map((r) => Object.assign({ visualText: "", audioText: "", updatedAt: "" }, r)) });
  loadTestDocument(opening);
  published.length = 0;
  return currentDocument();
}

test("the stubs stand in for every module the two commands reach", () => {
  stubs.resetFanout();
  lengthDoc([{ id: "r1", status: "todo" }]);
  updateScriptStats();
  assert.deepEqual(stubs.calls, STATS, "01's own updateScriptStats runs and paints through the stubs");
});

test("a status click: the command sets and stamps the row, one effect pass with an immediate save, then the stats; the script screen repaints the row itself by hearing the change", () => {
  stubs.resetFanout();
  lengthDoc([{ id: "r1", status: "todo" }, { id: "r2", status: "todo" }]);
  cycleRowStatus("r2");
  assert.deepEqual(stubs.calls, ["dirty", "draft", "save now", ...STATS]);
  assert.equal(currentDocument().rows[1].status, "ready");
  assert.equal(stubs.dirtied[0][1].status, "ready", "the status is set before the effects run");
  assert.notEqual(stubs.dirtied[0][1].updatedAt, "", "and the row is already stamped");
  assert.equal(currentDocument().rows[0].updatedAt, "", "no other row is stamped");
  assert.equal(published.length, 1);
  assert.equal(published[0].kind, "edit");
  assert.deepEqual(published[0].changes.derive, ["production"], "production refreshes through the scheduler, b-roll does not");
});

test("with shot scenes hidden, reaching shot arms the grace after the effects and before the repaint", () => {
  stubs.resetFanout({ hideShot: true });
  lengthDoc([{ id: "r1", status: "ready" }, { id: "r2", status: "ready" }]);
  cycleRowStatus("r2");
  assert.equal(currentDocument().rows[1].status, "shot");
  assert.equal(currentDocument().rows[0].status, "ready");
  assert.deepEqual(stubs.calls, ["dirty", "draft", "save now", ...STATS, "armShotHideGrace:r2"]);
});

test("with shot scenes hidden, leaving shot clears the grace in the same place", () => {
  stubs.resetFanout({ hideShot: true });
  lengthDoc([{ id: "r1", status: "shot" }, { id: "r2", status: "shot" }]);
  cycleRowStatus("r2");
  assert.equal(currentDocument().rows[1].status, "todo");
  assert.equal(currentDocument().rows[0].status, "shot");
  assert.deepEqual(stubs.calls, ["dirty", "draft", "save now", ...STATS, "clearShotHideGrace:r2"]);
});

test("with shot scenes hidden, todo to ready touches no grace", () => {
  stubs.resetFanout({ hideShot: true });
  lengthDoc([{ id: "r1", status: "todo" }, { id: "r2", status: "todo" }]);
  cycleRowStatus("r2");
  assert.deepEqual(stubs.calls, ["dirty", "draft", "save now", ...STATS]);
});

test("with shot scenes shown, reaching shot arms no grace", () => {
  stubs.resetFanout();
  lengthDoc([{ id: "r1", status: "ready" }]);
  cycleRowStatus("r1");
  assert.equal(currentDocument().rows[0].status, "shot");
  assert.ok(!stubs.calls.some((c) => c.indexOf("Grace") !== -1), stubs.calls.join(","));
});

test("a status click on a scene that is gone does nothing", () => {
  stubs.resetFanout();
  const before = JSON.stringify(lengthDoc([{ id: "r1", status: "todo" }]));
  cycleRowStatus("gone");
  assert.deepEqual(stubs.calls, []);
  assert.equal(JSON.stringify(currentDocument()), before);
  assert.deepEqual(published, []);
});

test("a status click with no document does nothing", () => {
  stubs.resetFanout();
  loadTestDocument(null);
  cycleRowStatus("r1");
  assert.deepEqual(stubs.calls, []);
});

test("a status click whose command fails throws to the caller, leaves the row as it was and paints nothing", () => {
  stubs.resetFanout({ hideShot: true });
  const before = JSON.stringify(lengthDoc([{ id: "r1", status: "ready" }]));
  wired.editorName = function () { throw new Error("no editor"); };
  try {
    assert.throws(() => cycleRowStatus("r1"), /no editor/);
  } finally {
    wired.editorName = function () { return "Anonymous"; };
  }
  assert.deepEqual(stubs.calls, []);
  assert.equal(JSON.stringify(currentDocument()), before);
  assert.deepEqual(published, []);
});

function withThrowingListener(run) {
  const reported = [];
  const consoleError = console.error;
  console.error = (error) => { reported.push(error.message); };
  const off = bridge.liveSession().subscribe(function () { throw new Error("listener broke"); });
  try {
    run();
  } finally {
    off();
    console.error = consoleError;
  }
  return reported;
}

test("a status click whose commit is followed by a throw still arms the grace and the stats, and throws nothing", () => {
  stubs.resetFanout({ hideShot: true });
  lengthDoc([{ id: "r1", status: "ready" }]);
  const reported = withThrowingListener(() => cycleRowStatus("r1"));
  assert.deepEqual(reported, ["listener broke"]);
  assert.equal(currentDocument().rows[0].status, "shot");
  assert.deepEqual(stubs.calls, ["dirty", "draft", "save now", ...STATS, "armShotHideGrace:r1"]);
});

test("a scene length whose commit is followed by a throw still runs the stats and answers true, and throws nothing", () => {
  stubs.resetFanout();
  lengthDoc([{ id: "r1", status: "todo" }]);
  let answer = null;
  const reported = withThrowingListener(() => { answer = setBeatLength("r1", 45); });
  assert.deepEqual(reported, ["listener broke"]);
  assert.equal(answer, true);
  assert.deepEqual(stubs.calls, ["dirty", "draft", "save now", ...STATS]);
});

test("a scene length: the command sets and stamps the row, one effect pass with an immediate save, then the stats; the script screen repaints the row itself by hearing the change", () => {
  stubs.resetFanout();
  lengthDoc([{ id: "r1", status: "todo" }, { id: "r2", status: "todo" }]);
  assert.equal(setBeatLength("r2", 90), true);
  assert.deepEqual(stubs.calls, ["dirty", "draft", "save now", ...STATS]);
  assert.equal(stubs.dirtied[0][1].lengthSeconds, 90, "the length is set before the effects run");
  assert.notEqual(stubs.dirtied[0][1].updatedAt, "", "and the row is already stamped");
  assert.equal(currentDocument().rows[0].updatedAt, "", "no other row is stamped");
  assert.equal(published.length, 1);
  assert.equal(published[0].kind, "edit");
  assert.deepEqual(published[0].changes.derive, ["production", "broll"], "production and b-roll refresh through the scheduler");
});

test("a scene length that changes nothing or a missing scene has no effect; no document does nothing", () => {
  stubs.resetFanout();
  const before = JSON.stringify(lengthDoc([{ id: "r1", status: "todo", lengthSeconds: 90 }]));
  assert.equal(setBeatLength("r1", 90), false);
  assert.equal(setBeatLength("gone", 30), false);
  assert.deepEqual(stubs.calls, []);
  assert.equal(JSON.stringify(currentDocument()), before);
  assert.deepEqual(published, []);

  stubs.resetFanout();
  loadTestDocument(null);
  assert.equal(setBeatLength("r1", 30), false);
  assert.deepEqual(stubs.calls, []);
});
