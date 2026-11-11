import test, { mock } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { createMonitoredSharedDocument, deliveryReplica, validatedFixture } from "./helpers.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState, encodeSharedStateVector, observeSharedTransactions, readSharedRevision, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import type { SharedPreparationView } from "../../../src/adapters/collab/prepare.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { readSharedMarkCharacters } from "../../../src/adapters/collab/mark-store.ts";
import { readSharedTextTarget } from "../../../src/adapters/collab/text-target.ts";
import { sharedMarkRecordKey } from "../../../src/adapters/collab/mark-record.ts";
import { operation } from "./executor-support.ts";
import { installTextSeamProbe } from "./text-seam-support.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import { DeliveryQueue, deliveryOrders } from "../../collab/delivery.ts";

function present<T>(value: T | null | undefined): T { assert.ok(value !== null && value !== undefined); return value; }

function fixture(client?: number) {
  const handle = createMonitoredSharedDocument();
  if (client !== undefined) collabState(handle).doc.clientID = client;
  hydrateSharedDocument(handle, validatedFixture({ title: "Title", sections: [{ id: "H1", name: "Heading", firstSceneId: "R1" }],
    rows: [{ id: "R1", audioText: "<i>abcd</i>", visualText: '<b>A<span class="who-anchor" data-who="Ada">@Ada</span></b>' }] }));
  return handle;
}
function insertion(id: string, index: number, text = "X") {
  return operation({ kind: "text-insert", id, by: "Writer", target: { owner: "R1", segment: "b:R1", field: "audioText" },
    at: { left: null, right: String(index), affinity: "before" }, content: [{ value: text, marks: [{ kind: "b", value: true }] }] });
}

test("text facades are frozen plain data for all targets and distinguish live anchors, collapsed gaps and gone", () => {
  const handle = fixture(), other = fixture();
  try {
    const prep = createSharedPreparation(handle), text = prep.view.text(["segments", "b:R1", "text"]); assert.ok(text);
    assert.equal(prep.view.text(["segments", "b:R1", "text"]), text);
    assert.equal(text.length, 4); assert.deepEqual(text.units.map(unit => unit.value), ["a", "b", "c", "d"]);
    assert.equal(text.records.length, 1); assert.equal(text.records[0]?.record.type, "add");
    assert.deepEqual([text.records[0]?.from, text.records[0]?.to], [0, 4]);
    assert.deepEqual(text.units[0]?.marks[0]?.values, [true]);
    const target = readSharedTextTarget({ owner: "R1", segment: "b:R1", field: "audioText" }); assert.ok(target);
    const anchor = createSharedAnchor(handle, target, 1, "after"); assert.ok(anchor);
    assert.deepEqual(text.resolveAnchor(anchor), { kind: "index", index: 1, affinity: "after" });
    assert.deepEqual(text.resolveAnchor(createSharedAnchor(handle, target, 1, "before")), { kind: "index", index: 1, affinity: "before" });
    assert.deepEqual(text.resolveAnchor(createSharedAnchor(other, target, 1, "after")), { kind: "gone" });
    assert.deepEqual(text.resolveAnchor("malformed"), { kind: "gone" });
    const visual = prep.view.text(["visuals", "R1", "text"]); assert.ok(visual);
    assert.deepEqual(visual.units.map(unit => unit.value), ["A", { w: "Ada" }]);
    assert.equal(prep.view.text(["meta", "title"])?.length, 5);
    assert.equal(prep.view.text(["segments", "h:H1", "text"])?.length, 7);
    assert.equal(prep.view.text(["segments", "missing", "text"]), null);
    assert.throws(() => { (text.units as unknown[]).push("bad"); }, TypeError);
    assert.throws(() => { Object.assign(present(text.units[0]).identity, { clock: 99 }); }, TypeError);
    assert.throws(() => { Object.assign(present(visual.units[1]).value as object, { w: "bad" }); }, TypeError);
    assert.throws(() => { Object.assign(present(text.records[0]), { from: 99 }); }, TypeError);
    assert.throws(() => { Object.assign(present(text.records[0]).record, { writer: 99 }); }, TypeError);
    assert.throws(() => { Object.assign(text.resolveAnchor, { raw: true }); }, TypeError);
    prep.close(); assert.throws(() => text.resolveAnchor(anchor), /Preparation has ended/);
    const native = (collabState(handle).roots.segments.get("b:R1") as Y.Map<unknown>).get("text") as Y.Text;
    transactSharedDocument(handle, "local-command", () => native.delete(1, 1));
    const next = createSharedPreparation(handle);
    assert.deepEqual(next.view.text(["segments", "b:R1", "text"])?.resolveAnchor(anchor), { kind: "gap", index: 1, affinity: "after" });
    next.close();
    transactSharedDocument(handle, "local-command", () => native.delete(0, native.length));
    const empty = createSharedPreparation(handle), retained = empty.view.text(["segments", "b:R1", "text"]); assert.ok(retained);
    assert.equal(retained.length, 0); assert.equal(retained.records.length, 1); assert.deepEqual([retained.records[0]?.from, retained.records[0]?.to], [0, 0]); empty.close();
  } finally { destroySharedDocument(handle); destroySharedDocument(other); }
});

