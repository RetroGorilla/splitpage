import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";

const bridge = await import("../legacy/session-bridge.ts");
const { migrateRows } = await import("../js/02-state.js");
const { sceneStatusCommand } = await import("../application/commands/scene-status.ts");
const { sceneLengthCommand } = await import("../application/commands/scene-length.ts");

function script() {
  S.state = migrateRows({ title: "Unwired", rows: [{ id: "r1", visualText: "", audioText: "", status: "todo" }] });
  return S.state;
}

test("with nothing wired, loading the bridge alone provides no port: each one throws instead of running on a default", () => {
  assert.throws(() => bridge.editAllowed(), /The session's edit capability port was not provided/);
  assert.throws(() => bridge.sessionStamps.editor.name(), /The session's editor name port was not provided/);
});

test("with nothing wired, a command that needs edit capability throws before it plans or writes", () => {
  const doc = script();
  const before = JSON.stringify(doc);
  assert.throws(() => bridge.runCommand(sceneStatusCommand("r1", bridge.sessionStamps)), /edit capability port was not provided/);
  assert.equal(JSON.stringify(S.state), before);
  assert.equal(bridge.liveSession().generation(), 0);
});

test("with only the capability wired, a command fails on the missing attribution and writes nothing", () => {
  const doc = script();
  const before = JSON.stringify(doc);
  bridge.provideSessionEffects({ edit: () => ({ allowed: true }) });
  const outcome = bridge.runCommand(sceneLengthCommand("r1", 30, bridge.sessionStamps));
  assert.equal(outcome.kind, "failed");
  assert.match(outcome.error.message, /attribution port was not provided/);
  assert.equal(JSON.stringify(S.state), before);
});

test("with the attribution wired but no editor name, the command fails on its stamp and writes nothing", () => {
  const doc = script();
  const before = JSON.stringify(doc);
  bridge.provideSessionEffects({ attribute: () => null });
  const outcome = bridge.runCommand(sceneLengthCommand("r1", 30, bridge.sessionStamps));
  assert.equal(outcome.kind, "failed");
  assert.match(outcome.error.message, /editor name port was not provided/);
  assert.equal(JSON.stringify(S.state), before);
});

test("with the effects missing, a legacy edit reports each missing effect and throws nothing", () => {
  script();
  const reported = [];
  const consoleError = console.error;
  console.error = (error) => { reported.push(error.message); };
  try {
    bridge.noteSessionEdit();
  } finally {
    console.error = consoleError;
  }
  assert.deepEqual(reported, [
    "The session's dirty port was not provided",
    "The session's draft port was not provided",
    "The session's save port was not provided"
  ]);
});

test("with no refresh runner, a refresh that comes due throws instead of doing nothing", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  bridge.requestRefresh("production");
  assert.throws(() => t.mock.timers.tick(1000), /The session's refresh port was not provided/);
});

test("once every port is provided, a command applies", () => {
  script();
  const ran = [];
  bridge.provideSessionEffects({
    dirty: () => ran.push("dirty"),
    draft: () => ran.push("draft"),
    save: () => ran.push("save"),
    editorName: () => "Ann"
  });
  bridge.provideRefreshRunner(() => {});
  const outcome = bridge.runCommand(sceneLengthCommand("r1", 30, bridge.sessionStamps));
  assert.equal(outcome.kind, "applied");
  assert.deepEqual(ran, ["dirty", "draft", "save"]);
  bridge.liveSession().dispose();
});
