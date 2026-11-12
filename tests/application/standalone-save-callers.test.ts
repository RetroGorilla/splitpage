import { test } from "node:test";
import assert from "node:assert/strict";
import { capabilityPortCallers } from "./capability-caller-scan.ts";

const DESTINATIONS = {
  "application/save/destinations.ts#createSaveDestinations": { "bootstrap/wiring/save-owners.ts": 1 },
  "application/save/destinations.ts#SaveDestinations.register": { "bootstrap/wiring.ts": 1 },
  "application/save/destinations.ts#SaveDestinations.taking": { "bootstrap/wiring/save-owners.ts": 2 },
  "application/save/destinations.ts#SaveDestination.write": {
    "application/save/destinations.ts": 3,
    "application/save/import-saving.ts": 1,
    "bootstrap/wiring/save-owners.ts": 2
  },
  "application/save/coordinator.ts#SaveCoordinator.request": { "bootstrap/wiring/save-owners.ts": 1 },
  "application/save/file-saving-ports.ts#FileSaveTargets.pick": { "application/save/file-saving.ts": 1 },
  "application/save/file-saving-ports.ts#FileSaveTargets.write": { "application/save/file-saving.ts": 1 },
  "application/save/file-saving-ports.ts#FileSavingPorts.files": { "application/save/file-saving.ts": 6 },
  "application/save/file-saving-ports.ts#FileSaveTargets.checkConflict": { "application/save/file-saving.ts": 1 },
  "application/save/file-saving.ts#writeDoc": { "application/save/file-saving.ts": 1 },
  "application/save/file-saving.ts#writeCaptured": { "application/save/file-saving.ts": 2 },
  "adapters/files/file-target.ts#writeToHandle": { "bootstrap/wiring/file-saving.ts": 1 },
  "adapters/files/file-target.ts#pickTarget": { "bootstrap/wiring/file-saving.ts": 1 },
  "adapters/files/file-target.ts#checkFileConflict": {
    "adapters/files/local-files.ts": 1,
    "bootstrap/wiring/file-saving.ts": 1
  },
  "application/save/import-saving.ts#createImportSavingOwner": { "bootstrap/wiring/local-files.ts": 1 },
  "application/save/import-saving-ports.ts#ImportSavingOwner.writeBackToFile": {
    "application/save/import-saving.ts": 1,
    "bootstrap/wiring/local-files.ts": 1
  },
  "application/save/import-saving-ports.ts#ImportSavingOwner.saveBackToFile": { "application/save/import-saving.ts": 1 },
  "application/save/import-saving-ports.ts#ImportSavingOwner.importSaveDestination": { "application/save/import-saving.ts": 1 },
  "application/files/local-file-access.ts#LocalFileAccess.createWritable": { "application/save/import-saving.ts": 1 },
  "application/files/local-file-access.ts#LocalFileHandle.createWritable": {
    "adapters/files/local-files.ts": 1,
    "application/save/import-saving.ts": 1,
    "application/transitions/local-files.ts": 1
  },
  "application/files/local-file-access.ts#LocalFileWritable.write": { "application/save/import-saving.ts": 1 },
  "application/files/local-file-access.ts#LocalFileWritable.close": { "application/save/import-saving.ts": 1 },
  "adapters/files/file-target.ts#FileHandle.createWritable": { "adapters/files/file-target.ts": 1 },
  "adapters/files/file-target.ts#FileWritable.write": { "adapters/files/file-target.ts": 1 },
  "adapters/files/file-target.ts#FileWritable.close": { "adapters/files/file-target.ts": 1 },
  "features/file-menu/ports.ts#FileMenuActionPorts.save": { "features/file-menu/actions.ts": 2 },
  "features/file-menu/mount.ts#ConflictsPorts.saveDoc": { "features/file-menu/mount.ts": 2 },
  "features/file-menu/mount.ts#ConflictsPorts.buildFileData": { "features/file-menu/mount.ts": 1 },
  "features/file-menu/mount.ts#ConflictsPorts.deliverFile": { "features/file-menu/mount.ts": 1 },
  "application/save/file-conflict.ts#FileConflicts.show": { "bootstrap/wiring/save-owners.ts": 1 }
};

const AUTOSAVE = {
  "application/save/autosave.ts#createAutoSavePolicy": { "bootstrap/wiring/save-owners.ts": 1 },
  "application/save/autosave.ts#AutoSavePolicy.schedule": { "bootstrap/wiring/save-owners.ts": 1 },
  "application/save/autosave.ts#AutoSavePolicy.dueNow": {
    "application/session/session-merge.ts": 1,
    "bootstrap/wiring/document-merge.ts": 1,
    "bootstrap/wiring/ports/saving.ts": 1,
    "bootstrap/wiring/ports/session-merge.ts": 1
  },
  "application/save/autosave.ts#AutoSavePolicy.setEnabled": { "bootstrap/wiring/save-owners.ts": 1 },
  "application/save/session-effects.ts#createSessionEffects": { "bootstrap/wiring/session-effects.ts": 1 },
  "application/save/save-state.ts#SaveState.dueNow": {
    "application/save/session-effects.ts": 1,
    "bootstrap/wiring/production.ts": 1,
    "features/comments/comments.ts": 1
  },
  "features/file-menu/ports.ts#AutosaveActionPorts.autosave.toggle": { "features/file-menu/actions.ts": 1 }
};

