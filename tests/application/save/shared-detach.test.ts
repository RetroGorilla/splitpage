import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionCapabilities } from "../../../src/application/session/capabilities.ts";
import { createSaveDestinations } from "../../../src/application/save/destinations.ts";
import type { SaveDestination } from "../../../src/application/save/destinations.ts";
import { createAutoSavePolicy } from "../../../src/application/save/autosave.ts";
import { mountFileSaving } from "../../../src/application/save/file-saving.ts";
import type { FileSavingPorts } from "../../../src/application/save/file-saving-ports.ts";
import { createSessionEffects } from "../../../src/application/save/session-effects.ts";
import type { SessionEffectPorts } from "../../../src/application/save/session-effects.ts";
import type { SaveJob } from "../../../src/application/save/coordinator.ts";
import { createImportSavingOwner } from "../../../src/application/save/import-saving.ts";
import type { ImportSavingPorts } from "../../../src/application/save/import-saving-ports.ts";
import { changeSet } from "../../../src/application/session/change-set.ts";
import type { EffectPorts } from "../../../src/application/effects/ports.ts";
import { startEffects } from "../../../src/bootstrap/wiring/effects-owner.ts";
import { autoSavePolicy, autoSaveTarget, flushAutoSave, queueAutoSave, requestSave, saveDoc, scheduleAutoSave, setAutoSaveEnabled, startSaves, toggleAutoSave } from "../../../src/bootstrap/wiring/save-owners.ts";

const SHARED = createSessionCapabilities("shared", { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) });
const STANDALONE = createSessionCapabilities("standalone", { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) });

test("shared destinations refuse registration and selection before reading a destination or asking it anything", () => {
  const calls: string[] = [];
  const destinations = createSaveDestinations(SHARED);
  const destination = new Proxy({} as SaveDestination<unknown>, {
    get: (_target, key) => { calls.push(String(key)); throw new Error("destination read"); }
  });
  assert.throws(() => destinations.register(destination), { message: "Save destinations are not available in a shared session." });
  assert.throws(() => destinations.taking({}, {}), { message: "Save destinations are not available in a shared session." });
  assert.deepEqual(destinations.ids(), []);
  assert.deepEqual(calls, []);
});

test("a destination selected before authority changes refuses a later write with the current reason", async () => {
  let capability = STANDALONE;
  const calls: string[] = [];
  const destinations = createSaveDestinations<{ kind: string }, string>({ saveDestinations: () => capability.saveDestinations() });
  destinations.register({ id: "file", takes: () => true, autoSaveTarget: () => "file", write: async () => { calls.push("write"); return { kind: "saved" }; } });
  const destination = destinations.taking({ kind: "save" }, "file");
  assert.ok(destination);
  capability = SHARED;
  assert.deepEqual(await destination.write(job("save", calls)), { kind: "refused", reason: "Save destinations are not available in a shared session." });
  assert.deepEqual(calls, []);
});

test("standalone destinations retain the registered writer and frozen receiver when the original object changes", async () => {
  const calls: string[] = [];
  const source = {
    id: "file", takes: () => true, autoSaveTarget: () => null,
    async write() { calls.push("original:" + this.id); return { kind: "saved" as const }; }
  };
  const destinations = createSaveDestinations<{ kind: string }>(STANDALONE);
  destinations.register(source);
  source.id = "changed";
  source.write = async () => { calls.push("replacement"); return { kind: "saved" as const }; };
  const destination = destinations.taking({ kind: "save" }, null);
  assert.ok(destination);
  assert.equal(Object.isFrozen(destination), true);
  assert.deepEqual(await destination.write(job("save", calls)), { kind: "saved" });
  assert.deepEqual(calls, ["original:file"]);
});

