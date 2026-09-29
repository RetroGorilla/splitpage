import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  RUNDOWN_IDLE_MS,
  rundownDotXs,
  rundownPresenceActivity,
  rundownPresenceGroups
} from "../js/05p-rundown-presence.js";

var rows = {
  r1: { id: "r1", audioText: "One", visualText: "", status: "todo" },
  r2: { id: "r2", audioText: "Two", visualText: "", status: "todo" }
};

test("idle is a minute", () => {
  assert.equal(RUNDOWN_IDLE_MS, 60000);
});

test("someone new starts active; nothing changing keeps their time", () => {
  var a = rundownPresenceActivity({}, [{ id: "p1", rowId: "r1", field: "audioText" }], rows, null, 1000);
  assert.equal(a.p1.at, 1000);
  var b = rundownPresenceActivity(a, [{ id: "p1", rowId: "r1", field: "audioText" }], rows, null, 5000);
  assert.equal(b.p1.at, 1000);
});

test("a new scene or a new field is activity", () => {
  var a = rundownPresenceActivity({}, [{ id: "p1", rowId: "r1", field: "audioText" }], rows, null, 1000);
  var b = rundownPresenceActivity(a, [{ id: "p1", rowId: "r1", field: "visualText" }], rows, null, 2000);
  assert.equal(b.p1.at, 2000);
  var c = rundownPresenceActivity(b, [{ id: "p1", rowId: "r2", field: "visualText" }], rows, null, 3000);
  assert.equal(c.p1.at, 3000);
});

test("their scene's words changing is activity, unless your caret is in it", () => {
  var a = rundownPresenceActivity({}, [{ id: "p1", rowId: "r1", field: "audioText" }], rows, null, 1000);
  var typed = { r1: Object.assign({}, rows.r1, { audioText: "One more" }), r2: rows.r2 };
  assert.equal(rundownPresenceActivity(a, [{ id: "p1", rowId: "r1", field: "audioText" }], typed, null, 2000).p1.at, 2000);
  assert.equal(rundownPresenceActivity(a, [{ id: "p1", rowId: "r1", field: "audioText" }], typed, "r1", 2000).p1.at, 1000);
  var other = { r1: rows.r1, r2: Object.assign({}, rows.r2, { audioText: "Changed" }) };
  assert.equal(rundownPresenceActivity(a, [{ id: "p1", rowId: "r1", field: "audioText" }], other, null, 2000).p1.at, 1000);
});

test("someone who left is dropped; a person with no id is ignored", () => {
  var a = rundownPresenceActivity({}, [{ id: "p1", rowId: "r1" }, { id: "p2", rowId: "r2" }], rows, null, 1000);
  var b = rundownPresenceActivity(a, [{ id: "p2", rowId: "r2" }, { rowId: "r1" }, null], rows, null, 2000);
  assert.deepEqual(Object.keys(b), ["p2"]);
  assert.deepEqual(rundownPresenceActivity(null, null, null, null, 1), {});
});

test("groups: one per scene, in script order, idle after the minute", () => {
  var people = [
    { id: "p1", name: "Sam", color: "#80BDFB", rowId: "r3" },
    { id: "p2", name: "Priya", color: "#F9B64F", rowId: "r1" },
    { id: "p3", name: "Guest", color: "#CBA1FA", rowId: "r3" }
  ];
  var activity = { p1: { at: 1000 }, p2: { at: 50000 }, p3: { at: 1001 } };
  var g = rundownPresenceGroups(people, ["r1", "r2", "r3"], activity, 61000, RUNDOWN_IDLE_MS);
  assert.deepEqual(g, [
    { rowId: "r1", index: 0, people: [{ id: "p2", name: "Priya", color: "#F9B64F", idle: false }] },
    { rowId: "r3", index: 2, people: [
      { id: "p1", name: "Sam", color: "#80BDFB", idle: true },
      { id: "p3", name: "Guest", color: "#CBA1FA", idle: false }
    ] }
  ]);
});

test("groups: nobody in a scene this copy lacks, the title, or nowhere", () => {
  var people = [
    { id: "p1", name: "A", color: "#80BDFB", rowId: "gone" },
    { id: "p2", name: "B", color: "#80BDFB", rowId: "" },
    { id: "p3", name: "C", color: "#80BDFB", rowId: "__proto__" },
    null
  ];
  assert.deepEqual(rundownPresenceGroups(people, ["r1"], {}, 0, RUNDOWN_IDLE_MS), []);
  assert.deepEqual(rundownPresenceGroups([], ["r1"], {}, 0, RUNDOWN_IDLE_MS), []);
  assert.equal(rundownPresenceGroups([{ id: "x", name: "X", color: "", rowId: "r1" }], ["r1"], {}, 1e12, 1)[0].people[0].idle, false);
});

test("dots: one on the block's middle, several side by side around it", () => {
  assert.deepEqual(rundownDotXs(100, 1, 500, 10, 7), [100]);
  assert.deepEqual(rundownDotXs(100, 2, 500, 10, 7), [96.5, 103.5]);
  assert.deepEqual(rundownDotXs(100, 3, 500, 10, 7), [93, 100, 107]);
  assert.deepEqual(rundownDotXs(100, 0, 500, 10, 7), []);
});

test("dots: kept inside the track at either end", () => {
  assert.deepEqual(rundownDotXs(1, 2, 500, 10, 7), [5, 12]);
  assert.deepEqual(rundownDotXs(499, 2, 500, 10, 7), [488, 495]);
  assert.deepEqual(rundownDotXs(4, 3, 8, 10, 7), [-3, 4, 11]);
});
