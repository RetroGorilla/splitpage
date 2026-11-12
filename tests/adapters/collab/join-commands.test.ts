import test, { mock } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, agree, operation } from "./executor-support.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { observeSharedStructureIndex } from "../../../src/adapters/collab/structure-index.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { encodeSharedState, encodeSharedStateVector, readSharedRevision, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { deliveryReplica } from "./helpers.ts";
import { readOperation } from "../../../src/core/collab/read-operation.ts";
import { trapSharedCollectionWalks } from "./collection-guards.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";

const source = { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }, { id: "R3", audioText: "ef" }] };
const first = "structure_1_006a006f0069006e_join_0", second = "structure_2_006a006f0069006e_join_0";
const join = () => operation({ kind: "join", id: "join", by: "Alice", from: "R2", into: "R1", glue: " " });
const change = (kind: "join-glue" | "join-retire", joins: string[], glue = "") => operation({ kind, id: "change", by: "Writer", joins, ...(kind === "join-glue" ? { glue } : {}) });
const read = (handle: Parameters<typeof collabState>[0]) => projectSharedDocumentWithRecovery(handle).document.rows.map(row => [row.id, row.audioText]);
const entries = (handle: Parameters<typeof collabState>[0]) => Object.fromEntries([...((collabState(handle).roots.beats.get("R2") as Y.Map<unknown>).get("joins") as Y.Map<unknown>)].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));

test("join retirement has an explicit validated operation instead of changing issued entries", () => {
  assert.deepEqual(readOperation({ kind: "join-retire", id: "undo", by: "Alice", joins: [first] }), { kind: "join-retire", id: "undo", by: "Alice", joins: [first] });
  for (const joins of [new Array(1), [null], [""], 1]) assert.equal(readOperation({ kind: "join-retire", id: "undo", by: "Alice", joins }), null);
});

for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) test(`glue command uses the scalar register winner without changing join selection: ${copies}/${order}`, () => {
  const set = replicas(copies, source), handles = [set.a, set.b, set.c].slice(0, copies);
  try {
    handles.forEach(registerSharedJoinHandlers);
    assert.deepEqual(executeSharedOperations(set.a, [join()]), { ok: true }); set.queue.flush("D1");
    const issued = entries(set.a);
    handles.forEach((handle, index) => assert.deepEqual(executeSharedOperations(handle, [change("join-glue", [first], index === 1 ? " " : ""),
      operation({ kind: "scalar", id: "control", by: "Writer", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: index === 1 ? 20 : 10 })]), { ok: true }));
    set.queue.flush(order);
    agree("glue scalar winner", order, handles, read, [["R1", copies === 2 ? "ab cd" : "abcd"], ["R3", "ef"]]);
    agree("scalar control", order, handles, handle => (collabState(handle).roots.beats.get("R1") as Y.Map<unknown>).get("lengthSeconds"), copies === 2 ? 20 : 10);
    agree("issued entries unchanged", order, handles, entries, issued);
    assert.deepEqual(executeSharedOperations(set.a, [change("join-glue", [first], " ")]), { ok: true }); set.queue.flush("dup");
    agree("causal lower writer set", order, handles, read, [["R1", "ab cd"], ["R3", "ef"]]);
  } finally { set.close(); }
});

