import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const bridge = await import("../legacy/session-bridge.ts");
const { migrateRows } = await import("../js/02-state.js");
const { sceneLengthCommand } = await import("../application/commands/scene-length.ts");
const { startTestSession, unwiredSessionDeps } = await import("./_session.mjs");

const unwired = unwiredSessionDeps();
const refreshed = [];
Object.assign(unwired.given, {
  dirty: () => {},
  draft: () => {},
  save: () => {},
  edit: () => ({ allowed: true }),
  editorName: () => "Ann",
  attribute: () => null,
  refresh: (jobs) => { refreshed.push(["app", Array.from(jobs)]); }
});

function script(title) {
  return migrateRows({ title: title, rows: [{ id: "r1", visualText: "", audioText: "", status: "todo" }] });
}

const heard = [];
const early = (change) => { heard.push(["early", change.kind, change.generation]); };
bridge.onSessionChange(early);
startTestSession(unwired.deps);

test("a change listener registered before the session starts hears the first session's adoption and edits", () => {
  bridge.liveSession().adopt(script("First"));
  bridge.runCommand(sceneLengthCommand("r1", 30, bridge.sessionStamps));
  assert.deepEqual(heard, [["early", "adopt", 0], ["early", "edit", 1]]);
});

test("a change listener hears a replacement document's adoption and the edits made on it, with no subscribing again", () => {
  heard.length = 0;
  const late = (change) => { heard.push(["late", change.kind, change.generation]); };
  const stop = bridge.onSessionChange(late);
  bridge.adoptReplacement(script("Second"));
  bridge.runCommand(sceneLengthCommand("r1", 45, bridge.sessionStamps));
  assert.deepEqual(heard, [
    ["early", "adopt", 1], ["late", "adopt", 1],
    ["early", "edit", 2], ["late", "edit", 2]
  ], "each listener hears every change in the order they registered");
  stop();
});

test("a stopped change listener hears nothing more, on this session or a replacement", () => {
  heard.length = 0;
  const gone = (change) => { heard.push(["gone", change.kind]); };
  const stop = bridge.onSessionChange(gone);
  stop();
  bridge.runCommand(sceneLengthCommand("r1", 50, bridge.sessionStamps));
  bridge.adoptReplacement(script("Third"));
  assert.deepEqual(heard.filter((h) => h[0] === "gone"), []);
  assert.deepEqual(heard.map((h) => h[1]), ["edit", "adopt"], "the listener still registered hears both");
});

test("a refresh listener hears the jobs that come due, after the app's refresh runner, and nothing once stopped", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const mine = [];
  const stop = bridge.onRefresh((jobs) => { refreshed.push(["screen", Array.from(jobs)]); mine.push(Array.from(jobs)); });
  refreshed.length = 0;
  bridge.requestRefresh("rowTimes");
  bridge.requestRefresh("production");
  assert.deepEqual(refreshed, [], "nothing runs before the jobs come due");
  t.mock.timers.tick(1000);
  assert.deepEqual(refreshed, [["app", ["rowTimes", "production"]], ["screen", ["rowTimes", "production"]]]);
  stop();
  bridge.requestRefresh("rowTimes");
  t.mock.timers.tick(1000);
  assert.deepEqual(mine, [["rowTimes", "production"]]);
});

test("a listener stopped and registered again on the same session hears each change once", () => {
  heard.length = 0;
  const again = (change) => { heard.push(["again", change.kind]); };
  bridge.onSessionChange(again)();
  const stop = bridge.onSessionChange(again);
  bridge.runCommand(sceneLengthCommand("r1", 55, bridge.sessionStamps));
  stop();
  assert.deepEqual(heard.filter((h) => h[0] === "again"), [["again", "edit"]]);
});
