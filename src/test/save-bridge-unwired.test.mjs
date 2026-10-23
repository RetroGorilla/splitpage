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
    ownership: { capture: () => Object.freeze({ destination: "here" }), stillOwns: () => true },
    autosave: { enabledAtStart: () => true, due: () => log.push("autosave due"), changed: (what) => log.push("autosave " + what) }
  };
}

function timers(log) {
  return {
    start: (run, ms) => { log.push("arm:" + ms); return { run }; },
    stop: () => log.push("disarm")
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
  assert.throws(() => bridge.saveChanges(), /not started yet/);
  assert.throws(() => bridge.autoSavePolicy(), /not started yet/);
  assert.equal(bridge.saveBusy(), false, "no coordinator is running a save");
  assert.equal(bridge.unsavedChanges(), false, "no coordinator holds a change");
});

test("started once, with the ports it is handed; a second start throws until the first is stopped", async () => {
  const log = [];
  const stop = bridge.startSaves(ports(log), timers(log));
  const unhear = bridge.onSaveChange((change) => { if (change === "running") log.push("running:" + bridge.saveBusy()); });
  try {
    assert.throws(() => bridge.startSaves(ports([]), timers([])), /already started/);
    const outcome = await bridge.requestSave({ kind: "auto" });
    assert.deepEqual(outcome, { kind: "saved", acknowledged: true });
    assert.deepEqual(log, ["running:true", "write:auto", "running:false"]);
  } finally {
    unhear();
    stop();
  }
  assert.equal(bridge.savesStarted(), false);
});

test("the status readers answer the started coordinator, and its autosave policy is built with it and stopped with it", async () => {
  const log = [];
  const stop = bridge.startSaves(ports(log), timers(log));
  let policy;
  try {
    policy = bridge.autoSavePolicy();
    assert.equal(policy.enabled(), true, "the policy starts from the autosave port's preference");
    assert.equal(bridge.unsavedChanges(), false);
    const seq = bridge.noteSaveChange();
    assert.equal(bridge.saveChanges(), seq, "the change count is the coordinator's");
    assert.equal(bridge.unsavedChanges(), true, "a noted change is unsaved");
    const saving = bridge.requestSave({ kind: "save" });
    assert.equal(bridge.saveBusy(), true, "busy while the coordinator runs the save");
    await saving;
    assert.equal(bridge.saveBusy(), false);
    assert.equal(bridge.unsavedChanges(), true, "only confirming clean saves the change");
    bridge.confirmSavedNow();
    assert.equal(bridge.unsavedChanges(), false);
    policy.schedule("file");
    assert.equal(policy.pending(), true);
  } finally {
    stop();
  }
  assert.equal(policy.pending(), false, "stopping the saves stops the autosave timers");
  assert.deepEqual(log.filter((l) => /^(arm|disarm|autosave)/.test(l)), ["arm:2000", "arm:15000", "disarm", "disarm"]);
  assert.throws(() => bridge.autoSavePolicy(), /not started yet/);
  assert.equal(bridge.unsavedChanges(), false);
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

test("confirming a save drops autosave's timers and halt before the coordinator announces it clean", () => {
  const log = [];
  const stop = bridge.startSaves(ports(log), timers(log));
  const unhear = bridge.onSaveChange((change) => {
    log.push("announced " + change + " halted=" + JSON.stringify(bridge.autoSavePolicy().halted()) + " pending=" + bridge.autoSavePolicy().pending());
  });
  try {
    bridge.noteSaveChange();
    bridge.autoSavePolicy().schedule("file");
    bridge.autoSavePolicy().halt("Paused");
    log.length = 0;
    bridge.confirmSavedNow();
    assert.deepEqual(log, ["autosave halt", 'announced halt halted="" pending=false', 'announced clean halted="" pending=false']);
    assert.equal(bridge.unsavedChanges(), false);
  } finally {
    unhear();
    stop();
  }
});