test("text scratch advances earlier writes once per call; apply writes one live-client transaction and update", () => {
  const handle = fixture(), client = collabState(handle).doc.clientID, origins: unknown[] = [], updates: Uint8Array[] = [];
  let calls = 0, creations = 0, previous: SharedPreparationView | null = null;
  const detach = observeSharedTransactions(handle, origin => origins.push(origin)), stop = deliveryReplica(handle).onLocalUpdate(update => updates.push(update));
  try {
    const base = readSharedRevision(handle);
    installTextSeamProbe(handle, (view, text) => {
      if (calls === 1) assert.deepEqual(view.get(["segments", "b:R1", "text"]), [{ insert: "aXbcd" }]);
      if (calls === 2) assert.throws(() => present(previous).scratch("text:R1", () => null), /Preparation has ended/);
      assert.equal(view.base, calls < 2 ? base : null);
      assert.equal(view.scratch("probe", () => ({ creation: ++creations })).creation, calls < 2 ? 1 : 2);
      previous = view; calls++; assert.equal(text.units.length, calls < 3 ? 4 : 6);
    });
    assert.deepEqual(executeSharedOperations(handle, [insertion("one", 1), insertion("two", 2, "Y")], { base }), { ok: true });
    assert.deepEqual(origins, ["local-command"]); assert.equal(updates.length, 1); assert.equal(readSharedRevision(handle), base + 1);
    assert.deepEqual([...new Set(Y.decodeUpdate(present(updates[0])).structs.map(item => item.id.client))], [client]);
    const target = readSharedTextTarget({ owner: "R1", segment: "b:R1", field: "audioText" }); assert.ok(target);
    assert.deepEqual(readSharedMarkCharacters(handle, target)?.map(char => [char.value, char.marks.map(group => group.kind)]), [
      ["a", ["i"]], ["X", ["b"]], ["Y", ["b"]], ["b", ["i"]], ["c", ["i"]], ["d", ["i"]]
    ]);
    const prep = createSharedPreparation(handle), records = prep.view.text(["segments", "b:R1", "text"])?.records; assert.ok(records);
    const secondBirth = records.find(item => item.record.operation === "two")?.record;
    assert.ok(secondBirth?.type === "birth"); assert.ok(secondBirth.observed.some(identity => identity === sharedMarkRecordKey("one:mark", client))); prep.close();
    assert.deepEqual(executeSharedOperations(handle, [insertion("three", 0, "Z")]), { ok: true });
    assert.equal(calls, 3); assert.equal(creations, 2); assert.equal(updates.length, 2); assert.equal(origins.length, 2);
  } finally { detach(); stop(); destroySharedDocument(handle); }
});

test("a late refusal discards text scratch, bytes, vector and delivered updates", () => {
  const handle = fixture(), updates: Uint8Array[] = [], stop = deliveryReplica(handle).onLocalUpdate(update => updates.push(update));
  try {
    installTextSeamProbe(handle);
    const before = encodeSharedState(handle), vector = encodeSharedStateVector(handle), revision = readSharedRevision(handle);
    const result = executeSharedOperations(handle, [insertion("accepted-prepare", 1), operation({ kind: "record-delete", id: "refused", by: "", target: { collection: "people", record: "missing" } })]);
    assert.ok(!result.ok); assert.equal(result.index, 1);
    assert.deepEqual(encodeSharedState(handle), before); assert.deepEqual(encodeSharedStateVector(handle), vector);
    assert.equal(readSharedRevision(handle), revision); assert.equal(updates.length, 0);
    const duplicate = executeSharedOperations(handle, [insertion("duplicate", 1), insertion("duplicate", 2)]);
    assert.ok(!duplicate.ok); assert.equal(duplicate.index, 1); assert.deepEqual(encodeSharedState(handle), before); assert.deepEqual(encodeSharedStateVector(handle), vector); assert.equal(updates.length, 0);
    assert.deepEqual(executeSharedOperations(handle, [insertion("accepted-prepare", 1)]), { ok: true }); assert.equal(updates.length, 1);
  } finally { stop(); destroySharedDocument(handle); }
});