test("shared autosave schedules no timer, reads no preference, changes no setting and never calls due", () => {
  const calls: unknown[][] = [];
  const policy = createAutoSavePolicy({
    capability: SHARED,
    timers: { start: (_run, ms) => { calls.push(["timer.start", ms]); return 1; }, stop: handle => { calls.push(["timer.stop", handle]); } },
    enabledAtStart: () => { calls.push(["preference"]); return true; },
    due: () => { calls.push(["due"]); },
    changed: what => { calls.push(["changed", what]); }
  });
  const scheduled = policy.schedule("file");
  assert.deepEqual(calls, []);
  assert.equal(policy.scheduled(), 0);
  assert.deepEqual(scheduled, { allowed: false, reason: "File autosave is not available in a shared session." });
  assert.deepEqual(policy.dueNow(), { allowed: false, reason: "File autosave is not available in a shared session." });
  assert.deepEqual(policy.setEnabled(true), { allowed: false, reason: "File autosave is not available in a shared session." });
  assert.equal(policy.enabled(), false);
  assert.equal(policy.may("file"), false);
  assert.equal(policy.pending(), false);
  assert.equal(policy.scheduled(), 0);
  assert.deepEqual(calls, []);
});

test("an autosave timer armed before authority changes is cleared without calling due", () => {
  let capability = STANDALONE;
  const timers: (() => void)[] = [];
  const calls: unknown[][] = [];
  const policy = createAutoSavePolicy({
    capability: { autosave: () => capability.autosave() },
    timers: { start: (run, ms) => { timers.push(run); calls.push(["start", ms]); return timers.length; }, stop: handle => { calls.push(["stop", handle]); } },
    enabledAtStart: () => true, due: () => { calls.push(["due"]); }, changed: () => { calls.push(["changed"]); }
  });
  policy.schedule("file");
  assert.deepEqual(calls, [["start", 2000], ["start", 15000]]);
  capability = SHARED;
  timers[0]?.();
  timers[1]?.();
  assert.deepEqual(calls, [["start", 2000], ["start", 15000], ["stop", 1], ["stop", 2]]);
  assert.equal(policy.pending(), false);
});

function job(kind: string, calls: string[]): SaveJob<{ kind: string }> {
  return {
    request: { kind }, generation: 0,
    operation: () => { calls.push("operation"); throw new Error("unexpected operation"); },
    owns: () => { calls.push("owns"); return true; }, alive: () => { calls.push("alive"); return true; },
    moved: () => { calls.push("moved"); }, landed: () => { calls.push("landed"); }
  };
}

function guardedFilePorts(capability: FileSavingPorts["capability"], calls: string[], bundles?: FileSavingPorts["bundles"]): FileSavingPorts {
  const unexpected = (name: string): never => { calls.push(name); throw new Error("unexpected file port"); };
  return {
    capability,
    get edits() { return unexpected("edits"); },
    get history() { return unexpected("history"); },
    get deferred() { return unexpected("deferred"); },
    get ids() { return unexpected("ids"); },
    get clock() { return unexpected("clock"); },
    get document() { return unexpected("document"); },
    get location() { return unexpected("location"); },
    get lastFile() { return unexpected("lastFile"); },
    get pictures() { return unexpected("pictures"); },
    get exports() { return unexpected("exports"); },
    get formats() { return unexpected("formats"); },
    get files() { return unexpected("files"); },
    get delivery() { return unexpected("delivery"); },
    get saves() { return unexpected("saves"); },
    get notices() { return unexpected("notices"); },
    get preferences() { return unexpected("preferences"); },
    get page() { return unexpected("page"); },
    get bundles() { return bundles ?? unexpected("bundles"); }
  };
}

for (const kind of ["save", "saveAs", "auto", "autosave", "force"]) {
  test("shared file writer refuses " + kind + " before capture, naming, undo, picker, delivery or writing", async t => {
    const calls: string[] = [];
    const saving = mountFileSaving(guardedFilePorts(SHARED, calls));
    t.after(saving.dispose);
    assert.deepEqual(await saving.destination().write(job(kind, calls)), { kind: "refused", reason: "Save destinations are not available in a shared session." });
    assert.deepEqual(calls, []);
  });
}

