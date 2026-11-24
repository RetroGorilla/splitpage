import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { createBrowserNativeLocalStore } from "../../../../src/adapters/collab/native/browser-local-store.ts";
import type { NativeLocalStore } from "../../../../src/adapters/collab/native/local-store.ts";
import {
  NATIVE_PENDING_EDITS_SCHEMA_VERSION,
  decodeNativePendingEdits,
  encodeNativePendingEdits
} from "../../../../src/adapters/collab/native/pending-edits.ts";
import { applyNativePeerUpdate } from "../../../../src/adapters/collab/native/peer-update.ts";
import { desktopFixture, desktopTestCipher, replicasAt } from "./desktop-local-store-fixture.ts";
import { eventResult, failNextIdbWrite, idbDone, idbResult } from "./indexeddb-fixture.ts";
import { DB_NAME, REPLICAS, STORE_OPTIONS, fixture, seedReplica, seedSession, stored, typeAt } from "./local-store-fixture.ts";

globalThis.IDBKeyRange = IDBKeyRange;

const JOURNAL_OPTIONS = { ...STORE_OPTIONS, noticeJournal: true as const };
const JOURNALS = "journals";

interface BackendHarness {
  readonly open: (name: string) => ReturnType<NativeLocalStore["open"]>;
  readonly delete: (name: string) => ReturnType<NativeLocalStore["delete"]>;
  readonly restart: () => NativeLocalStore;
  readonly failNextAppend: (reason?: "quota") => void;
  readonly writeRawJournal: (name: string, bytes: Uint8Array) => Promise<void>;
  readonly hasStoredJournal: (name: string) => Promise<boolean>;
}

async function createBackend(t: TestContext, kind: "browser" | "desktop"): Promise<BackendHarness> {
  if (kind === "browser") {
    const { factory, store } = fixture();
    return {
      open: name => store.open(name, JOURNAL_OPTIONS),
      delete: name => store.delete(name),
      restart: () => createBrowserNativeLocalStore({ indexedDB: factory, locks: navigator.locks }),
      failNextAppend: reason => failNextIdbWrite(t, "add", reason === "quota" ? "quota" : "abort"),
      async writeRawJournal(name, bytes) {
        const db = await idbResult(factory.open(DB_NAME));
        try {
          const tx = db.transaction(JOURNALS, "readwrite");
          tx.objectStore(JOURNALS).put(bytes, name);
          assert.equal(await idbDone(tx), "complete");
        } finally { db.close(); }
      },
      async hasStoredJournal(name) {
        const db = await idbResult(factory.open(DB_NAME));
        try {
          const value: unknown = await idbResult(db.transaction(JOURNALS).objectStore(JOURNALS).get(name));
          return value !== undefined;
        } finally { db.close(); }
      }
    };
  }
  const desktop = await desktopFixture(t, false);
  const cipher = desktopTestCipher(randomBytes(32));
  const root = replicasAt(desktop.directory, undefined, cipher);
  const win = root.window();
  return {
    open: name => desktop.store.open(name, JOURNAL_OPTIONS),
    delete: name => desktop.store.delete(name),
    restart: () => desktop.restart().store,
    failNextAppend: reason => desktop.failAppend(reason),
    async writeRawJournal(name, bytes) {
      const opened = await win.invoke(["open", name]);
      assert.equal(opened.kind, "opened");
      try {
        assert.deepEqual(await win.invoke(["write-journal", name, opened.lease, bytes]), { kind: "stored" });
      } finally {
        await win.invoke(["close", name, opened.lease]);
      }
    },
    async hasStoredJournal(name) {
      const opened = await win.invoke(["open", name]);
      assert.equal(opened.kind, "opened");
      try {
        const reply = await win.invoke(["read-journal", name, opened.lease]);
        return reply.kind === "journal" && reply.bytes !== null;
      } finally {
        await win.invoke(["close", name, opened.lease]);
      }
    }
  };
}