test("stale base: a received update refuses the painted revision before prepare without writing", () => {
  const handle = fixture(), peer = createMonitoredSharedDocument(); let calls = 0;
  try {
    assert.equal(applySharedUpdate(peer, encodeSharedState(handle)).ok, true);
    installTextSeamProbe(handle, () => { calls++; });
    const base = readSharedRevision(handle);
    const paintedVector = encodeSharedStateVector(handle), native = (collabState(peer).roots.segments.get("b:R1") as Y.Map<unknown>).get("text") as Y.Text;
    transactSharedDocument(peer, "local-command", () => native.delete(1, 1));
    assert.equal(applySharedUpdate(handle, encodeSharedState(peer)).ok, true);
    assert.deepEqual(encodeSharedStateVector(handle), paintedVector);
    const before = encodeSharedState(handle), vector = encodeSharedStateVector(handle), updates: Uint8Array[] = [];
    const stop = deliveryReplica(handle).onLocalUpdate(update => updates.push(update));
    assert.deepEqual(executeSharedOperations(handle, [insertion("stale", 1)], { base }), { ok: false, reason: "stale-base" });
    assert.equal(calls, 0); assert.deepEqual(encodeSharedState(handle), before); assert.deepEqual(encodeSharedStateVector(handle), vector); assert.equal(updates.length, 0);
    assert.deepEqual(executeSharedOperations(handle, [], { base }), { ok: false, reason: "stale-base" });
    const current = readSharedRevision(handle); assert.deepEqual(executeSharedOperations(handle, [], { base: current }), { ok: true }); assert.equal(readSharedRevision(handle), current); assert.equal(updates.length, 0);
    stop();
  } finally { destroySharedDocument(handle); destroySharedDocument(peer); }
});

test("revision counts changed transactions of every origin once, including deletion-only changes and duplicate delivery", () => {
  const handle = fixture(), peer = createMonitoredSharedDocument();
  try {
    const start = readSharedRevision(handle);
    assert.equal(start, 1);
    for (const origin of ["local-command", "local-undo", "remote", "hydration"] as const) {
      const before = readSharedRevision(handle);
      transactSharedDocument(handle, origin, () => { collabState(handle).roots.meta.set(origin, true); collabState(handle).roots.meta.set(origin + ":second", true); });
      assert.equal(readSharedRevision(handle), before + 1);
      transactSharedDocument(handle, origin, () => {}); assert.equal(readSharedRevision(handle), before + 1);
    }
    const native = (collabState(handle).roots.segments.get("b:R1") as Y.Map<unknown>).get("text") as Y.Text;
    const vector = encodeSharedStateVector(handle), before = readSharedRevision(handle);
    transactSharedDocument(handle, "local-command", () => native.delete(0, 1));
    assert.deepEqual(encodeSharedStateVector(handle), vector); assert.equal(readSharedRevision(handle), before + 1);
    const update = encodeSharedState(handle); assert.equal(applySharedUpdate(peer, update).ok, true);
    const received = readSharedRevision(peer); assert.equal(received, 1); assert.equal(applySharedUpdate(peer, update).ok, true); assert.equal(readSharedRevision(peer), received);
  } finally { destroySharedDocument(handle); destroySharedDocument(peer); }
});

test("text preparation touches one cached text and its records regardless of unrelated document size", () => {
  const counts: number[] = [];
  for (const size of [0, 10000]) {
    const handle = fixture();
    try {
      transactSharedDocument(handle, "local-command", () => { for (let index = 0; index < size; index++) collabState(handle).roots.people.set("P" + index, { name: "untouched" }); });
      installTextSeamProbe(handle);
      const textReads = mock.method(Y.Text.prototype, "toDelta"), gets = mock.method(Y.Doc.prototype, "get");
      const rootReads: { mock: { callCount: () => number; restore: () => void } }[] = [];
      for (const root of Object.values(collabState(handle).roots)) {
        if (root instanceof Y.Map) {
          for (const method of ["keys", "values", "entries", "forEach", "toJSON"] as const) rootReads.push(mock.method(root, method, () => { throw new Error("Whole root read"); }));
          rootReads.push(mock.method(root, Symbol.iterator, () => { throw new Error("Whole root read"); }));
        } else rootReads.push(mock.method(root, "toArray", () => { throw new Error("Whole root read"); }));
      }
      try {
        assert.deepEqual(executeSharedOperations(handle, [insertion("a", 1), insertion("b", 2)]), { ok: true });
        counts.push(textReads.mock.callCount()); assert.equal(gets.mock.callCount(), 0); for (const read of rootReads) assert.equal(read.mock.callCount(), 0);
      } finally { textReads.mock.restore(); gets.mock.restore(); for (const read of rootReads) read.mock.restore(); }
    } finally { destroySharedDocument(handle); }
  }
  assert.deepEqual(counts, [2, 2]);
});