for (const kind of ["auto", "autosave"]) {
  test("file writer refuses " + kind + " when destinations allow but autosave refuses, before reading any file port", async t => {
    const calls: string[] = [];
    const capability = { ...STANDALONE, autosave: SHARED.autosave };
    const saving = mountFileSaving(guardedFilePorts(capability, calls));
    t.after(saving.dispose);
    assert.deepEqual(await saving.destination().write(job(kind, calls)), { kind: "refused", reason: "File autosave is not available in a shared session." });
    assert.deepEqual(calls, []);
  });
}

test("automatic requests ask autosave before planning even when manual destinations allow", async t => {
  const calls: string[] = [];
  t.after(startSaves({
    capability: { ...STANDALONE, autosave: SHARED.autosave },
    destination: () => { calls.push("destination"); return null; },
    keyOf: () => { calls.push("keyOf"); return { owner: null, name: "none" }; },
    obsolete: () => { calls.push("obsolete"); },
    ownership: { capture: () => { calls.push("capture"); throw new Error("unexpected capture"); }, stillOwns: () => { calls.push("stillOwns"); return true; } },
    autosave: { enabledAtStart: () => { calls.push("preference"); return true; }, changed: () => { calls.push("changed"); } }
  }, { start: () => { calls.push("timer.start"); return 1; }, stop: () => { calls.push("timer.stop"); } }));
  for (const kind of ["auto", "autosave"] as const) {
    assert.deepEqual(await requestSave({ kind }), { kind: "refused", reason: "File autosave is not available in a shared session." });
  }
  assert.deepEqual(calls, []);
});

test("Save As waiting for bundle copies rechecks before holding standalone undo or capturing", async t => {
  let capability = STANDALONE;
  let drained: (ready: boolean) => void = () => { throw new Error("drain was not started"); };
  const waiting = new Promise<boolean>(resolve => { drained = resolve; });
  const calls: string[] = [];
  const ports = guardedFilePorts({ saveDestinations: () => capability.saveDestinations(), autosave: () => capability.autosave() }, calls, {
    beginSave: () => {
      calls.push("bundle.begin");
      return { drained: waiting, ask: async () => [], end: () => { calls.push("bundle.end"); } };
    }
  });
  const saving = mountFileSaving(ports);
  t.after(saving.dispose);
  const pending = saving.destination().write(job("saveAs", calls));
  assert.deepEqual(calls, ["owns", "bundle.begin"]);
  capability = SHARED;
  drained(true);
  assert.deepEqual(await pending, { kind: "refused", reason: "Save destinations are not available in a shared session." });
  assert.deepEqual(calls, ["owns", "bundle.begin", "bundle.end"]);
});

test("shared save requests stop before destination, ownership, writer and conflict ports", async t => {
  const calls: unknown[][] = [];
  t.after(startSaves({
    capability: SHARED,
    destination: () => { calls.push(["destination"]); return "file"; },
    keyOf: identity => { calls.push(["keyOf", identity]); return { owner: identity, name: "file" }; },
    obsolete: request => { calls.push(["obsolete", request]); },
    ownership: { capture: () => { calls.push(["capture"]); throw new Error("unexpected capture"); }, stillOwns: () => { calls.push(["stillOwns"]); return true; } },
    autosave: { enabledAtStart: () => { calls.push(["preference"]); return true; }, changed: what => { calls.push(["changed", what]); } }
  }, { start: (_run, ms) => { calls.push(["timer.start", ms]); return 1; }, stop: handle => { calls.push(["timer.stop", handle]); } }));
  for (const kind of ["save", "saveAs", "auto", "autosave", "force", "writeback", "writebackForce"] as const) {
    const outcome = await requestSave({ kind });
    assert.deepEqual(calls, []);
    assert.deepEqual(outcome, { kind: "refused", reason: "Save destinations are not available in a shared session." });
  }
  scheduleAutoSave();
  queueAutoSave();
  flushAutoSave();
  assert.equal(autoSaveTarget(), null);
  assert.deepEqual(autoSavePolicy().dueNow(), { allowed: false, reason: "File autosave is not available in a shared session." });
  assert.deepEqual(calls, []);
});

