import test, { mock } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, agree, operation, ref } from "./executor-support.ts";
import { createMonitoredSharedDocument, deliveryReplica, validatedFixture } from "./helpers.ts";
import { collabState, SharedExecutionWriteError } from "../../../src/adapters/collab/state.ts";
import { destroySharedDocument, encodeSharedState, encodeSharedStateVector, readSharedRevision, observeSharedTransactions, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { prepareSharedBeatSplit, registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedOperationHandlers } from "../../../src/adapters/collab/operation-handlers.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { sharedTextLocation } from "../../../src/adapters/collab/executor-text-plan.ts";
import { applySharedTextCreation } from "../../../src/adapters/collab/text-target.ts";
import { prepareSharedTextCreation } from "../../../src/adapters/collab/text-creation.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { observeSharedStructureOrder } from "../../../src/adapters/collab/structure-order.ts";
import { prepareSharedSegmentCreation } from "../../../src/adapters/collab/segment-executor.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import type { SharedBeatSplit, SharedTextAddress } from "../../../src/core/collab/operations.ts";

const target: SharedTextAddress = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" };
function split(id = "enter", before = false): SharedBeatSplit {
  return operation({ kind: before ? "split-before" : "split", id, by: "Writer", target,
    at: { left: null, right: flowBaseReference("R1", "audioText", 2), affinity: "before" },
    observed: [flowBaseReference("R1", "audioText", 0, 4)], boundary: "same-boundary", beat: "same-beat", fields: { status: "todo" } }) as SharedBeatSplit;
}
function type(id: string, owner: string, value: string) {
  return operation({ kind: "text-insert", id, by: "Writer", target: { ...target, owner, segment: owner },
    at: { left: null, right: flowBaseReference(owner, "audioText", 0), affinity: "before" }, content: [{ value, marks: [] }] });
}
function read(handle: SharedDocumentHandle) {
  const roots = collabState(handle).roots, rows: { id: string; text: string }[] = [];
  for (const key of roots.order.toArray()) {
    const segment = roots.segments.get(key) as Y.Map<unknown>, text = segment.get("text") as Y.Text;
    rows.push({ id: (segment.get("head") as { b: string }).b, text: "" });
    for (const delta of text.toDelta() as { insert: unknown }[]) {
    const row = rows.at(-1); assert.ok(row);
    if (typeof delta.insert === "string") row.text += delta.insert;
    else {
      const boundary = delta.insert as { b: string; before?: string };
      if (boundary.before) { const prefix = rows.findLast(candidate => candidate.id === boundary.before); assert.ok(prefix); prefix.id = boundary.b; rows.push({ id: boundary.before, text: "" }); }
      else rows.push({ id: boundary.b, text: "" });
    }
  }
  }
  return { rows, beats: [...roots.beats.keys()].sort() };
}

for (const before of [false, true]) test(`split${before ? " before" : ""} and subsequent typing use a frozen plan in one transaction`, () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "abcd" }] });
  try {
    const handle = set.a, origins: unknown[] = [], updates: Uint8Array[] = [];
    registerSharedSplitHandlers(handle); registerSharedTextOperationHandlers(handle);
    const detach = observeSharedTransactions(handle, origin => origins.push(origin)), stop = deliveryReplica(handle).onLocalUpdate(update => updates.push(update));
    assert.deepEqual(executeSharedOperations(handle, [split("enter", before), type("typed", "same-beat", "X")], { base: readSharedRevision(handle) }), { ok: true });
    const id = JSON.stringify(["structure", "1", "enter", "beat"]);
    assert.deepEqual(read(handle), { rows: before ? [{ id, text: "Xab" }, { id: "R1", text: "cd" }] : [{ id: "R1", text: "ab" }, { id, text: "Xcd" }], beats: ["R1", id].sort() });
    assert.deepEqual(origins, ["local-command"]); assert.equal(updates.length, 1);
    const prep = createSharedPreparation(handle);
    assert.equal(sharedTextLocation(prep.view, { ...target, owner: ref(id) }).target.owner, id);
    assert.throws(() => sharedTextLocation(prep.view, { ...target, owner: ref(id), field: "heading" })); prep.close();
    detach(); stop();
  } finally { set.close(); }
});