for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) for (const early of [false, true]) test(`either identical join can retire one effect, including before delivery: ${copies}/${order}/${early}`, () => {
  const set = replicas(copies, source), handles = [set.a, set.b, set.c].slice(0, copies);
  try {
    handles.forEach(registerSharedJoinHandlers);
    for (const handle of handles) assert.deepEqual(executeSharedOperations(handle, [join()]), { ok: true });
    if (!early) set.queue.flush(order);
    assert.deepEqual(executeSharedOperations(set.b, [change("join-retire", [second])]), { ok: true }); set.queue.flush(order);
    agree("identical retirement", order, handles, read, [["R1", "ab"], ["R2", "cd"], ["R3", "ef"]]);
    const bytes = encodeSharedState(set.a), vector = encodeSharedStateVector(set.a), revision = readSharedRevision(set.a);
    assert.deepEqual(executeSharedOperations(set.a, [change("join-retire", [first])]), { ok: true });
    assert.deepEqual(encodeSharedState(set.a), bytes); assert.deepEqual(encodeSharedStateVector(set.a), vector); assert.equal(readSharedRevision(set.a), revision);
    assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "join", id: "fresh", by: "Alice", from: "R2", into: "R1", glue: " " }), change("join-retire", [first])]), { ok: true });
    set.queue.flush(order); agree("old retirement leaves fresh join", order, handles, read, [["R1", "ab cd"], ["R3", "ef"]]);
    assert.equal(Object.keys(entries(set.a)).length, copies + 1);
  } finally { set.close(); }
});

test("staged join aliases support a register set and retirement in one transaction", () => {
  const set = replicas(2, source);
  try {
    registerSharedJoinHandlers(set.a); let updates = 0, transactions = 0;
    const stop = deliveryReplica(set.a).onLocalUpdate(() => updates++), observe = () => { transactions++; };
    collabState(set.a).doc.on("afterTransaction", observe);
    try {
      assert.deepEqual(executeSharedOperations(set.a, [join(), change("join-glue", ["join"]), change("join-retire", ["join"])]), { ok: true });
      assert.deepEqual([updates, transactions], [1, 1]);
      assert.deepEqual(read(set.a), [["R1", "ab"], ["R2", "cd"], ["R3", "ef"]]);
      assert.deepEqual(entries(set.a), { [first]: { into: "R1", glue: " ", by: "Alice", operation: "join", generation: 0 } });
    } finally { stop(); collabState(set.a).doc.off("afterTransaction", observe); }
  } finally { set.close(); }
});

test("join preparation resolves a beat created by an earlier split in the same list", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "abcd" }] });
  try {
    registerSharedSplitHandlers(set.a, createFlowLoadRuntime()); registerSharedJoinHandlers(set.a);
    assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "split", id: "split", by: "Alice", target: { owner: "R1", segment: "R1", field: "audioText" },
      at: { left: null, right: flowBaseReference("R1", "audioText", 2), affinity: "before" }, observed: [], boundary: "fresh", beat: "fresh", fields: {} }),
      operation({ kind: "join", id: "join", by: "Alice", from: "fresh", into: "R1", glue: "" })], { base: readSharedRevision(set.a) }), { ok: true });
    set.queue.flush("dup"); agree("staged beat joined", "dup", [set.a, set.b], read, [["R1", "abcd"]]);
    const beat = collabState(set.a).roots.beats.get("structure_1_00730070006c00690074_beat_0"); assert.ok(beat instanceof Y.Map);
    assert.deepEqual((beat.get("joins") as Y.Map<unknown>).get(first), { into: "R1", glue: "", by: "Alice", operation: "join", generation: 0 });
  } finally { set.close(); }
});