test("the import destination and its save-back actions refuse before reading, building, requesting or writing", async t => {
  const calls: string[] = [];
  const notices: unknown[][] = [];
  const unused = (name: string) => (): never => { calls.push(name); throw new Error("unexpected import port"); };
  const ports: ImportSavingPorts = {
    capability: SHARED,
    location: { importHome: unused("home"), amendHome: unused("amendHome") },
    saving: { request: unused("request"), unsavedFor: unused("unsavedFor") },
    buildFileData: unused("build"),
    files: { read: unused("read"), checkConflict: unused("checkConflict"), createWritable: unused("createWritable") },
    delivery: { deliver: unused("deliver") },
    notices: { show: (text, kind) => { notices.push([text, kind]); return { isConnected: true, dismiss: () => {}, removeEventListener: () => {} }; } }
  };
  const owner = createImportSavingOwner();
  t.after(owner.startImportSaving(ports));
  assert.deepEqual(owner.saveBackItemState(), { hidden: false, disabled: true, reason: "Save destinations are not available in a shared session.", label: "Save to file" });
  for (const kind of ["writeback", "writebackForce"]) {
    assert.deepEqual(await owner.importSaveDestination().write(job(kind, calls)), { kind: "refused", reason: "Save destinations are not available in a shared session." });
  }
  await owner.saveBackToFile();
  await owner.saveBackToFile({ force: true });
  assert.deepEqual(calls, []);
  assert.deepEqual(notices, [["Save destinations are not available in a shared session.", "warn"], ["Save destinations are not available in a shared session.", "warn"]]);
});

test("shared manual saves and autosave settings present their refusal before preferences or save ports", async t => {
  const calls: string[] = [];
  const notices: unknown[][] = [];
  const unused = (name: string) => (): never => { calls.push(name); throw new Error("unexpected save port"); };
  t.after(startEffects(new Proxy({} as EffectPorts<Element>, {
    get: (_target, key) => {
      if (key === "notices") return { show: (message: string, kind: string) => {
        notices.push([message, kind]);
        return { isConnected: true, dismiss: () => {}, removeEventListener: () => {} };
      } };
      calls.push(String(key));
      throw new Error("unexpected effect port");
    }
  })));
  t.after(startSaves({
    capability: SHARED,
    destination: unused("destination"), keyOf: unused("keyOf"), obsolete: unused("obsolete"),
    ownership: { capture: unused("capture"), stillOwns: unused("stillOwns") },
    autosave: { enabledAtStart: unused("preference"), changed: unused("changed") }
  }, { start: unused("timer.start"), stop: unused("timer.stop") }));
  setAutoSaveEnabled(true);
  toggleAutoSave();
  await saveDoc();
  await saveDoc({ saveAs: true });
  assert.deepEqual(calls, []);
  assert.deepEqual(notices, [
    ["File autosave is not available in a shared session.", "warn"],
    ["File autosave is not available in a shared session.", "warn"],
    ["Save destinations are not available in a shared session.", "warn"],
    ["Save destinations are not available in a shared session.", "warn"]
  ]);
});

for (const member of ["saveDestinations", "autosave"] as const) {
  test("the local save effect asks " + member + " before scheduling, changing an import destination or saving now", () => {
    const calls: string[] = [];
    const capability = { ...STANDALONE, [member]: () => SHARED[member]() };
    const ports = new Proxy({} as SessionEffectPorts, {
      get: (_target, key) => {
        if (key === "capability") return capability;
        calls.push(String(key));
        throw new Error("unexpected effect port");
      }
    });
    createSessionEffects(ports).save({ kind: "edit", epoch: 1, generation: 1, changes: changeSet({ saveNow: true }) });
    assert.deepEqual(calls, []);
  });
}
