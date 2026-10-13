import { test } from "node:test";
import assert from "node:assert/strict";
import { createDraftWriter } from "../../src/application/recovery/draft-writer.ts";
import type { DraftMeta, DraftPutResult, DraftWrite, KeyedDraftStore, StoredDraft } from "../../src/application/recovery/ports.ts";
import type { OperationContext } from "../../src/application/session/operation.ts";

interface Held {
  readonly rec: DraftWrite;
  readonly release: () => void;
}

function memoryStore() {
  const records = new Map<string, StoredDraft>();
  const held: Held[] = [];
  let holding = false;
  const log: string[] = [];
  function stored(rec: DraftWrite): StoredDraft {
    return {
      key: rec.key, base: rec.base || "", docId: rec.docId || "", rev: rec.rev || 0, title: rec.title || "",
      writtenAt: 0, writerId: rec.writerId || "", generation: rec.generation || 0, editSeq: rec.editSeq || 0,
      schema: rec.schema ?? null, docIdWrittenOut: !!rec.docIdWrittenOut, bytes: rec.stateJson.length,
      stateJson: rec.stateJson, baseJson: rec.baseJson ?? null
    };
  }
  const store: KeyedDraftStore = {
    available: function () { return Promise.resolve(true); },
    put: function (rec: DraftWrite): Promise<DraftPutResult> {
      const land = function (): DraftPutResult {
        records.set(rec.key, stored(rec));
        log.push("put " + rec.key + "#" + String(rec.generation));
        return { ok: true, evicted: 0 };
      };
      if (!holding) return Promise.resolve(land());
      return new Promise(function (resolve) { held.push({ rec: rec, release: function () { resolve(land()); } }); });
    },
    get: function (key: string) { return Promise.resolve(records.get(key) || null); },
    list: function (): Promise<DraftMeta[]> { return Promise.resolve(Array.from(records.values())); },
    remove: function (key: string, writerId?: string, generation?: number) {
      const r = records.get(key);
      if (!r || (writerId && r.writerId !== writerId) || (typeof generation === "number" && r.generation !== generation)) {
        log.push("kept " + key);
        return Promise.resolve(false);
      }
      records.delete(key);
      log.push("removed " + key);
      return Promise.resolve(true);
    },
    claim: function (key: string, writerId: string, generation?: number) {
      const r = records.get(key);
      if (!r) return Promise.resolve(false);
      records.set(key, Object.assign({}, r, { writerId: writerId, generation: generation ?? r.generation }));
      log.push("claimed " + key);
      return Promise.resolve(true);
    }
  };
  return {
    store: store,
    records: records,
    log: log,
    hold: function () { holding = true; },
    releaseAll: function () { holding = false; held.splice(0).forEach(function (h) { h.release(); }); }
  };
}