test("pending edits journal codec writes versioned bytes and rejects unsupported versions or corrupt payloads", () => {
  const sample = { through: 2, entries: [] } as const;
  const encoded = encodeNativePendingEdits(sample);
  const parsed = JSON.parse(new TextDecoder().decode(encoded)) as { version: number; data: unknown };
  assert.equal(parsed.version, NATIVE_PENDING_EDITS_SCHEMA_VERSION);
  assert.deepEqual(parsed.data, sample);
  assert.deepEqual(decodeNativePendingEdits(encoded), sample);

  const future = new TextEncoder().encode(JSON.stringify({ version: NATIVE_PENDING_EDITS_SCHEMA_VERSION + 1, data: sample }));
  assert.throws(() => decodeNativePendingEdits(future), { name: "VersionError" });

  for (const invalid of [
    new Uint8Array(0),
    new TextEncoder().encode("not json"),
    new TextEncoder().encode(JSON.stringify({ version: 0, data: sample })),
    new TextEncoder().encode(JSON.stringify({ version: 1, data: { through: -1, entries: [] } })),
    new TextEncoder().encode(JSON.stringify({ version: 1, data: { through: 0, entries: [{ id: 123, first: 1, last: 1, peer: false }] } })),
    new TextEncoder().encode(JSON.stringify({ version: 1, data: { through: 0, entries: [], orders: "bad" } })),
    new TextEncoder().encode(JSON.stringify({ version: 1, data: { through: 0, entries: [], checkpoint: { through: -1, beats: [] } } }))
  ]) {
    assert.throws(() => decodeNativePendingEdits(invalid), TypeError);
  }
});

for (const oldVersion of [1, 2] as const) {
  test(`browser store upgrades pre-journal v${oldVersion} database without losing replica data`, async () => {
    const factory = new IDBFactory();
    const name = `deployment/pre-journal-v${oldVersion}`;
    const source = seedSession({ A: "existing narration", B: "second beat" });
    const bytes = source.encodeState();
    source.close();

    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DB_NAME, oldVersion);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(REPLICAS, { keyPath: ["name", "generation"] });
        if (oldVersion >= 2) {
          request.result.createObjectStore("memberships");
          request.result.createObjectStore("invitations");
        }
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      const stores = oldVersion >= 2 ? [REPLICAS, "memberships", "invitations"] : [REPLICAS];
      const tx = legacy.transaction(stores, "readwrite");
      tx.objectStore(REPLICAS).add({ name, generation: 1, checkpoint: true, bytes });
      if (oldVersion >= 2) {
        tx.objectStore("memberships").put(true, name);
        tx.objectStore("invitations").put("legacy-token", name);
      }
      assert.equal(await idbDone(tx), "complete");
    } finally { legacy.close(); }

    const store = createBrowserNativeLocalStore({ indexedDB: factory, locks: navigator.locks });
    const opened = await store.open(name, JOURNAL_OPTIONS);
    assert.equal(opened.kind, "opened");
    assert.equal(opened.restored, true);
    assert.equal(opened.session.document().rows[0]?.audioText, "existing narration");
    assert.equal(opened.session.document().rows[1]?.audioText, "second beat");
    if (oldVersion >= 2) assert.equal(await opened.membership?.token(), "legacy-token");
    assert.deepEqual(opened.session.pendingEdits?.data(), { through: 0, entries: [] });

    typeAt(opened.session, 0, "updated ", "B");
    assert.deepEqual(await opened.flush(), stored(2));
    const expectedJournal = opened.session.pendingEdits?.data();
    opened.session.close();
    await opened.closed;

    const reopened = await store.open(name, JOURNAL_OPTIONS);
    assert.equal(reopened.kind, "opened");
    try {
      assert.equal(reopened.session.document().rows[1]?.audioText, "updated second beat");
      assert.deepEqual(reopened.session.pendingEdits?.data(), expectedJournal);
    } finally { reopened.session.close(); await reopened.closed; }
  });
}