test("late join refusals preserve the whole list and all document counters", () => {
  const cases = [
    { operation: { kind: "join", id: "join", by: "Alice", from: "missing", into: "R1", glue: " " }, reason: "missing-join-target" },
    { operation: { kind: "join-glue", id: "bad", by: "Alice", joins: ["missing"], glue: "" }, reason: "missing-join" },
    { operation: { kind: "join-retire", id: "bad", by: "Alice", joins: ["missing"] }, reason: "missing-join" },
    { operation: { kind: "join", id: "bad:operation", by: "Alice", from: "R2", into: "R1", glue: " " }, reason: "invalid-structure-operation-id" },
    { operation: { kind: "join-glue", id: "bad:operation", by: "Alice", joins: ["join"], glue: "" }, reason: "invalid-structure-operation-id" },
    { operation: { kind: "join-retire", id: "bad:operation", by: "Alice", joins: ["join"] }, reason: "invalid-structure-operation-id" },
    { operation: { kind: "join", id: "join", by: "Alice", from: "R3", into: "R1", glue: " " }, reason: "existing-join" }
  ];
  for (const sample of cases) {
    const set = replicas(2, source);
    try {
      registerSharedJoinHandlers(set.a); const bytes = encodeSharedState(set.a), vector = encodeSharedStateVector(set.a), revision = readSharedRevision(set.a);
      let updates = 0, transactions = 0; const stop = deliveryReplica(set.a).onLocalUpdate(() => updates++), observe = () => { transactions++; };
      collabState(set.a).doc.on("afterTransaction", observe);
      try {
        const result = executeSharedOperations(set.a, [join(), operation(sample.operation)], { base: revision }); assert.ok(!result.ok && "index" in result);
        assert.equal(result.reason, sample.reason); assert.equal(result.index, 1);
        assert.deepEqual(encodeSharedState(set.a), bytes); assert.deepEqual(encodeSharedStateVector(set.a), vector); assert.equal(readSharedRevision(set.a), revision); assert.deepEqual([updates, transactions], [0, 0]);
      } finally { stop(); collabState(set.a).doc.off("afterTransaction", observe); }
    } finally { set.close(); }
  }
});

test("join lookup patches map replacements and split entry changes without scanning unrelated beats", () => {
  const set = replicas(2, source);
  try {
    const index = observeSharedStructureIndex(set.a).joins(), root = collabState(set.a).roots.beats;
    const joins = (root.get("R2") as Y.Map<unknown>).get("joins"); assert.ok(joins instanceof Y.Map);
    transactSharedDocument(set.a, "hydration", () => joins.set("native", { into: "R1", glue: "" })); assert.deepEqual(index.locations("native"), ["R2"]);
    transactSharedDocument(set.a, "hydration", () => (root.get("R2") as Y.Map<unknown>).set("joins", new Y.Map())); assert.deepEqual(index.locations("native"), []);
    transactSharedDocument(set.a, "hydration", () => root.delete("R2")); assert.deepEqual(index.locations("native"), []);
  } finally { set.close(); }
});

test("join preparation rejects non-record containers without expanding their text or array", () => {
  for (const value of [new Y.Text("hidden"), new Y.Array<unknown>()]) {
    const set = replicas(2, source);
    try {
      const joins = (collabState(set.a).roots.beats.get("R2") as Y.Map<unknown>).get("joins"); assert.ok(joins instanceof Y.Map);
      transactSharedDocument(set.a, "hydration", () => joins.set("bad", value)); registerSharedJoinHandlers(set.a);
      const inspect = value instanceof Y.Text ? mock.method(value, "toDelta", () => { throw new Error("Unneeded text expansion"); })
        : mock.method(value, "toArray", () => { throw new Error("Unneeded array expansion"); });
      try {
        assert.deepEqual(executeSharedOperations(set.a, [join()]), { ok: true });
        const bytes = encodeSharedState(set.a), vector = encodeSharedStateVector(set.a), revision = readSharedRevision(set.a);
        const result = executeSharedOperations(set.a, [change("join-glue", ["bad"])]); assert.ok(!result.ok);
        assert.equal(result.reason, "missing-join"); assert.equal(inspect.mock.callCount(), 0);
        assert.deepEqual(encodeSharedState(set.a), bytes); assert.deepEqual(encodeSharedStateVector(set.a), vector); assert.equal(readSharedRevision(set.a), revision);
      } finally { inspect.mock.restore(); }
    } finally { set.close(); }
  }
});

