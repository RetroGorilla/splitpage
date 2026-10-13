import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const bridge = await import("../legacy/save-bridge.ts");

function ports(log) {
  return {
    write: async (job) => { log.push("write:" + job.request.kind); return { kind: "saved" }; },
    destination: () => "here",
    keyOf: (identity) => ({ owner: identity, name: "" }),
    obsolete: () => log.push("obsolete"),
    running: (running) => log.push("running:" + running),
    ownership: { capture: () => Object.freeze({ destination: "here" }), stillOwns: () => true }
  };
}

test("before the save coordinator is started, every accessor throws instead of running on a default", () => {
  assert.equal(bridge.savesStarted(), false);
  assert.throws(() => bridge.requestSave({ kind: "save" }), /The save coordinator is not started yet/);
  assert.throws(() => bridge.saveRunning(), /not started yet/);
  assert.throws(() => bridge.noteSaveChange(), /not started yet/);
  assert.throws(() => bridge.confirmSavedNow(), /not started yet/);
  assert.throws(() => bridge.confirmBaseline(null), /not started yet/);
  assert.throws(() => bridge.confirmedGeneration(), /not started yet/);
});

test("started once, with the ports it is handed; a second start throws until the first is stopped", async () => {
  const log = [];
  const stop = bridge.startSaves(ports(log));
  try {
    assert.throws(() => bridge.startSaves(ports([])), /already started/);
    const outcome = await bridge.requestSave({ kind: "auto" });
    assert.deepEqual(outcome, { kind: "saved", acknowledged: true });
    assert.deepEqual(log, ["running:true", "write:auto", "running:false"]);
  } finally {
    stop();
  }
  assert.equal(bridge.savesStarted(), false);
});

test("the legacy join rule: plain saves fold, a manual save absorbs an automatic one, Save As and a forced save never fold", () => {
  const j = (a, b) => { const out = bridge.joinSaves({ kind: a }, { kind: b }); return out && out.kind; };
  assert.equal(j("auto", "auto"), "auto");
  assert.equal(j("autosave", "autosave"), "autosave");
  assert.equal(j("autosave", "auto"), "auto");
  assert.equal(j("auto", "save"), "save");
  assert.equal(j("save", "autosave"), "save");
  assert.equal(j("server", "save"), "save");
  assert.equal(j("save", "server"), "save");
  assert.equal(j("saveAs", "save"), null);
  assert.equal(j("save", "force"), null);
});