test("desktop store reads pre-journal v1 records without data loss and persists later journal updates", async t => {
  const { first, restart } = await desktopFixture(t);
  const name = "deployment/pre-journal-desktop";
  const source = seedSession({ A: "existing desktop", B: "second beat" });
  const initialBytes = source.encodeState();
  source.close();

  const leaseReply = await first.invoke(["open", name]);
  assert.equal(leaseReply.kind, "opened");
  assert.deepEqual(await first.invoke(["write", name, leaseReply.lease, 1, true, initialBytes]), { kind: "stored" });
  assert.deepEqual(await first.invoke(["close", name, leaseReply.lease]), { kind: "stored" });

  const opened = await restart().store.open(name, JOURNAL_OPTIONS);
  assert.equal(opened.kind, "opened");
  assert.equal(opened.restored, true);
  assert.equal(opened.session.document().rows[0]?.audioText, "existing desktop");
  assert.deepEqual(opened.session.pendingEdits?.data(), { through: 0, entries: [] });

  typeAt(opened.session, 0, "offline ", "B");
  assert.deepEqual(await opened.flush(), stored(2));
  const expectedJournal = opened.session.pendingEdits?.data();
  opened.session.close();
  await opened.closed;

  const reopened = await restart().store.open(name, JOURNAL_OPTIONS);
  assert.equal(reopened.kind, "opened");
  try {
    assert.equal(reopened.session.document().rows[1]?.audioText, "offline second beat");
    assert.deepEqual(reopened.session.pendingEdits?.data(), expectedJournal);
  } finally { reopened.session.close(); await reopened.closed; }
});