let inventory: ReturnType<typeof capabilityPortCallers> | null = null;

function current() {
  inventory ??= capabilityPortCallers([...Object.keys(DESTINATIONS), ...Object.keys(AUTOSAVE)]);
  return inventory;
}

test("save destination callers stay at the audited capability boundaries regardless of receiver spelling", () => {
  assert.deepEqual(Object.fromEntries(Object.keys(DESTINATIONS).map(key => [key, current()[key]])), DESTINATIONS);
});

test("autosave callers stay at the audited capability boundaries regardless of receiver spelling", () => {
  assert.deepEqual(Object.fromEntries(Object.keys(AUTOSAVE).map(key => [key, current()[key]])), AUTOSAVE);
});

const WRITE = "application/save/file-saving-ports.ts#FileSaveTargets.write";
const IMPORTS = `import type { FileSavingPorts } from "../application/save/file-saving-ports.ts";`;

for (const [name, source, count] of [
  ["a renamed receiver", 'function save(renamed: FileSavingPorts) { renamed.files.write(null!, "body"); }', 1],
  ["a literal element key", 'function save(renamed: FileSavingPorts) { renamed.files["write"](null!, "body"); }', 1],
  ["a constant key", 'function save(renamed: FileSavingPorts) { const key = "write"; renamed.files[key](null!, "body"); }', 1],
  ["a union key", 'function save(renamed: FileSavingPorts, key: "write" | "checkConflict") { renamed.files[key](null!, "body"); }', 1],
  ["an unbounded key", 'function save(renamed: FileSavingPorts, key: string) { renamed.files[key](null!, "body"); }', 1],
  ["an ignored capability answer", 'function save(renamed: FileSavingPorts) { renamed.capability.saveDestinations(); renamed.files.write(null!, "body"); }', 1],
  ["a nested binding", 'function save(renamed: FileSavingPorts) { const { files: { write: send } } = renamed; send(null!, "body"); }', 2],
  ["a computed literal binding", 'function save(renamed: FileSavingPorts) { const { ["write"]: send } = renamed.files; send(null!, "body"); }', 2],
  ["a constant computed binding", 'function save(renamed: FileSavingPorts) { const key = "write"; const { [key]: send } = renamed.files; void send; }', 1],
  ["an unbounded computed binding", 'function save(renamed: FileSavingPorts, key: string) { const { [key]: send } = renamed.files; void send; }', 1],
  ["a parameter binding", 'function save({ write: send }: FileSavingPorts["files"]) { send(null!, "body"); }', 2],
  ["a loop binding", 'function save(renamed: FileSavingPorts) { for (const { write: send } of [renamed.files]) send(null!, "body"); }', 2],
  ["an assignment binding", 'function save(renamed: FileSavingPorts) { let send; ({ write: send } = renamed.files); }', 1],
  ["a callback alias", 'type Write = FileSavingPorts["files"]["write"]; function save(send: Write) { send(null!, "body"); }', 1],
  ["a callback call method", 'type Write = FileSavingPorts["files"]["write"]; function save(send: Write) { send.call(null, null!, "body"); }', 1]
] as const) {
  test("save caller scan self-test: " + name, () => {
    assert.deepEqual(capabilityPortCallers([WRITE], { path: "starters/save-capability-probe.ts", source: IMPORTS + source }), {
      [WRITE]: { "starters/save-capability-probe.ts": count }
    });
  });
}

test("save caller scan self-test: unrelated methods and rest bindings are not file writes", () => {
  assert.deepEqual(capabilityPortCallers([WRITE], { path: "starters/save-capability-probe.ts", source: IMPORTS + `
    function save(renamed: FileSavingPorts) { const { ...write } = renamed.files; Object.keys(write); }
    const unrelated = { write() {} }; unrelated.write();
  ` }), { [WRITE]: {} });
});

test("save caller scan self-test: a missing declaration cannot silently erase a boundary", () => {
  assert.throws(() => capabilityPortCallers(["application/save/file-saving-ports.ts#FileSaveTargets.missing"], {
    path: "starters/save-capability-probe.ts", source: IMPORTS
  }), { message: "Capability inventory names a missing declaration: application/save/file-saving-ports.ts#FileSaveTargets.missing" });
});

test("save caller scan self-test: a namespace function access uses the computed key's type", () => {
  const point = "adapters/files/file-target.ts#writeToHandle";
  assert.deepEqual(capabilityPortCallers([point], { path: "starters/save-capability-probe.ts", source: `
    import * as files from "../adapters/files/file-target.ts";
    const key = "writeToHandle";
    files[key](null!, "body");
  ` }), { [point]: { "starters/save-capability-probe.ts": 1 } });
});
