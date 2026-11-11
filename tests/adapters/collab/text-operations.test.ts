import test, { mock } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { createMonitoredSharedDocument, validatedFixture, deliveryReplica } from "./helpers.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { destroySharedDocument, encodeSharedState, encodeSharedStateVector, observeSharedTransactions, readSharedRevision, applySharedUpdate, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { registerSharedTextOperationHandlers, prepareSharedTextInsertion } from "../../../src/adapters/collab/text-executor.ts";
import { captureSharedTextRange, resolveSharedBaseReference } from "../../../src/adapters/collab/executor-references.ts";
import { createSharedAnchor, resolveSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { readSharedMarkCharacters } from "../../../src/adapters/collab/mark-store.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { sharedTextLocation, sharedTextCommandPlan } from "../../../src/adapters/collab/executor-text-plan.ts";
import { registerSharedOperationHandlers } from "../../../src/adapters/collab/operation-handlers.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import type { SharedTextAddress, SharedInsertionChunk, SharedOperation } from "../../../src/core/collab/operations.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { operation, ref } from "./executor-support.ts";
import { markTraceExample, markTraceKinds } from "./marks/replica.ts";
import { DeliveryQueue, deliveryOrders } from "../../collab/delivery.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import { IdentityBook } from "../../collab/checker.ts";
import { deletionOracle } from "../../collab/oracles/oracles.ts";

function fixture(client = 1, state?: Uint8Array, register = true) {
  const handle = createMonitoredSharedDocument(); collabState(handle).doc.clientID = client;
  if (state) assert.equal(applySharedUpdate(handle, state).ok, true);
  else hydrateSharedDocument(handle, validatedFixture({ title: "Title", rows: [{ id: "R1", audioText: "abcd", visualText: "uv" }], sections: [{ id: "H1", name: "A😀Z", firstSceneId: "R1" }] }));
  if (register) registerSharedTextOperationHandlers(handle); return handle;
}
function target(field: SharedTextAddress["field"], handle: SharedDocumentHandle): SharedTextAddress {
  const owner = field === "title" ? String(collabState(handle).roots.meta.get("docId")) : field === "heading" ? "H1" : "R1";
  return { owner: ref(owner), segment: ref(owner), field };
}
function canonical(handle: SharedDocumentHandle, address: SharedTextAddress) {
  const prep = createSharedPreparation(handle);
  try { return sharedTextLocation(prep.view, address).target; } finally { prep.close(); }
}
function read(handle: SharedDocumentHandle, address: SharedTextAddress) { const chars = readSharedMarkCharacters(handle, canonical(handle, address)); assert.ok(chars); return chars; }
function insert(id: string, address: SharedTextAddress, at: number, content: readonly SharedInsertionChunk[] = [{ value: "X", marks: [] }]) {
  return operation({ kind: "text-insert", id, by: "A", target: address, at: { left: null, right: flowBaseReference(address.owner, address.field, at), affinity: "before" }, content });
}

for (const field of ["audioText", "visualText", "heading", "title"] as const) test(`text executor inserts explicit marks and deletes in ${field}`, () => {
  const handle = fixture();
  try {
    const address = target(field, handle), before = read(handle, address).map(char => char.value).join(""), marks = markTraceKinds.map(markTraceExample);
    const recordRoots = [collabState(handle).roots.comments, collabState(handle).roots.tags, collabState(handle).roots.people,
      collabState(handle).roots.shots, collabState(handle).roots.replies, collabState(handle).roots.gallery];
    const recordsBefore = JSON.stringify(recordRoots.map(root => root.toJSON()));
    const collections = [...recordRoots, collabState(handle).roots.visuals, collabState(handle).roots.beats, collabState(handle).roots.headings];
    const recordKeysBefore = JSON.stringify(collections.map(root => [...root.keys()]));
    const base = readSharedRevision(handle), updates: Uint8Array[] = [], origins: unknown[] = [];
    const stop = deliveryReplica(handle).onLocalUpdate(update => updates.push(update)), detach = observeSharedTransactions(handle, origin => origins.push(origin));
    assert.deepEqual(executeSharedOperations(handle, [insert("typed", address, 1, [{ value: "X", marks }])], { base }), { ok: true });
    stop(); detach(); assert.equal(updates.length, 1); assert.deepEqual(origins, ["local-command"]);
    const after = read(handle, address); assert.equal(after.map(char => char.value).join(""), before.slice(0, 1) + "X" + before.slice(1));
    assert.deepEqual(after[1]?.marks.map(mark => mark.kind).sort(), ["b", "comment", "cue", "dir", "hl", "i", "link", "s", "tag", "u"]);
    assert.equal(JSON.stringify(recordRoots.map(root => root.toJSON())), recordsBefore);
    assert.equal(JSON.stringify(collections.map(root => [...root.keys()])), recordKeysBefore);
    assert.deepEqual([...new Set(Y.decodeUpdate(updates[0] as Uint8Array).structs.map(item => item.id.client))], [1]);
    const range = captureSharedTextRange(handle, address, 1, 2); assert.ok(range);
    assert.deepEqual(executeSharedOperations(handle, [operation({ kind: "text-delete", id: "delete", by: "A", target: address, observed: [range] })]), { ok: true });
    assert.equal(read(handle, address).map(char => char.value).join(""), before);
  } finally { destroySharedDocument(handle); }
});

test("flow-base provenance maps original and earlier-insertion units through an ordered operation list", () => {
  const handle = fixture();
  try {
    const address = target("audioText", handle), base = readSharedRevision(handle);
    const one = insert("one", address, 1), remove = operation({ kind: "text-delete", id: "remove", by: "A", target: address, observed: [flowBaseReference("R1", "audioText", 1, 3)] });
    const two = operation({ kind: "text-insert", id: "two", by: "A", target: address, at: { left: flowBaseReference("one", "audioText", 0), right: null, affinity: "after" }, content: [{ value: "Y", marks: [] }] });
    const removeOne = operation({ kind: "text-delete", id: "remove-one", by: "A", target: address, observed: [flowBaseReference("one", "audioText", 0, 1)] });
    assert.deepEqual(executeSharedOperations(handle, [one, remove, two, removeOne], { base }), { ok: true });
    assert.equal(read(handle, address).map(char => char.value).join(""), "aYd");
    assert.deepEqual(resolveSharedBaseReference(handle, address, flowBaseReference("R1", "audioText", 0, 1), base), { ok: false, reason: "stale-base" });
    assert.deepEqual(resolveSharedBaseReference(handle, address, flowBaseReference("R1", "audioText", 0, 1), readSharedRevision(handle)), { ok: true, target: canonical(handle, address), from: 0, to: 1 });
  } finally { destroySharedDocument(handle); }
});

test("a large validated insertion is not limited by JavaScript argument count", () => {
  const handle = fixture();
  try {
    const address = target("audioText", handle), value = "x".repeat(150000);
    assert.deepEqual(executeSharedOperations(handle, [insert("large", address, 2, [{ value, marks: [] }])], { base: readSharedRevision(handle) }), { ok: true });
    const segment = collabState(handle).roots.segments.get("b:R1"); assert.ok(segment instanceof Y.Map);
    const text: unknown = segment.get("text"); assert.ok(text instanceof Y.Text); assert.equal(text.toString(), "ab" + value + "cd");
  } finally { destroySharedDocument(handle); }
});

test("C returns a deeply frozen description and apply ignores retained mutable scratch plans", () => {
  const handle = fixture(1, undefined, false);
  try {
    const address = target("audioText", handle);
    const plain = (value: unknown, frozen: boolean): void => {
      if (value === null || typeof value !== "object") { assert.notEqual(typeof value, "function"); return; }
      assert.ok(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype);
      if (frozen) assert.equal(Object.isFrozen(value), true);
      for (const child of Object.values(value)) plain(child, frozen);
    };
    registerSharedOperationHandlers(handle, { "text-insert": (command, view) => {
      const prepared = prepareSharedTextInsertion(command, view); assert.ok(prepared.ok);
      plain(prepared.description, true); plain(prepared.writes, true);
      assert.throws(() => { (prepared.description.steps as unknown[]).push({}); }, TypeError);
      const scratch = sharedTextCommandPlan(view, command.target); plain(scratch, false);
      scratch.units.splice(0, scratch.units.length); scratch.recordKeys.length = 0; scratch.additions.length = 0; scratch.sources.length = 0;
      return prepared;
    } });
    assert.deepEqual(executeSharedOperations(handle, [insert("frozen", address, 1, [{ value: "X", marks: [{ kind: "link", id: ref("L"), value: "https://x" }] }])], { base: readSharedRevision(handle) }), { ok: true });
    assert.equal(read(handle, address).map(char => char.value).join(""), "aXbcd"); assert.deepEqual(read(handle, address)[1]?.marks[0]?.values, ["https://x"]);
  } finally { destroySharedDocument(handle); }
});

test("text executor preserves embedded atom payloads, explicit plain births and encoded late joins", () => {
  const handle = fixture(), peer = createMonitoredSharedDocument();
  try {
    const address = target("audioText", handle), image = { sha256: "a".repeat(64), width: 1, height: 2, mime: "image/png" };
    const content: SharedInsertionChunk[] = [{ value: "😀", marks: [{ kind: "i", value: true }] },
      { value: { atom: "who", name: "Ada" }, marks: [] }, { value: { atom: "broll", id: ref("S"), text: "Wide" }, marks: [] },
      { value: { atom: "image", ref: image }, marks: [] }, { value: { atom: "video", href: "https://v", host: "v" }, marks: [] }];
    assert.deepEqual(executeSharedOperations(handle, [insert("atoms", address, 2, content)], { base: readSharedRevision(handle) }), { ok: true });
    assert.equal(applySharedUpdate(peer, encodeSharedState(handle)).ok, true);
    const outputs = [handle, peer].map(current => {
      const prep = createSharedPreparation(current), located = sharedTextLocation(prep.view, address), text = prep.view.text(located.path); assert.ok(text);
      const output = text.units.map(unit => ({ value: unit.value, marks: unit.marks })); prep.close(); return output;
    });
    assertReplicasAgree("typed atom late join", [{ order: "D1", replica: "A", output: outputs[0] }, { order: "late-C", replica: "C", output: outputs[1] }]);
    assert.deepEqual(outputs[0]?.map(unit => unit.value), ["a", "b", "\ud83d", "\ude00", { w: "Ada" }, { k: "S", label: "Wide" }, { img: image }, { video: "https://v", host: "v" }, "c", "d"]);
    assert.deepEqual(read(handle, address).map(char => char.marks.map(group => group.kind)), [[], [], ["i"], ["i"], [], [], [], [], [], []]);
    const atoms = captureSharedTextRange(handle, address, 4, 8); assert.ok(atoms);
    assert.deepEqual(executeSharedOperations(handle, [operation({ kind: "text-delete", id: "delete-atoms", by: "A", target: address, observed: [atoms] }), insert("after-atoms", address, 8)], { base: readSharedRevision(handle) }), { ok: true });
    assert.equal(read(handle, address).map(char => char.value).join(""), "ab😀Xcd");
  } finally { destroySharedDocument(handle); destroySharedDocument(peer); }
});

test("explicit null insertion attributes of every kind are absent inside a known italic range", () => {
  const handle = createMonitoredSharedDocument();
  try {
    hydrateSharedDocument(handle, validatedFixture({ rows: [{ id: "R1", audioText: "<i>abcd</i>" }] })); registerSharedTextOperationHandlers(handle);
    const address = target("audioText", handle), marks = markTraceKinds.map(kind => ({ ...markTraceExample(kind), value: null }));
    assert.deepEqual(executeSharedOperations(handle, [insert("plain", address, 2, [{ value: "X", marks }])], { base: readSharedRevision(handle) }), { ok: true });
    assert.deepEqual(read(handle, address).map(char => [char.value, char.marks.map(group => group.kind)]), [["a", ["i"]], ["b", ["i"]], ["X", []], ["c", ["i"]], ["d", ["i"]]]);
  } finally { destroySharedDocument(handle); }
});

test("two writers refuse a missing visual text and store without creating either", () => {
  const a = fixture(), b = fixture(2, encodeSharedState(a));
  try {
    const address = { owner: ref("R1"), segment: ref("new-visual"), field: "visualText" as const };
    for (const handle of [a, b]) {
      const before = encodeSharedState(handle), result = executeSharedOperations(handle, [insert("same", address, 0)], { base: readSharedRevision(handle) });
      assert.ok(!result.ok); assert.equal(result.reason, "missing-target"); assert.deepEqual(encodeSharedState(handle), before);
      assert.equal(collabState(handle).roots.visuals.has("new-visual"), false);
    }
  } finally { destroySharedDocument(a); destroySharedDocument(b); }
});

test("production text handlers enumerate no whole root and read only their touched text", () => {
  const counts: number[] = [];
  for (const size of [0, 10000]) {
    const handle = fixture();
    try {
      const address = target("audioText", handle), base = readSharedRevision(handle);
      transactSharedDocument(handle, "local-command", () => { for (let index = 0; index < size; index++) collabState(handle).roots.people.set("P" + index, { name: "unrelated" }); });
      const reads = mock.method(Y.Text.prototype, "toDelta"), docReads = mock.method(Y.Doc.prototype, "get"), restores: (() => void)[] = [];
      for (const root of Object.values(collabState(handle).roots)) {
        if (root instanceof Y.Map) for (const method of ["keys", "entries", "values", "forEach", "toJSON", Symbol.iterator] as const) {
          const spy = mock.method(root, method, () => { throw new Error("Whole root read"); }); restores.push(() => spy.mock.restore());
        } else { const spy = mock.method(root, "toArray", () => { throw new Error("Whole root read"); }); restores.push(() => spy.mock.restore()); }
      }
      try {
        assert.deepEqual(executeSharedOperations(handle, [insert("one", address, 1), insert("two", address, 2)], { base: size ? readSharedRevision(handle) : base }), { ok: true });
        counts.push(reads.mock.callCount()); assert.equal(docReads.mock.callCount(), 0);
      } finally { reads.mock.restore(); docReads.mock.restore(); restores.forEach(restore => restore()); }
    } finally { destroySharedDocument(handle); }
  }
  assert.deepEqual(counts, [2, 2]);
});

test("shared heading base positions clamp surrogate pairs for insertion and deletion", () => {
  const handle = fixture();
  try {
    const address = target("heading", handle), base = readSharedRevision(handle);
    assert.deepEqual(resolveSharedBaseReference(handle, address, flowBaseReference("H1", "heading", 2), base), { ok: true, target: canonical(handle, address), from: 3, to: 3 });
    assert.deepEqual(executeSharedOperations(handle, [insert("pair", address, 2)], { base }), { ok: true });
    assert.equal(read(handle, address).map(char => char.value).join(""), "A😀XZ");
    assert.deepEqual(executeSharedOperations(handle, [operation({ kind: "text-delete", id: "pair-delete", by: "A", target: address, observed: [flowBaseReference("H1", "heading", 2, 3)] })], { base: readSharedRevision(handle) }), { ok: true });
    assert.equal(read(handle, address).map(char => char.value).join(""), "AXZ");
  } finally { destroySharedDocument(handle); }
});

test("unsupported, missing, malformed and unversioned late operations refuse the whole list", () => {
  const handle = fixture();
  try {
    const address = target("audioText", handle), updates: Uint8Array[] = [], stop = deliveryReplica(handle).onLocalUpdate(update => updates.push(update));
    const bad = [operation({ kind: "restore", id: "unsupported", by: "A", removals: [] }), insert("missing", { ...address, segment: ref("missing") }, 0),
      operation({ kind: "text-delete", id: "bad-reference", by: "A", target: address, observed: ["nonsense"] }), insert("bad-id\ufffd", address, 0), insert("out-of-bounds", address, 999),
      insert("bad-shot-id", address, 0, [{ value: { atom: "broll", id: ref("S\ufffd") }, marks: [] }]),
      insert("bad-tag-payload", address, 0, [{ value: "X", marks: [{ kind: "tag", id: ref("T"), value: ref("P\ufffd") }] }]),
      insert("bad-identified-id", address, 0, [{ value: "X", marks: [{ kind: "tag", id: ref("T\ufffd"), value: ref("P") }] }]),
      { kind: "text-insert", id: "bad-payload", by: "A", target: address, at: { left: null, right: null, affinity: "before" }, content: [{ value: { atom: "who", name: () => "Ada" }, marks: [] }] } as unknown as SharedOperation];
    const before = encodeSharedState(handle), vector = encodeSharedStateVector(handle), base = readSharedRevision(handle);
    for (const command of bad) {
      const result = executeSharedOperations(handle, [insert("first", address, 1), command], { base });
      assert.ok(!result.ok && "index" in result); assert.equal(result.index, 1);
      assert.deepEqual(encodeSharedState(handle), before); assert.deepEqual(encodeSharedStateVector(handle), vector); assert.equal(updates.length, 0); assert.equal(readSharedRevision(handle), base);
    }
    const noBase = executeSharedOperations(handle, [insert("no-base", address, 0)]); assert.ok(!noBase.ok); assert.equal(noBase.reason, "stale-base");
    assert.deepEqual(encodeSharedState(handle), before); stop();
  } finally { destroySharedDocument(handle); }
});

test("missing or malformed stores refuse all planned writes before apply", () => {
  for (const missing of [true, false]) {
    const handle = fixture();
    try {
      const address = target("audioText", handle), segment = collabState(handle).roots.segments.get("b:R1"); assert.ok(segment instanceof Y.Map);
      transactSharedDocument(handle, "local-command", () => { if (missing) segment.delete("markRecords"); else segment.set("markRecords", 0); });
      const before = encodeSharedState(handle), vector = encodeSharedStateVector(handle), revision = readSharedRevision(handle), updates: Uint8Array[] = [];
      const stop = deliveryReplica(handle).onLocalUpdate(update => updates.push(update));
      const result = executeSharedOperations(handle, [operation({ kind: "scalar", id: "first", by: "A", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 3 }), insert("text", address, 0)], { base: revision });
      assert.ok(!result.ok && "index" in result); assert.equal(result.index, 1); assert.equal(result.reason, "missing-store");
      assert.deepEqual(encodeSharedState(handle), before); assert.deepEqual(encodeSharedStateVector(handle), vector); assert.deepEqual(updates, []); assert.equal(readSharedRevision(handle), revision); stop();
    } finally { destroySharedDocument(handle); }
  }
});

test("wrong owners and cross-field segments refuse insertion and deletion before any write", () => {
  const handle = createMonitoredSharedDocument();
  try {
    hydrateSharedDocument(handle, validatedFixture({ title: "Title", rows: [{ id: "R1", audioText: "abcd", visualText: "view" }, { id: "R2", audioText: "wxyz" }],
      sections: [{ id: "H1", name: "Heading", firstSceneId: "R1" }] })); registerSharedTextOperationHandlers(handle);
    const audio = target("audioText", handle), heading = target("heading", handle), visual = target("visualText", handle), title = target("title", handle);
    const badTargets: SharedTextAddress[] = [{ ...audio, segment: ref("b:R2") }, { ...audio, segment: ref("h:H1") },
      { ...heading, segment: ref("b:R1") }, { ...visual, segment: ref("b:R1") }, { ...title, segment: ref("h:H1") }];
    const bad = [...badTargets.map((address, index) => insert("bad" + index, address, 0)),
      operation({ kind: "text-delete", id: "bad-delete", by: "A", target: badTargets[0], observed: [flowBaseReference("R1", "audioText", 0, 1)] })];
    const bytes = encodeSharedState(handle), vector = encodeSharedStateVector(handle), revision = readSharedRevision(handle), updates: Uint8Array[] = [];
    const stop = deliveryReplica(handle).onLocalUpdate(update => updates.push(update));
    for (const command of bad) {
      const result = executeSharedOperations(handle, [insert("prepared-first", audio, 0), command], { base: revision });
      assert.ok(!result.ok && "index" in result); assert.equal(result.index, 1);
      assert.deepEqual(encodeSharedState(handle), bytes); assert.deepEqual(encodeSharedStateVector(handle), vector); assert.equal(readSharedRevision(handle), revision); assert.deepEqual(updates, []);
    }
    stop();
  } finally { destroySharedDocument(handle); }
});

test("T01 observed deletion preserves concurrent insertion in six schedules and a late joiner", () => {
  for (const order of deliveryOrders) {
    const a = fixture(1), b = fixture(2, encodeSharedState(a)), c = createMonitoredSharedDocument(), address = target("audioText", a), stored = canonical(a, address), book = new IdentityBook();
    const queue = new DeliveryQueue<Uint8Array>(bytes => bytes.slice(), bytes => String(bytes.length));
    try {
      read(a, address).forEach((char, index) => book.bind("s" + (index + 1), char.identity));
      const range = captureSharedTextRange(a, address, 1, 3), caret = createSharedAnchor(a, stored, 1, "before"); assert.ok(range && caret);
      const at = createSharedAnchor(b, stored, 2, "after"); assert.ok(at);
      queue.addReplica("A", deliveryReplica(a)); queue.addReplica("B", deliveryReplica(b));
      const writeB = () => { assert.deepEqual(executeSharedOperations(b, [operation({ kind: "text-insert", id: "B", by: "Bob", target: address, at: { left: null, right: at, affinity: "before" }, content: [{ value: "X", marks: [] }] })]), { ok: true }); const x = read(b, address).find(char => char.value === "X"); assert.ok(x); book.bind("b1", x.identity); };
      if (order === "D3") { writeB(); queue.deliverFrom("B", order); }
      assert.deepEqual(executeSharedOperations(a, [operation({ kind: "text-delete", id: "A", by: "Alice", target: address, observed: [range] })]), { ok: true });
      if (order === "D2") queue.flush(order);
      let joined = false;
      if (order === "late-C") { queue.lateJoin("C", deliveryReplica(c), "A", encodeSharedState(a)); joined = true; }
      if (order !== "D3") writeB();
      queue.flush(order); if (!joined) queue.lateJoin("C", deliveryReplica(c), "A", encodeSharedState(a));
      const outputs = [a, b, c].map(handle => {
        const point = resolveSharedAnchor(handle, caret); assert.notEqual(point, "gone"); if (point === "gone") throw new Error("Gone caret");
        return { rows: [{ id: "R1", characters: read(handle, address).map(char => [book.notation(char.identity), char.value, {}] as const) }], carets: { A: { beat: "R1", offset: point.offset } }, recovery: [] };
      });
      assertReplicasAgree("T01 executor", [{ order: "D1", replica: "A", output: deletionOracle }, ...outputs.map((output, index) => ({ order: index === 2 ? "late-C" as const : order === "late-C" ? "D1" as const : order, replica: index === 0 ? "A" as const : index === 1 ? "B" as const : "C" as const, output }))]);
    } finally { queue.destroy(); for (const handle of [a, b, c]) destroySharedDocument(handle); }
  }
});