for (const kind of ["browser", "desktop"] as const) {
  test(`${kind}: journal survives restart, clearThrough, session replacement, and compaction, and deletes with copy`,
    { timeout: 30_000 }, async t => {
      const backend = await createBackend(t, kind);
      const name = `deployment/journal-${kind}`;
      const replica = await backend.open(name);
      assert.equal(replica.kind, "opened");
      seedReplica(replica.session, { A: "alpha", B: "beta" });
      assert.deepEqual(await replica.flush(), stored(1));

      typeAt(replica.session, 0, "one ", "A");
      assert.deepEqual(await replica.flush(), stored(2));
      const afterEdit = replica.session.pendingEdits?.data();
      assert.equal(afterEdit?.through, 1);
      assert.deepEqual(afterEdit?.entries.map(entry => entry.id), ["A"]);
      replica.session.close();
      await replica.closed;

      const restarted = await backend.restart().open(name, JOURNAL_OPTIONS);
      assert.equal(restarted.kind, "opened");
      assert.deepEqual(restarted.session.pendingEdits?.data(), afterEdit);

      const original = restarted.session;
      const handover = eventResult<ReturnType<typeof restarted.reopen>>();
      original.subscribe(change => {
        if (change.kind === "closed" && change.reason === "failed") handover.resolve(restarted.reopen(original));
      });
      const fault = new Error("interrupted journal edit");
      original.ydoc.once("afterTransactionCleanup", () => { throw fault; });
      assert.throws(() => typeAt(original, 0, "two ", "B"), fault);
      const replaced = await handover.promise;
      const afterReplace = replaced.pendingEdits?.data();
      assert.equal(afterReplace?.through, 2);
      assert.deepEqual(afterReplace?.entries.map(entry => entry.id), ["A", "B"]);
      assert.equal(replaced.document().rows[1]?.audioText, "two beta");

      replaced.close();
      await restarted.closed;
      const postReplaceRestart = await backend.restart().open(name, JOURNAL_OPTIONS);
      assert.equal(postReplaceRestart.kind, "opened");
      assert.deepEqual(postReplaceRestart.session.pendingEdits?.data(), afterReplace);

      const point = postReplaceRestart.session.pendingEdits?.confirmationPoint();
      assert.equal(point, 2);
      postReplaceRestart.session.pendingEdits?.clearThrough(point);
      assert.deepEqual(postReplaceRestart.session.pendingEdits?.data(), { through: 2, entries: [] });
      assert.equal((await postReplaceRestart.flush()).kind, "stored");
      postReplaceRestart.session.close();
      await postReplaceRestart.closed;

      const afterClearRestart = await backend.restart().open(name, JOURNAL_OPTIONS);
      assert.equal(afterClearRestart.kind, "opened");
      assert.deepEqual(afterClearRestart.session.pendingEdits?.data(), { through: 2, entries: [] });

      typeAt(afterClearRestart.session, 0, "kept ", "A");
      assert.equal((await afterClearRestart.flush()).kind, "stored");
      const beforeCompact = afterClearRestart.session.pendingEdits?.data();
      const text = afterClearRestart.session.ydoc.getText("filler");
      for (let index = 0; index < 515; index++) text.insert(index, "x");
      assert.equal((await afterClearRestart.flush()).kind, "stored");
      const compactTrigger = afterClearRestart.session.pendingEdits;
      assert.ok(compactTrigger);
      await new Promise(resolve => setTimeout(resolve, 25));
      afterClearRestart.session.close();
      await afterClearRestart.closed;

      const afterCompactRestart = await backend.restart().open(name, JOURNAL_OPTIONS);
      assert.equal(afterCompactRestart.kind, "opened");
      assert.deepEqual(afterCompactRestart.session.pendingEdits?.data(), beforeCompact);

      const peer = seedSession({ A: "alpha", B: "beta" });
      t.after(() => peer.close());
      assert.equal(peer.commands.removeRows(["A"]).kind, "written");
      assert.equal(applyNativePeerUpdate(afterCompactRestart.session, peer.encodeState()), true);
      assert.equal((await afterCompactRestart.flush()).kind, "stored");
      const clashBeforeRestart = afterCompactRestart.session.offlineNotice("returning");
      assert.equal(clashBeforeRestart.length, 1);
      assert.equal(clashBeforeRestart[0]?.id, "A");
      assert.equal(clashBeforeRestart[0]?.possibleRemoval, true);
      afterCompactRestart.session.close();
      await afterCompactRestart.closed;

      const afterPeerRestart = await backend.restart().open(name, JOURNAL_OPTIONS);
      assert.equal(afterPeerRestart.kind, "opened");
      assert.deepEqual(afterPeerRestart.session.offlineNotice("returning"), clashBeforeRestart);
      afterPeerRestart.session.close();
      await afterPeerRestart.closed;

      assert.deepEqual(await backend.delete(name), { kind: "stored" });
      assert.equal(await backend.hasStoredJournal(name), false);
    });

  test(`${kind}: a failed append keeps the prior journal and replica in sync, and unsupported journal version refuses open`,
    async t => {
      const backend = await createBackend(t, kind);
      const name = `deployment/fault-${kind}`;
      const replica = await backend.open(name);
      assert.equal(replica.kind, "opened");
      seedReplica(replica.session, { A: "start" });
      assert.deepEqual(await replica.flush(), stored(1));
      typeAt(replica.session, 0, "first ", "A");
      assert.deepEqual(await replica.flush(), stored(2));
      const committedJournal = replica.session.pendingEdits?.data();

      backend.failNextAppend("quota");
      typeAt(replica.session, 0, "second ", "A");
      const failed = await replica.flush();
      assert.equal(failed.kind, "failed");
      assert.equal(failed.reason, "quota");
      assert.equal(failed.committed, 2);

      const reopenedStore = backend.restart();
      replica.session.close();
      const closed = await replica.closed;
      assert.equal(closed.kind, "stored");

      const afterRetry = await reopenedStore.open(name, JOURNAL_OPTIONS);
      assert.equal(afterRetry.kind, "opened");
      assert.equal(afterRetry.session.document().rows[0]?.audioText, "second first start");
      assert.notDeepEqual(afterRetry.session.pendingEdits?.data(), committedJournal);
      afterRetry.session.close();
      await afterRetry.closed;

      const futureBytes = new TextEncoder().encode(JSON.stringify({
        version: NATIVE_PENDING_EDITS_SCHEMA_VERSION + 1, data: { through: 0, entries: [] }
      }));
      await backend.writeRawJournal(name, futureBytes);
      const unsupported = await backend.restart().open(name, JOURNAL_OPTIONS);
      assert.equal(unsupported.kind, "failed");
      assert.equal(unsupported.reason, "version");

      await backend.writeRawJournal(name, new TextEncoder().encode("{not-valid"));
      const corrupt = await backend.restart().open(name, JOURNAL_OPTIONS);
      assert.equal(corrupt.kind, "failed");
      assert.equal(corrupt.reason, "io");
    });
}
