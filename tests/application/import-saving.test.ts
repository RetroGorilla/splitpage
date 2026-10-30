import test from "node:test";
import assert from "node:assert/strict";
import { createImportSavingOwner } from "../../src/application/save/import-saving.ts";
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
    location,
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
    operation: () => ({ epoch: 1, docId: "d1", destination: imported, destinationGeneration: 0, generation: 1 })
  };
  return { owner, ports, log, imported, state, job };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const stage of ["build", "conflict", "writable", "write", "close", "metadata"]) {
  test("writeback stopped during " + stage + " performs only safe writable cleanup", async () => {
    const h = harness();
    const entered = deferred<undefined>();
    const gate = deferred<undefined>();
    const hold = async () => { entered.resolve(undefined); await gate.promise; };
    const ports: ImportSavingPorts = {
      ...h.ports,
      buildFileData: async (kind, base) => { const built = h.ports.buildFileData(kind, base); if (stage === "build") await hold(); return built; },
      files: {
        checkConflict: async () => { if (stage === "conflict") await hold(); return { ok: true }; },
        createWritable: async () => {
          if (stage === "writable") await hold();
          return {
            abort: async () => { h.log.push("abort"); },
            write: async () => { h.log.push("write"); if (stage === "write") await hold(); },
            close: async () => { h.log.push("close"); if (stage === "close") await hold(); }
          };
        },
        read: async () => { if (stage === "metadata") await hold(); return { name: "draft.txt", lastModified: 50, size: 100, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) }; }
      }
    };
    const stop = h.owner.startImportSaving(ports);
    const pending = h.owner.writeBackToFile(h.job);
    await entered.promise;
    stop();
    h.state.owns = false;
    const before = [...h.log];
    const stopReplacement = h.owner.startImportSaving(h.ports);
    gate.resolve(undefined);
    assert.equal((await pending).kind, "refused");
    assert.deepEqual(h.log, stage === "writable" || stage === "write" ? [...before, "abort"] : before);
    assert.equal(h.imported["lastModified"], null);
    stopReplacement();
  });
}

test("requestSave completion after teardown never amends the old or replacement home", async () => {
  const h = harness();
  const completion = deferred<Awaited<ReturnType<ImportSavingPorts["saving"]["request"]>>>();
  const stop = h.owner.startImportSaving({ ...h.ports, saving: { ...h.ports.saving, request: () => completion.promise } });
  const pending = h.owner.saveBackToFile();
  stop();
  const stopReplacement = h.owner.startImportSaving(h.ports);
  completion.resolve({ kind: "saved", acknowledged: true });
  await pending;
  assert.equal(h.imported["dirty"], false);
  stopReplacement();
});

test("a stale buffered writable without abort is never closed or delivered", async () => {
  const h = harness();
  const entered = deferred<undefined>();
  const gate = deferred<undefined>();
  const stop = h.owner.startImportSaving({ ...h.ports, files: { ...h.ports.files, createWritable: async () => { entered.resolve(undefined); await gate.promise; return { write: async () => { h.log.push("write"); }, close: async () => { h.log.push("close"); } }; } } });
  const pending = h.owner.writeBackToFile(h.job);
  await entered.promise;
  stop();
  gate.resolve(undefined);
  assert.equal((await pending).kind, "refused");
  assert.deepEqual(h.log, ["build:txt:draft", "check"]);
});

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

test("an import whose permission was withdrawn saves a copy to the downloads instead and stops writing in place", async () => {
  const h = harness();
  const stop = h.owner.startImportSaving({
    ...h.ports,
    files: { ...h.ports.files, checkConflict: async () => { h.log.push("check"); return { ok: false, current: null, denied: true }; } }
  });
  assert.deepEqual(await h.owner.writeBackToFile(h.job), { kind: "saved" });
  assert.deepEqual(h.log, ["build:txt:draft", "check", "deliver"]);
  assert.equal(h.imported["inPlace"], false);
  stop();
});
test("a writeback whose re-read fails keeps the writer's stamp so the next save is not refused", async () => {
  const h = harness();
  let disk = 40;
  const stop = h.owner.startImportSaving({
    ...h.ports,
    files: {
      ...h.ports.files,
      checkConflict: async (_handle, lastModified) => (lastModified && lastModified !== disk ? { ok: false, current: { lastModified: disk } } : { ok: true }),
      createWritable: async () => ({ write: async () => {}, close: async () => { disk = 70; return { lastModified: 70 }; } }),
      read: async () => { throw new Error("read failed"); }
    }
  });
  h.ports.location.amendHome(h.imported, { lastModified: 40, size: 9 });
  assert.deepEqual(await h.owner.writeBackToFile(h.job), { kind: "saved" });
  assert.equal(h.imported["lastModified"], 70);
  assert.equal(h.imported["size"], null);
  assert.deepEqual(await h.owner.writeBackToFile(h.job), { kind: "saved" });
  stop();
});

