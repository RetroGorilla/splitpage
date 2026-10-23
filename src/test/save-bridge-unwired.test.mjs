import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const bridge = await import("../legacy/save-bridge.ts");

function probe(log, target = "file") {
  return {
    id: "probe",
    takes: () => true,
    autoSaveTarget: () => target,
    write: async (job) => { log.push("write:" + job.request.kind); return { kind: "saved" }; }
  };
}

function ports(log) {
  return {
    destination: () => "here",
    keyOf: (identity) => ({ owner: identity, name: "" }),
    obsolete: () => log.push("obsolete"),
    ownership: { capture: () => Object.freeze({ destination: "here" }), stillOwns: () => true },
    autosave: { enabledAtStart: () => true, changed: (what) => log.push("autosave " + what) }
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
  assert.throws(() => bridge.saveDestinations(), /not started yet/);
  assert.throws(() => bridge.autoSaveTarget(), /not started yet/);
  assert.throws(() => bridge.scheduleAutoSave(), /not started yet/);
  assert.throws(() => bridge.queueAutoSave(), /not started yet/);
  assert.throws(() => bridge.flushAutoSave(), /not started yet/);
  assert.throws(() => bridge.saveDoc(), /not started yet/);
  assert.equal(bridge.saveBusy(), false, "no coordinator is running a save");
  assert.equal(bridge.unsavedChanges(), false, "no coordinator holds a change");
});

test("started once, with the ports it is handed; a second start throws until the first is stopped", async () => {
  const log = [];
  const stop = bridge.startSaves(ports(log), timers(log));
  bridge.saveDestinations().register(probe(log));
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
  bridge.saveDestinations().register(probe(log));
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

test("a save goes to the newest destination that takes it, and with none it is refused without a write", async () => {
  const log = [];
  const stop = bridge.startSaves(ports(log), timers(log));
  try {
    assert.deepEqual(await bridge.requestSave({ kind: "save" }), { kind: "refused", reason: "No save destination takes this save" });
    const places = [];
    const older = { id: "older", takes: (request, place) => { places.push(place); return true; }, autoSaveTarget: () => "file", write: async () => { log.push("older"); return { kind: "saved" }; } };
    const newer = { id: "newer", takes: (request) => request.kind === "saveAs", autoSaveTarget: () => null, write: async () => { log.push("newer"); return { kind: "saved" }; } };
    bridge.saveDestinations().register(older);
    const drop = bridge.saveDestinations().register(newer);
    assert.deepEqual(bridge.saveDestinations().ids(), ["newer", "older"]);
    await bridge.requestSave({ kind: "save" });
    await bridge.requestSave({ kind: "saveAs" });
    assert.deepEqual(log, ["older", "newer"]);
    assert.deepEqual(places, ["here"], "a destination is asked about the document's current place");
    drop();
    await bridge.requestSave({ kind: "saveAs" });
    assert.deepEqual(log, ["older", "newer", "older"], "a dropped destination is no longer asked");
    assert.throws(() => bridge.saveDestinations().register({ ...older }), /already registered/);
  } finally {
    stop();
  }
});

test("autosave asks the destination that would take it: its target gates the write, and nothing unsaved writes nothing", async () => {
  const log = [];
  const stop = bridge.startSaves(ports(log), timers(log));
  try {
    const drop = bridge.saveDestinations().register(probe(log, null));
    assert.equal(bridge.autoSaveTarget(), null);
    bridge.noteSaveChange();
    assert.deepEqual(await bridge.requestSave({ kind: "autosave" }), { kind: "refused", reason: "Autosave is off, paused, has nowhere to write or nothing to write" });
    drop();
    bridge.saveDestinations().register(probe(log, "server"));
    assert.equal(bridge.autoSaveTarget(), "server");
    assert.deepEqual(await bridge.requestSave({ kind: "autosave" }), { kind: "saved", acknowledged: true });
    bridge.confirmSavedNow();
    assert.equal((await bridge.requestSave({ kind: "autosave" })).kind, "refused", "nothing unsaved");
    assert.deepEqual(log.filter((l) => l.startsWith("write:")), ["write:autosave"]);
  } finally {
    stop();
  }
});

test("scheduleAutoSave arms the policy for the destination's target, and a due autosave writes through the destination", async () => {
  const log = [];
  const armed = [];
  const stop = bridge.startSaves(ports(log), { start: (run, ms) => { armed.push({ run, ms }); return armed.length; }, stop: () => {} });
  try {
    bridge.saveDestinations().register(probe(log, "server"));
    bridge.noteSaveChange();
    bridge.scheduleAutoSave();
    assert.deepEqual(armed.map((t) => t.ms), [5000, 15000], "the server target waits the hosted idle time");
    armed[0].run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(log.filter((l) => l.startsWith("write:")), ["write:autosave"]);
  } finally {
    stop();
  }
});

test("saveDoc resumes a halted autosave unless it is automatic, and saveToServer answers whether the server save was sent", async () => {
  const log = [];
  const stop = bridge.startSaves(ports(log), timers(log));
  try {
    bridge.saveDestinations().register(probe(log));
    bridge.haltAutoSave("Paused");
    await bridge.saveDoc({ auto: true });
    assert.equal(bridge.autoSavePolicy().halted(), "Paused", "an automatic save leaves the halt");
    await bridge.saveDoc({ saveAs: true });
    assert.equal(bridge.autoSavePolicy().halted(), "", "a manual save resumes autosave");
    assert.equal(await bridge.saveToServer(), true);
    assert.deepEqual(log.filter((l) => l.startsWith("write:")), ["write:auto", "write:saveAs", "write:server"]);
  } finally {
    stop();
  }
});