test("seeded two and three writer split, prefix split and blank creation histories match the independent literal model", t => {
  let seed = 0x14145c, runs = 0;
  for (let sample = 0; sample < 36; sample++) for (const writers of [2, 3]) for (const order of ["D1", "dup", "rev", "late-C"] as const) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const offset = seed % 5, kind = sample % 3, set = replicas(writers, { rows: [{ id: "R1", audioText: "abcd" }] }), handles = [set.a, set.b, set.c].slice(0, writers);
    try {
      const ids = handles.map((_, index) => JSON.stringify(["structure", String(index + 1), "enter", "beat"]));
      for (const [index, handle] of handles.entries()) {
        registerSharedSplitHandlers(handle); registerSharedTextOperationHandlers(handle);
        const command = kind === 2 ? operation({ kind: "segment-create", id: "enter", by: "Writer", beat: "same-beat", segment: "same-segment", fields: { status: "todo", audioText: "" }, at: { left: null, right: "R1", affinity: "before" } })
          : operation({ ...split("enter", kind === 1), at: { left: null, right: flowBaseReference("R1", "audioText", offset), affinity: "before" } });
        assert.deepEqual(executeSharedOperations(handle, [command, type("typed", "same-beat", "MNO".charAt(index))], { base: readSharedRevision(handle) }), { ok: true });
      }
      set.queue.flush(order);
      const prefix = "abcd".slice(0, offset), tail = "abcd".slice(offset), empty = ids.map(id => ({ id, text: "" }));
      const expected = kind === 2 ? [...ids.map((id, index) => ({ id, text: "MNO".charAt(index) })), { id: "R1", text: "abcd" }]
        : kind === 1 ? empty.map((row, index) => ({ ...row, text: offset === 0 ? "MNO".charAt(index) : index ? "" : "MNO".slice(0, writers) + prefix })).concat([{ id: "R1", text: tail }])
        : [{ id: "R1", text: prefix }, ...ids.map((id, index) => ({ id, text: "MNO".charAt(index) + (index === writers - 1 ? tail : "") }))];
      agree(`seed=${seed}/kind=${kind}`, order, handles, read, { rows: expected, beats: ["R1", ...ids].sort() }); runs++;
    } finally { set.close(); }
  }
  assert.equal(runs, 288); t.diagnostic(JSON.stringify({ histories: runs, kinds: ["split", "split-before", "segment-create"], limits: [] }));
});

for (const writers of [2, 3]) for (const order of ["D1", "dup", "rev", "late-C"] as const) test(`${writers} writers at the same split gap retain both breaks and typed text: ${order}`, () => {
  const set = replicas(writers, { rows: [{ id: "R1", audioText: "abcd" }] }), handles = [set.a, set.b, set.c].slice(0, writers);
  try {
    for (const [index, handle] of handles.entries()) {
      registerSharedSplitHandlers(handle); registerSharedTextOperationHandlers(handle);
      assert.deepEqual(executeSharedOperations(handle, [split(), type("typed", "same-beat", String(index + 1))], { base: readSharedRevision(handle) }), { ok: true });
    }
    set.queue.flush(order);
    agree("same gap split retains all writers", order, handles, read);
    for (const handle of handles) {
      const actual = read(handle);
      assert.equal(actual.rows.length, writers + 1); assert.equal(actual.beats.length, writers + 1);
      for (let index = 0; index < writers; index++) {
        const row = actual.rows.find(row => row.id === JSON.stringify(["structure", String(index + 1), "enter", "beat"]));
        assert.ok(row?.text.startsWith(String(index + 1)));
      }
      assert.equal(actual.rows.map(row => row.text).join("").replace(/[123]/g, ""), "abcd");
    }
  } finally { set.close(); }
});

test("split refuses the whole list without changing bytes, vector, revision or delivered updates", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "abcd" }] }), handle = set.a;
  try {
    registerSharedSplitHandlers(handle);
    const before = encodeSharedState(handle), vector = encodeSharedStateVector(handle), revision = readSharedRevision(handle), updates: Uint8Array[] = [];
    const stop = deliveryReplica(handle).onLocalUpdate(update => updates.push(update));
    for (const operations of [[split(), split()], [split(), operation({ ...split("bad"), target: { ...target, owner: "missing" } })]]) {
      const result = executeSharedOperations(handle, operations, { base: revision }); assert.ok(!result.ok);
      assert.deepEqual(encodeSharedState(handle), before); assert.deepEqual(encodeSharedStateVector(handle), vector);
      assert.equal(readSharedRevision(handle), revision); assert.equal(updates.length, 0);
    }
    assert.deepEqual(executeSharedOperations(handle, [split()], { base: revision - 1 }), { ok: false, reason: "stale-base" }); stop();
    assert.deepEqual(executeSharedOperations(handle, [split()], { base: revision }), { ok: true });
  } finally { set.close(); }
});

test("split adds one boundary and preserves the native identities and marks of every original character", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "<i>abcd</i>" }] });
  try {
    const before = createSharedPreparation(set.a), original = before.view.text(["segments", "b:R1", "text"])?.units; assert.ok(original); before.close();
    registerSharedSplitHandlers(set.a);
    assert.deepEqual(executeSharedOperations(set.a, [split()], { base: readSharedRevision(set.a) }), { ok: true });
    const after = createSharedPreparation(set.a), units = after.view.text(["segments", "b:R1", "text"])?.units; assert.ok(units);
    assert.equal(units.length, 5); assert.deepEqual(units.filter(unit => typeof unit.value === "string"), original); after.close();
  } finally { set.close(); }
});