test("seeded malformed text payloads and mark records have identical frozen facades after encoded transfer", () => {
  const handle = fixture(), peer = createMonitoredSharedDocument();
  try {
    const segment = collabState(handle).roots.segments.get("b:R1") as Y.Map<unknown>, native = segment.get("text") as Y.Text, marks = segment.get("markRecords") as Y.Map<unknown>;
    const initial = createSharedPreparation(handle), good = present(present(initial.view.text(["segments", "b:R1", "text"])).records[0]).record; initial.close();
    const payloads = [{ w: "Ada" }, { k: "S", label: "B-roll" }, { bad: undefined }, { n: NaN }, { n: -0 }, { a: new Array(2) }, { w: "\ud800", nested: { z: 1, a: 2 } }];
    let seed = 0x1414;
    for (let sample = 0; sample < 32; sample++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const operation = "fuzz" + sample, writer = collabState(handle).doc.clientID, key = present(sharedMarkRecordKey(operation, writer));
      const raw = sample % 4 === 0 ? { ...good, operation, writer } : sample % 4 === 1 ? { ...good, operation, writer, extra: true } : sample % 4 === 2 ? null : { type: "remove", observed: new Array(1) };
      transactSharedDocument(handle, "local-command", () => { native.insert(native.length, "z\ud800"); native.insertEmbed(native.length, present(payloads[seed % payloads.length])); marks.set(key, raw); marks.set("bad\ud800" + sample, raw); });
      assert.equal(applySharedUpdate(peer, encodeSharedState(handle)).ok, true);
      const a = createSharedPreparation(handle), c = createSharedPreparation(peer);
      const read = (view: SharedPreparationView) => { const text = view.text(["segments", "b:R1", "text"]); assert.ok(text); return { length: text.length, units: text.units, recordKeys: text.recordKeys, records: text.records }; };
      assertReplicasAgree("malformed text facade " + sample, [{ order: "D1", replica: "A", output: read(a.view) }, { order: "late-C", replica: "C", output: read(c.view) }]);
      a.close(); c.close();
    }
  } finally { destroySharedDocument(handle); destroySharedDocument(peer); }
});

test("two live writers use the seam in six schedules with a late joiner and keep colliding command identities", () => {
  let runs = 0;
  for (const order of deliveryOrders) {
    const a = fixture(50), b = createMonitoredSharedDocument(), c = createMonitoredSharedDocument();
    const queue = new DeliveryQueue<Uint8Array>(update => update.slice(), update => String(update.length));
    try {
      collabState(a).doc.clientID = 101; assert.equal(applySharedUpdate(b, encodeSharedState(a)).ok, true); collabState(b).doc.clientID = 102;
      installTextSeamProbe(a); installTextSeamProbe(b);
      queue.addReplica("A", deliveryReplica(a)); queue.addReplica("B", deliveryReplica(b));
      let joined = false;
      if (order === "D3") {
        assert.deepEqual(executeSharedOperations(b, [insertion("same", 0, "Y")]), { ok: true }); queue.deliverFrom("B", order);
        assert.deepEqual(executeSharedOperations(a, [insertion("same", 2)]), { ok: true });
      } else {
        assert.deepEqual(executeSharedOperations(a, [insertion("same", 1)]), { ok: true });
        if (order === "D2") queue.flush(order);
        if (order === "late-C") { queue.lateJoin("C", deliveryReplica(c), "A", encodeSharedState(a)); joined = true; }
        assert.deepEqual(executeSharedOperations(b, [insertion("same", 0, "Y")]), { ok: true });
      }
      queue.flush(order);
      if (!joined) queue.lateJoin("C", deliveryReplica(c), "A", encodeSharedState(a));
      const snapshots = [a, b, c].map(handle => {
        const prep = createSharedPreparation(handle), text = prep.view.text(["segments", "b:R1", "text"]); assert.ok(text);
        const result = { length: text.length, units: text.units, recordKeys: text.recordKeys, records: text.records }; prep.close();
        return result;
      });
      assertReplicasAgree("seam concurrent facades", snapshots.map((output, index) => ({ order: index === 2 ? "late-C" as const : order === "late-C" ? "D1" as const : order,
        replica: present((["A", "B", "C"] as const)[index]), output })));
      const expected = [{ value: "Y", marks: ["b"] }, { value: "a", marks: ["i"] }, { value: "X", marks: ["b"] }, { value: "b", marks: ["i"] }, { value: "c", marks: ["i"] }, { value: "d", marks: ["i"] }];
      for (const snapshot of snapshots) {
        assert.deepEqual(snapshot.units.map(unit => ({ value: unit.value, marks: unit.marks.map(group => group.kind) })), expected);
        for (const client of [101, 102]) assert.ok(snapshot.recordKeys.includes(present(sharedMarkRecordKey("same:mark", client))));
      }
      runs++;
    } finally { queue.destroy(); for (const handle of [a, b, c]) destroySharedDocument(handle); }
  }
  assert.equal(runs, 6);
});