function ownership() {
  const state = { epoch: 1 };
  return {
    state: state,
    port: {
      capture: function (): OperationContext {
        return Object.freeze({ epoch: state.epoch, docId: null, destination: null, destinationGeneration: 0, generation: 0, connection: null, revision: null });
      },
      stillOwns: function (ctx: OperationContext) { return ctx.epoch === state.epoch; }
    }
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fields(text: string) {
  return { stateJson: JSON.stringify({ text: text }), baseJson: "{}" };
}

test("a writer is built with its store, its id and its ownership port, and refuses to run without an id", () => {
  const mem = memoryStore();
  assert.throws(() => createDraftWriter({ store: mem.store, writerId: "", ownership: ownership().port }), /needs its id/);
  const writer = createDraftWriter({ store: mem.store, writerId: "w1", ownership: ownership().port });
  assert.equal(writer.writerId(), "w1");
  assert.equal(writer.tracked(), null);
  assert.ok(Object.isFrozen(writer));
});

test("a write it owns is acknowledged: the writer tracks its key, stamps its id and generation, and drops its own previous key", async () => {
  const mem = memoryStore();
  const writer = createDraftWriter({ store: mem.store, writerId: "w1", ownership: ownership().port });
  const first = writer.capture("doc-a");
  assert.deepEqual(await writer.write(first, fields("one")), { ok: true, evicted: 0, obsolete: false });
  assert.equal(writer.tracked(), "doc-a");
  assert.equal(mem.records.get("doc-a")?.writerId, "w1");
  assert.equal(mem.records.get("doc-a")?.generation, first.generation);
  const second = writer.capture("doc-b");
  assert.equal(second.before, "doc-a", "the capture records the key tracked when it was taken");
  await writer.write(second, fields("two"));
  await flush();
  assert.equal(writer.tracked(), "doc-b");
  assert.equal(mem.records.has("doc-a"), false, "the writer's own earlier key was removed");
});

test("B1: a late write for the previous document neither removes the key tracked since nor claims it", async () => {
  const mem = memoryStore();
  const writer = createDraftWriter({ store: mem.store, writerId: "w1", ownership: ownership().port });
  await mem.store.put({ key: "doc-b", writerId: "another-tab", generation: 1, stateJson: "{}" });
  mem.hold();
  const landing = writer.write(writer.capture("doc-a"), fields("A's work"));
  await flush();
  await writer.take("doc-b");
  mem.releaseAll();
  assert.deepEqual(await landing, { ok: true, evicted: 0, obsolete: true }, "the tracked key moved to another document after the capture");
  await flush();
  assert.equal(writer.tracked(), "doc-b", "the late write did not claim the writer's key");
  assert.equal(mem.records.has("doc-b"), true, "nor removed the current document's draft");
  assert.equal(mem.records.has("doc-a"), true, "its own record is kept: it is the previous document's work");
});

test("a write whose own key was taken by this writer since its capture is still acknowledged", async () => {
  const mem = memoryStore();
  const writer = createDraftWriter({ store: mem.store, writerId: "w1", ownership: ownership().port });
  await mem.store.put({ key: "doc-a", writerId: "dead-tab", generation: 1, stateJson: "{}" });
  mem.hold();
  const captured = writer.capture("doc-a");
  assert.equal(captured.before, null);
  const landing = writer.write(captured, fields("A, newer"));
  await flush();
  await writer.take("doc-a");
  mem.releaseAll();
  assert.deepEqual(await landing, { ok: true, evicted: 0, obsolete: false }, "the tracked key is the write's own, so it is not obsolete");
  assert.equal(writer.tracked(), "doc-a");
  assert.equal(await writer.discard(), true, "the acknowledged generation is the write's, so a discard removes it");
});

test("a write whose operation no longer owns the document is obsolete even when no other key was tracked since", async () => {
  const own = ownership();
  const mem = memoryStore();
  const writer = createDraftWriter({ store: mem.store, writerId: "w1", ownership: own.port });
  await writer.write(writer.capture("doc-a"), fields("one"));
  const late = writer.capture("doc-a");
  own.state.epoch++;
  assert.deepEqual(await writer.write(late, fields("from the replaced session")), { ok: true, evicted: 0, obsolete: true });
  assert.equal(writer.tracked(), "doc-a", "the earlier acknowledgement stands");
  const next = writer.capture("doc-b");
  await writer.write(next, fields("the new session"));
  await flush();
  assert.equal(writer.tracked(), "doc-b");
});

test("a failed write acknowledges nothing", async () => {
  const mem = memoryStore();
  const failing: KeyedDraftStore = { ...mem.store, put: () => Promise.resolve({ ok: false, code: "QUOTA" }) };
  const writer = createDraftWriter({ store: failing, writerId: "w1", ownership: ownership().port });
  assert.deepEqual(await writer.write(writer.capture("doc-a"), fields("x")), { ok: false, code: "QUOTA" });
  assert.equal(writer.tracked(), null);
});

test("B7: discard removes only the generation acknowledged to this writer", async () => {
  const mem = memoryStore();
  const writer = createDraftWriter({ store: mem.store, writerId: "w1", ownership: ownership().port });
  const mine = writer.capture("doc-a");
  await writer.write(mine, fields("mine"));
  const written = mem.records.get("doc-a");
  assert.ok(written);
  mem.records.set("doc-a", { ...written, generation: mine.generation + 10 });
  assert.equal(await writer.discard(), false, "a newer generation under the same writer id is not this writer's to discard");
  assert.equal(mem.records.has("doc-a"), true);
  assert.equal(writer.tracked(), null);
  assert.equal(await writer.discard(), false, "nothing is tracked after a discard");

  const again = writer.capture("doc-a");
  await writer.write(again, fields("mine again"));
  assert.equal(await writer.discard(), true);
  assert.equal(mem.records.has("doc-a"), false);
});

test("take claims a restored draft for this writer, drops the key it tracked before, and a later discard removes it", async () => {
  const mem = memoryStore();
  const writer = createDraftWriter({ store: mem.store, writerId: "w1", ownership: ownership().port });
  await writer.write(writer.capture("doc-a"), fields("mine"));
  await mem.store.put({ key: "doc-r", writerId: "dead-tab", generation: 3, stateJson: "{}" });
  assert.equal(await writer.take("doc-r"), true);
  await flush();
  assert.equal(writer.tracked(), "doc-r");
  assert.equal(mem.records.has("doc-a"), false, "the key it tracked before was its own and is removed");
  assert.equal(mem.records.get("doc-r")?.writerId, "w1");
  assert.equal(await writer.discard(), true);
  assert.equal(mem.records.has("doc-r"), false);
});