test("text and marks cannot address another beat's characters through a shared physical segment", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "abcd" }] }), handle = set.a;
  try {
    registerSharedSplitHandlers(handle); registerSharedTextOperationHandlers(handle);
    assert.deepEqual(executeSharedOperations(handle, [split()], { base: readSharedRevision(handle) }), { ok: true });
    const id = JSON.stringify(["structure", "1", "enter", "beat"]), targetB = { ...target, owner: id }, observed = [flowBaseReference("R1", "audioText", 0, 1)];
    const bytes = encodeSharedState(handle), vector = encodeSharedStateVector(handle), revision = readSharedRevision(handle), updates: Uint8Array[] = [];
    const stop = deliveryReplica(handle).onLocalUpdate(update => updates.push(update));
    for (const bad of [
      { kind: "text-insert", target: targetB, at: { left: null, right: flowBaseReference("R1", "audioText", 0), affinity: "before" }, content: [{ value: "X", marks: [] }] },
      { kind: "text-delete", target: targetB, observed }, { kind: "mark", target: targetB, observed, mark: { kind: "b", value: true } }
    ]) {
      const result = executeSharedOperations(handle, [operation({ ...bad, id: "wrong-owner", by: "Writer" })], { base: revision });
      assert.ok(!result.ok); assert.equal(result.reason, "mismatched-target");
      assert.deepEqual(encodeSharedState(handle), bytes); assert.deepEqual(encodeSharedStateVector(handle), vector); assert.equal(readSharedRevision(handle), revision); assert.equal(updates.length, 0);
    }
    stop(); assert.deepEqual(executeSharedOperations(handle, [type("valid", id, "X")], { base: revision }), { ok: true });
    assert.equal(read(handle).rows.find(row => row.id === id)?.text, "Xcd");
  } finally { set.close(); }
});

test("heading-bound creation and insertion beside partial segments refuse before writing", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "abcd" }], sections: [{ id: "H1", name: "Heading", firstSceneId: "R1" }] }), handle = set.a;
  try {
    registerSharedSplitHandlers(handle);
    const create = (left: string | null, right: string | null) => operation({ kind: "segment-create", id: "create", by: "Writer", beat: "new", segment: "new", fields: {}, at: { left, right, affinity: "before" } });
    const refuse = (command: ReturnType<typeof operation>, reason: string) => {
      const bytes = encodeSharedState(handle), vector = encodeSharedStateVector(handle), revision = readSharedRevision(handle);
      const result = executeSharedOperations(handle, [command], { base: revision }); assert.ok(!result.ok); assert.equal(result.reason, reason);
      assert.deepEqual(encodeSharedState(handle), bytes); assert.deepEqual(encodeSharedStateVector(handle), vector); assert.equal(readSharedRevision(handle), revision);
    };
    refuse(operation({ ...split(), kind: "split-before", target: { owner: "H1", segment: "h:H1", field: "heading" } }), "invalid-split-target");
    refuse(create(null, "R1"), "heading-placement-required");
    assert.deepEqual(executeSharedOperations(handle, [split()], { base: readSharedRevision(handle) }), { ok: true });
    refuse(create("R1", null), "partial-segment-gap");
  } finally { set.close(); }
});

test("split reads only its touched segment and beat regardless of unrelated beat count", t => {
  const counts: number[] = [];
  for (const unrelated of [0, 10000]) {
    const set = replicas(2, { rows: [{ id: "R1", audioText: "abcd" }] }), handle = set.a;
    try {
      transactSharedDocument(handle, "local-command", () => { for (let index = 0; index < unrelated; index++) collabState(handle).roots.beats.set("unrelated" + index, { status: "todo" }); });
      let reads = 0;
      registerSharedOperationHandlers(handle, { split: (op, view) => prepareSharedBeatSplit(op, { ...view,
        get: path => { reads++; assert.ok(path[0] === "beats" || path[0] === "segments"); return view.get(path); },
        keys: () => { throw new Error("whole root scan"); }
      }) });
      assert.deepEqual(executeSharedOperations(handle, [split()], { base: readSharedRevision(handle) }), { ok: true }); counts.push(reads);
    } finally { set.close(); }
  }
  assert.deepEqual(counts, [3, 3]); t.diagnostic(JSON.stringify({ unrelated: [0, 10000], reads: counts }));
});