test("a desktop-style close() that answers a stamp records that stamp and does not read the file again", async () => {
  const h = harness();
  const stop = h.owner.startImportSaving({
    ...h.ports,
    files: { ...h.ports.files, createWritable: async () => ({ write: async () => { h.log.push("write"); }, close: async () => { h.log.push("close"); return { lastModified: 70 }; } }) }
  });
  h.ports.location.amendHome(h.imported, { lastModified: 40, size: 9 });
  assert.deepEqual(await h.owner.writeBackToFile(h.job), { kind: "saved" });
  assert.deepEqual(h.log, ["build:txt:draft", "check", "write", "close"]);
  assert.equal(h.imported["lastModified"], 70);
  assert.equal(h.imported["size"], null);
  stop();
});

test("a close() whose answer has no usable stamp reads the file once, as the browser path does", async () => {
  for (const answer of [undefined, null, {}, { lastModified: Number.NaN }, { lastModified: "70" }]) {
    const h = harness();
    const stop = h.owner.startImportSaving({
      ...h.ports,
      files: { ...h.ports.files, createWritable: async () => ({ write: async () => {}, close: async () => { h.log.push("close"); return answer; } }) }
    });
    assert.deepEqual(await h.owner.writeBackToFile(h.job), { kind: "saved" });
    assert.deepEqual(h.log.slice(-2), ["close", "readAfter"], JSON.stringify(answer));
    assert.equal(h.imported["lastModified"], 50);
    assert.equal(h.imported["size"], 100);
    stop();
  }
});

test("a file another program changes after close() stamped the write is refused as a conflict on the next save-back", async () => {
  const h = harness();
  let disk = 40;
  const stop = h.owner.startImportSaving({
    ...h.ports,
    files: {
      checkConflict: async (_handle, lastModified) => (lastModified && lastModified !== disk ? { ok: false, current: { lastModified: disk } } : { ok: true }),
      createWritable: async () => ({ write: async () => {}, close: async () => { disk = 99; return { lastModified: 70 }; } }),
      read: async () => ({ name: "draft.txt", lastModified: disk, size: 100, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) })
    }
  });
  h.ports.location.amendHome(h.imported, { lastModified: 40, size: 9 });
  assert.deepEqual(await h.owner.writeBackToFile(h.job), { kind: "saved" });
  assert.equal(h.imported["lastModified"], 70);
  const next = await h.owner.writeBackToFile(h.job);
  assert.equal(next.kind, "refused");
  assert.deepEqual("conflict" in next ? next.conflict : null, { fileName: "draft.txt", current: { lastModified: 99 }, kind: "import" });
  stop();
});

test("a writeback whose re-read fails without a stamp clears the old one so the next save is not refused", async () => {
  const h = harness();
  let disk = 40;
  const stop = h.owner.startImportSaving({
    ...h.ports,
    files: {
      ...h.ports.files,
      checkConflict: async (_handle, lastModified) => (lastModified && lastModified !== disk ? { ok: false, current: { lastModified: disk } } : { ok: true }),
      createWritable: async () => ({ write: async () => {}, close: async () => { disk = 70; } }),
      read: async () => { throw new Error("read failed"); }
    }
  });
  h.ports.location.amendHome(h.imported, { lastModified: 40, size: 9 });
  assert.deepEqual(await h.owner.writeBackToFile(h.job), { kind: "saved" });
  assert.equal(h.imported["lastModified"], null);
  assert.deepEqual(await h.owner.writeBackToFile(h.job), { kind: "saved" });
  stop();
});
