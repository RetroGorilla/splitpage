import test from "node:test";
import assert from "node:assert/strict";
import { createImportSavingOwner } from "../../src/application/save/import-saving.js";
import type { ImportSavingOwner, ImportSavingPorts, ImportSaveRequest } from "../../src/application/save/import-saving-ports.ts";
import type { SaveJob } from "../../src/application/save/coordinator.ts";
import { createDocumentLocation } from "../../src/application/location/document-location.ts";
import { fakeNotices } from "../features/fakes.ts";

function harness() {
  const log: string[] = [];
  const location = createDocumentLocation();
  const imported = location.setHome("import", { name: "draft.txt", handle: { createWritable: true }, format: "txt", inPlace: true });
  const state = { conflict: false, owns: true };
  const owner: ImportSavingOwner = createImportSavingOwner();
  const ports: ImportSavingPorts = {
    location, onServerDoc: () => false,
    saving: { request: async (request) => { assert.equal(request.target, imported); log.push(request.kind); return { kind: "saved", acknowledged: true }; }, unsavedFor: () => true },
    buildFileData: async (kind, base) => { log.push("build:" + kind + ":" + base); return { data: "bytes", filename: "draft.txt" }; },
    files: {
      read: async () => { log.push("readAfter"); return { name: "draft.txt", lastModified: 50, size: 100, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) }; },
      checkConflict: async () => { log.push("check"); return state.conflict ? { ok: false, current: { lastModified: 49 } } : { ok: true }; },
      createWritable: async () => { log.push("createWritable"); return { write: async (bytes) => { assert.equal(bytes, "bytes"); log.push("write"); }, close: async () => { log.push("close"); } }; }
    },
    delivery: { deliver: async () => { log.push("deliver"); return true; } },
    notices: fakeNotices().notices
  };
  const job: SaveJob<ImportSaveRequest> = {
    request: { kind: "writeback", target: imported }, generation: 1,
    owns: () => state.owns, alive: () => true, moved: () => {},
    operation: () => ({ epoch: 1, docId: "d1", destination: imported, destinationGeneration: 0, generation: 1, connection: null, revision: null })
  };
  return { owner, ports, log, imported, state, job };
}

test("import writer guards lifecycle and retained destinations", () => {
  const h = harness();
  assert.throws(() => h.owner.saveBackItemState(), /not started yet/);
  const stop = h.owner.startImportSaving(h.ports);
  const destination = h.owner.importSaveDestination();
  stop();
  assert.throws(() => h.owner.saveBackToFile(), /not started yet/);
  assert.throws(() => destination.write(h.job), /not started yet/);
});

test("writeback builds, checks, opens, writes, closes, then reads metadata in order", async () => {
  const h = harness();
  const stop = h.owner.startImportSaving(h.ports);
  assert.deepEqual(await h.owner.writeBackToFile(h.job), { kind: "saved" });
  assert.deepEqual(h.log, ["build:txt:draft", "check", "createWritable", "write", "close", "readAfter"]);
  assert.equal(h.imported["lastModified"], 50);
  assert.equal(h.imported["size"], 100);
  h.log.length = 0;
  await h.owner.saveBackToFile({ force: true });
  assert.deepEqual(h.log, ["writebackForce"]);
  assert.equal(h.imported["dirty"], true);
  stop();
});

test("a conflict and a lost document each refuse without creating a writable", async () => {
  const h = harness();
  const stop = h.owner.startImportSaving(h.ports);
  h.state.conflict = true;
  assert.equal((await h.owner.writeBackToFile(h.job)).kind, "refused");
  assert.deepEqual(h.log, ["build:txt:draft", "check"]);
  h.log.length = 0;
  h.state.owns = false;
  assert.equal((await h.owner.writeBackToFile(h.job)).kind, "refused");
  assert.deepEqual(h.log, []);
  stop();
});