test("planned segment creation uses cached order positions with zero whole-order reads", t => {
  const counts: number[] = [];
  for (const unrelated of [0, 10000]) {
    const set = replicas(2, { rows: [{ id: "R1", audioText: "abcd" }] }), handle = set.a;
    try {
      const native = collabState(handle).roots.order;
      transactSharedDocument(handle, "local-command", () => { for (let index = 0; index < unrelated; index++) native.push(["unrelated" + index]); });
      const order = observeSharedStructureOrder(handle); let reads = 0;
      registerSharedOperationHandlers(handle, { "segment-create": (op, view) => {
        const result = prepareSharedSegmentCreation(op, { ...view, get: path => { reads++; return view.get(path); } }, order);
        assert.ok(result.ok && Object.isFrozen(result.description) && Object.isFrozen(result.description.writes) && Object.isFrozen(result.description.text)); return result;
      } });
      const whole = mock.method(native, "toArray", () => { throw new Error("whole-order read during execution"); });
      try {
        const create = (id: string, beat: string, left: string | null, right: string | null) => operation({ kind: "segment-create", id, by: "Writer", beat, segment: beat,
          at: { left, right, affinity: "before" }, fields: { audioText: "", visualText: "", status: "todo" } });
        assert.deepEqual(executeSharedOperations(handle, [create("one", "one-beat", null, "R1"), create("two", "two-beat", "one-beat", "R1")]), { ok: true });
        counts.push(reads); assert.equal(whole.mock.callCount(), 0);
      } finally { whole.mock.restore(); }
      assert.deepEqual(native.toArray().slice(0, 3), [JSON.stringify(["structure", "1", "one", "segment"]), JSON.stringify(["structure", "1", "two", "segment"]), "b:R1"]);
    } finally { set.close(); }
  }
  assert.deepEqual(counts, [9, 9]); t.diagnostic(JSON.stringify({ unrelatedOrderEntries: [0, 10000], prepareGets: counts, executionWholeOrderReads: 0 }));
});

for (const phase of ["idle", "prepare", "observer"] as const) test(`apply text creation refuses ${phase}`, () => {
  const handle = createMonitoredSharedDocument();
  try {
    hydrateSharedDocument(handle, validatedFixture({ rows: [{ id: "R1", audioText: "abcd" }] }));
    const attempt = () => applySharedTextCreation(handle, Object.freeze({ path: Object.freeze(["meta"]), title: true }));
    if (phase === "idle") assert.throws(attempt, SharedExecutionWriteError);
    else {
      registerSharedOperationHandlers(handle, { "segment-create": () => { attempt(); return { ok: false, reason: "unreachable" }; } });
      if (phase === "observer") collabState(handle).doc.once("afterTransaction", attempt);
      assert.throws(() => executeSharedOperations(handle, [phase === "prepare" ? operation({ kind: "segment-create", id: "create", by: "A", beat: "new", segment: "new", fields: {}, at: { left: null, right: null, affinity: "before" } })
        : operation({ kind: "scalar", id: "scalar", by: "A", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 7 })]), SharedExecutionWriteError);
    }
    assert.equal(((collabState(handle).roots.meta.get("title")) as Y.Text).toString(), "");
  } finally { destroySharedDocument(handle); }
});

test("new text and mark store attach together through a frozen description; occupied keys refuse in prepare", () => {
  const handle = createMonitoredSharedDocument();
  try {
    registerSharedOperationHandlers(handle, { "segment-create": (_op, view) => {
      const result = prepareSharedTextCreation(view, ["meta"]); assert.ok(result.ok);
      assert.ok(Object.isFrozen(result.description) && Object.isFrozen(result.description.path) && Object.isFrozen(result.writes)); return result;
    } });
    const command = operation({ kind: "segment-create", id: "create", by: "A", beat: "new", segment: "new", fields: {}, at: { left: null, right: null, affinity: "before" } });
    const origins: unknown[] = [], stop = observeSharedTransactions(handle, origin => origins.push(origin));
    assert.deepEqual(executeSharedOperations(handle, [command]), { ok: true }); assert.deepEqual(origins, ["local-command"]); stop();
    assert.ok(collabState(handle).roots.meta.get("text") instanceof Y.Text); assert.ok(collabState(handle).roots.meta.get("markRecords") instanceof Y.Map);
    for (const key of ["text", "markRecords"]) {
      const value = collabState(handle).roots.meta.get(key);
      transactSharedDocument(handle, "local-command", () => collabState(handle).roots.meta.delete(key));
      const prep = createSharedPreparation(handle); assert.deepEqual(prepareSharedTextCreation(prep.view, ["meta"]), { ok: false, reason: "existing-text-or-store" }); prep.close();
      transactSharedDocument(handle, "local-command", () => collabState(handle).roots.meta.set(key, value instanceof Y.Text ? new Y.Text() : new Y.Map<unknown>()));
    }
  } finally { destroySharedDocument(handle); }
});