test("join value guards cover ids, separator registers and both retirement flags", () => {
  for (const kind of ["join-glue", "join-retire"] as const) for (const slot of ["id", "register", "flag", "group"] as const) for (const type of ["text", "array"]) {
    const set = replicas(2, source);
    try {
      registerSharedJoinHandlers(set.a); assert.deepEqual(executeSharedOperations(set.a, [join()]), { ok: true });
      const roots = collabState(set.a).roots, container = slot === "id" ? roots.beats.get("R2") : slot === "register" ? roots.meta : roots.retiredJoins;
      assert.ok(container instanceof Y.Map);
      const key = slot === "id" ? "id" : slot === "register" ? "joinGlue:" + first : slot === "flag" ? first : '["join-retirement","R2","R1"," ",0]';
      const value = type === "text" ? new Y.Text("hidden") : new Y.Array<unknown>();
      transactSharedDocument(set.a, "hydration", () => container.set(key, value));
      const inspect = value instanceof Y.Text ? mock.method(value, "toDelta", () => { throw new Error("Unneeded text expansion"); })
        : mock.method(value, "toArray", () => { throw new Error("Unneeded array expansion"); });
      try {
        const bytes = encodeSharedState(set.a), vector = encodeSharedStateVector(set.a), revision = readSharedRevision(set.a);
        const result = executeSharedOperations(set.a, [change(kind, [first])]);
        if (slot === "id") { assert.ok(!result.ok); assert.equal(result.reason, "missing-join");
          assert.deepEqual(encodeSharedState(set.a), bytes); assert.deepEqual(encodeSharedStateVector(set.a), vector); assert.equal(readSharedRevision(set.a), revision);
        } else assert.deepEqual(result, { ok: true });
        assert.equal(inspect.mock.callCount(), 0);
      } finally { inspect.mock.restore(); }
    } finally { set.close(); }
  }
});

test("glue changes leave a selected competing target unchanged and an unselected target inert", () => {
  const set = replicas(2, source);
  try {
    [set.a, set.b].forEach(registerSharedJoinHandlers);
    assert.deepEqual(executeSharedOperations(set.a, [join()]), { ok: true });
    assert.deepEqual(executeSharedOperations(set.b, [operation({ ...join(), into: "R3" })]), { ok: true }); set.queue.flush("dup");
    const issued = entries(set.a);
    assert.deepEqual(executeSharedOperations(set.b, [change("join-glue", [second])]), { ok: true }); set.queue.flush("rev");
    agree("unselected glue is inert", "rev", [set.a, set.b], read, [["R1", "ab cd"], ["R3", "ef"]]);
    assert.deepEqual(executeSharedOperations(set.b, [change("join-glue", [first])]), { ok: true }); set.queue.flush("dup");
    agree("selected target unchanged", "dup", [set.a, set.b], read, [["R1", "abcd"], ["R3", "ef"]]);
    agree("original join entries retained", "dup", [set.a, set.b], entries, issued);
  } finally { set.close(); }
});

test("glue and retirement preparation reads stay constant with unrelated beats and order entries", t => {
  const counts: number[][] = [];
  for (const kind of ["join-glue", "join-retire"] as const) {
    const measured: number[] = [];
    for (const unrelated of [0, 10000]) {
      const set = replicas(2, source);
      try {
        const roots = collabState(set.a).roots;
        transactSharedDocument(set.a, "hydration", () => { for (let index = 0; index < unrelated; index++) { roots.beats.set("unrelated" + index, {}); roots.order.push(["unrelated" + index]); } });
        registerSharedJoinHandlers(set.a); assert.deepEqual(executeSharedOperations(set.a, [join()]), { ok: true });
        let reads = 0; const get = roots.beats.get.bind(roots.beats), inspect = mock.method(roots.beats, "get", (key: string) => { reads++; return get(key); });
        const restore = trapSharedCollectionWalks(roots.beats, roots.segments, roots.headings, roots.order);
        try { assert.deepEqual(executeSharedOperations(set.a, [change(kind, [first])]), { ok: true }); measured.push(reads); }
        finally { inspect.mock.restore(); restore(); }
      } finally { set.close(); }
    }
    counts.push(measured);
  }
  assert.deepEqual(counts, [[4, 4], [4, 4]]); t.diagnostic(JSON.stringify({ unrelated: [0, 10000], glue: counts[0], retirement: counts[1], wholeCollectionWalks: 0 }));
});
