import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionMergeOwner } from "../../src/application/session/session-merge.ts";
import type { SessionMergeOwner, SessionMergeOwnerPorts } from "../../src/application/session/session-merge-ports.ts";
import type { HistorySnapshotRead, HistoryWriteResult } from "../../src/application/recovery/history-ports.ts";
import { migrateRows } from "../../src/core/migrate.ts";
import { fakeMigration } from "../core/migrate-ports.ts";
import type { OperationContext } from "../../src/application/session/operation.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const log: string[] = [];
  const migration = fakeMigration().ports;
  let document = migrateRows({ title: "Live", docId: "d-live", rows: [{ id: "r1", audioText: "live" }] }, migration);
  let owned = true;
  let changes = 0;
  let writes = 0;
  let stored = true;
  const snapshot: HistorySnapshotRead = {
    meta: { id: "s1", at: "2026-01-01T00:00:00.000Z", label: "Earlier", atMs: 1767225600000, kind: "snapshot", formatVersion: 1, rows: 1, title: "Earlier", by: "Ann", sizeBytes: 1 },
    stateJson: JSON.stringify({ title: "Earlier", rows: [{ id: "r1", audioText: "earlier" }] })
  };
  let reading: Promise<HistorySnapshotRead | null> = Promise.resolve(snapshot);
  let backup: (() => Promise<HistoryWriteResult>) | null = null;
  const ctx: OperationContext = { epoch: 1, generation: 0, docId: "d-live", destination: null, destinationGeneration: 0 };
  const ports: SessionMergeOwnerPorts = {
    document: { current: () => document },
    session: {
      held: () => document,
      holdMergeBase: () => { log.push("hold"); },
      noteMerged: (_kind, next) => { log.push("merged"); return next; },
      noteRecovery: () => { log.push("recovery"); return document; },
      noteDiskUpdate: () => { log.push("disk"); return document; },
      noteAbsorbedDirty: () => { log.push("dirty"); }
    },
    entry: { migrate: (raw) => migrateRows(raw, migration), withPorts: (_fields, run) => run(migration) },
    text: { fromHtml: () => [] },
    ids: migration.ids,
    clock: { nowIso: () => "2026-01-01T00:00:00.000Z" },
    preferences: { editorName: () => "Ann" },
    history: {
      captureSnapshot: (label, doc, options) => {
        assert.equal(label, "Before restoring an earlier version");
        assert.equal(doc, document);
        assert.deepEqual(options, { allowSeedSkip: false });
        log.push("backup");
        writes++;
        return { id: "backup", docId: document.docId, done: backup ? backup() : Promise.resolve({ stored }) };
      },
      getHistorySnapshot: (query) => { assert.equal(query.id, "s1"); log.push("read"); return reading; },
      protectHistorySnapshot: (query) => { assert.equal(query.id, "s1"); log.push("protect"); return () => { log.push("release"); }; }
    },
    identity: {
      adoptRestoredState: (raw) => { log.push("adopt"); document = migrateRows(raw, migration); return document; },
      noteMergedDocId: () => { log.push("historyFrom"); }
    },
    recovery: { capture: () => ctx, stillOwns: () => owned },
    saving: { changes: () => changes, confirmBaseline: (next) => { log.push("confirm"); return next; } },
    autoSave: { dueNow: () => { log.push("save"); } },
    location: { setHome: (kind, fields) => ({ kind: kind as "none", ...fields }) },
    undo: { arm: () => { log.push("undo"); } },
    production: { reset: () => { log.push("reset"); } },
    onRestored: () => { log.push("restored"); }
  };
  const owner: SessionMergeOwner = createSessionMergeOwner();
  return {
    owner, ports, log, start: () => owner.startSessionMerge(ports),
    document: () => document, writes: () => writes,
    move: () => { owned = false; }, failBackup: () => { stored = false; },
    changeDuringBackup: () => { backup = () => { changes++; return Promise.resolve({ stored: true }); }; },
    holdRead: () => { const pending = deferred<HistorySnapshotRead | null>(); reading = pending.promise; return () => { pending.resolve(snapshot); }; },
    holdBackup: () => { const pending = deferred<HistoryWriteResult>(); backup = () => pending.promise; return () => { pending.resolve({ stored: true }); }; }
  };
}

test("session merge refuses before start and after teardown, including captured merge ports", () => {
  const f = setup();
  assert.throws(() => f.owner.sessionMergePorts(), /not started/);
  assert.throws(() => f.owner.stampRow({}), /not started/);
  assert.throws(() => f.owner.documentDestinationPort.set({ kind: "none" }), /not started/);
  const stop = f.start();
  assert.throws(() => f.start(), /already started/);
  const merge = f.owner.sessionMergePorts();
  const row: Record<string, unknown> = {};
  f.owner.stampRow(row);
  assert.deepEqual(row, { updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "Ann" });
  stop();
  assert.throws(() => f.owner.baseStateReason(), /not started/);
  assert.throws(() => f.owner.documentHistoryPort.keep("backup"), /not started/);
  assert.throws(() => merge.current(), /not started/);
});

test("the merge base confirms before holding it and retains the caller's reason", () => {
  const f = setup();
  const stop = f.start();
  const doc = f.document();
  assert.equal(f.owner.setBaseState(doc, "server"), doc);
  assert.equal(f.owner.baseStateReason(), "server");
  assert.deepEqual(f.log, ["confirm", "hold"]);
  stop();
});

test("history restore waits for its backup and keeps replacement, effects and autosave in order", async () => {
  const f = setup();
  const release = f.holdBackup();
  const stop = f.start();
  const restore = f.owner.restoreMergeSnapshot("s1");
  await Promise.resolve();
  assert.equal(f.document().title, "Live");
  assert.deepEqual(f.log, ["protect", "read", "backup"]);
  assert.equal(await f.owner.restoreMergeSnapshot("s1"), "busy");
  release();
  assert.equal(await restore, "restored");
  assert.equal(f.document().title, "Earlier");
  assert.deepEqual(f.log, ["protect", "read", "backup", "reset", "adopt", "dirty", "restored", "save", "release"]);
  stop();
});

test("a refused backup preserves the live document; a forced local restore does not autosave", async () => {
  const f = setup();
  f.failBackup();
  const stop = f.start();
  assert.equal(await f.owner.restoreMergeSnapshot("s1"), "no-backup");
  assert.equal(f.document().title, "Live");
  assert.equal(await f.owner.restoreMergeSnapshot("s1", { force: true, local: true }), "restored");
  assert.equal(f.document().title, "Earlier");
  assert.equal(f.log.includes("save"), false);
  stop();
});

test("edits during backup require three retries and preserve the live document if it never settles", async () => {
  const f = setup();
  f.changeDuringBackup();
  const stop = f.start();
  assert.equal(await f.owner.restoreMergeSnapshot("s1"), "no-backup");
  assert.equal(f.writes(), 3);
  assert.equal(f.document().title, "Live");
  stop();
});

for (const phase of ["read", "backup"] as const) {
  for (const teardown of [false, true]) {
    test("restore refuses a stale continuation after " + phase + (teardown ? " on teardown" : " on replacement"), async () => {
      const f = setup();
      const release = phase === "read" ? f.holdRead() : f.holdBackup();
      const stop = f.start();
      const restore = f.owner.restoreMergeSnapshot("s1");
      await Promise.resolve();
      if (teardown) stop();
      else f.move();
      release();
      assert.equal(await restore, "changed");
      assert.equal(f.document().title, "Live");
      assert.equal(f.log.includes("adopt"), false);
      assert.equal(f.log.at(-1), "release");
      stop();
    });
  }
}
