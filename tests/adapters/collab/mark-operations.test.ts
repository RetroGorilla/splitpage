import test, { mock } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { createMonitoredSharedDocument, validatedFixture, deliveryReplica } from "./helpers.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { destroySharedDocument, encodeSharedState, encodeSharedStateVector, observeSharedTransactions, transactSharedDocument, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { registerSharedOperationHandlers } from "../../../src/adapters/collab/operation-handlers.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { prepareSharedMarkChange } from "../../../src/adapters/collab/mark-executor.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { sharedTextCommandPlan, sharedTextLocation } from "../../../src/adapters/collab/executor-text-plan.ts";
import { captureSharedTextRange } from "../../../src/adapters/collab/executor-references.ts";
import { readSharedMarkCharacters } from "../../../src/adapters/collab/mark-store.ts";
import { sharedMarkRecordKey } from "../../../src/adapters/collab/mark-record.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import type { SharedTextAddress } from "../../../src/core/collab/operations.ts";
import { markTraceKinds, markTraceExample } from "./marks/replica.ts";
import { operation, ref } from "./executor-support.ts";
import { Stage1ExecutorHarness } from "./stage1-executor-support.ts";
import { deliveryOrders } from "../../collab/delivery.ts";

function fixture(register = true) {
  const handle = createMonitoredSharedDocument(); collabState(handle).doc.clientID = 1;
  hydrateSharedDocument(handle, validatedFixture({ title: "Title", rows: [{ id: "R1", audioText: "abcd", visualText: "wxyz" }], sections: [{ id: "H1", name: "Name", firstSceneId: "R1" }] }));
  if (register) registerSharedTextOperationHandlers(handle); return handle;
}
function address(handle: SharedDocumentHandle, field: SharedTextAddress["field"]): SharedTextAddress {
  const owner = field === "title" ? String(collabState(handle).roots.meta.get("docId")) : field === "heading" ? "H1" : "R1";
  return { owner: ref(owner), segment: ref(owner), field };
}
function range(handle: SharedDocumentHandle, target: SharedTextAddress, from: number, to: number) { const result = captureSharedTextRange(handle, target, from, to); assert.ok(result); return result; }
function read(handle: SharedDocumentHandle, target: SharedTextAddress) {
  const prep = createSharedPreparation(handle), located = sharedTextLocation(prep.view, target); prep.close();
  const result = readSharedMarkCharacters(handle, located.target); assert.ok(result); return result;
}

test("reversed native spans refuse alone, after 50 marks and before planned deletion can collapse their endpoints", () => {
  for (const prefix of ["alone", "marks", "deletion"] as const) {
    const handle = fixture();
    try {
      const target = address(handle, "audioText"), observed = range(handle, target, 1, 3), span = JSON.parse(observed) as unknown[];
      [span[2], span[3]] = [span[3], span[2]];
      const mark = (id: string, reference: string) => operation({ kind: "mark", id, by: "A", target, observed: [reference], mark: { kind: "b", value: true } });
      const before = encodeSharedState(handle), vector = encodeSharedStateVector(handle), revision = readSharedRevision(handle), updates: Uint8Array[] = [];
      const stop = deliveryReplica(handle).onLocalUpdate(bytes => updates.push(bytes));
      const commands = prefix === "marks" ? Array.from({ length: 50 }, (_, index) => mark("valid" + index, observed))
        : prefix === "deletion" ? [operation({ kind: "text-delete", id: "delete", by: "A", target, observed: [observed] })] : [];
      const rejected = mark("reversed", JSON.stringify(span));
      assert.deepEqual(executeSharedOperations(handle, [...commands, rejected]), { ok: false, index: commands.length, operation: rejected, reason: "invalid-reference" });
      assert.deepEqual(encodeSharedState(handle), before); assert.deepEqual(encodeSharedStateVector(handle), vector);
      assert.equal(readSharedRevision(handle), revision); assert.equal(updates.length, 0); stop();
    } finally { destroySharedDocument(handle); }
  }
});

test("legitimate native spans collapsed by planned or committed deletion remain accepted", () => {
  for (const separate of [false, true]) {
    const handle = fixture();
    try {
      const target = address(handle, "audioText"), observed = range(handle, target, 1, 3);
      const deletion = operation({ kind: "text-delete", id: "delete", by: "A", target, observed: [observed] });
      const mark = operation({ kind: "mark", id: "collapsed", by: "A", target, observed: [observed], mark: { kind: "b", value: true } });
      if (separate) assert.deepEqual(executeSharedOperations(handle, [deletion]), { ok: true });
      assert.deepEqual(executeSharedOperations(handle, separate ? [mark] : [deletion, mark]), { ok: true });
      assert.deepEqual(read(handle, target).map(char => [char.value, char.marks]), [["a", []], ["d", []]]);
    } finally { destroySharedDocument(handle); }
  }
});

for (const field of ["audioText", "visualText", "heading", "title"] as const) test(`all mark additions and removals share one transaction on ${field}`, () => {
  const handle = fixture();
  try {
    const target = address(handle, field), both = range(handle, target, 0, 2), first = range(handle, target, 0, 1);
    const textBefore = read(handle, target).map(char => char.value).join(""), roots = collabState(handle).roots;
    const records = [roots.comments, roots.tags, roots.people, roots.shots, roots.replies, roots.gallery], recordsBefore = JSON.stringify(records.map(root => root.toJSON()));
    const adds = markTraceKinds.map(kind => operation({ kind: "mark", id: "add:" + kind, by: "A", target, observed: [both], mark: markTraceExample(kind) }));
    const removes = markTraceKinds.map(kind => operation({ kind: "mark", id: "remove:" + kind, by: "A", target, observed: [first], mark: { ...markTraceExample(kind), value: null } }));
    const updates: Uint8Array[] = [], origins: unknown[] = [], stop = deliveryReplica(handle).onLocalUpdate(bytes => updates.push(bytes)), detach = observeSharedTransactions(handle, origin => origins.push(origin));
    assert.deepEqual(executeSharedOperations(handle, [...adds, ...removes]), { ok: true }); stop(); detach();
    const chars = read(handle, target); assert.deepEqual(chars[0]?.marks, []); assert.deepEqual(chars[1]?.marks.map(group => group.kind).sort(), [...markTraceKinds].sort());
    assert.equal(chars.map(char => char.value).join(""), textBefore); assert.equal(JSON.stringify(records.map(root => root.toJSON())), recordsBefore);
    assert.ok(chars.slice(2).every(char => char.marks.length === 0)); assert.equal(updates.length, 1); assert.deepEqual(origins, ["local-command"]);
    assert.deepEqual([...new Set(Y.decodeUpdate(updates[0] as Uint8Array).structs.map(item => item.id.client))], [1]);
    assert.equal(collabState(handle).roots.comments.size, 0); assert.equal(collabState(handle).roots.tags.size, 0);
  } finally { destroySharedDocument(handle); }
});

test("mark prepare freezes a fixed description, observes active planned additions and retains no scratch dependency", () => {
  const handle = fixture(false);
  try {
    const target = address(handle, "audioText"), left = range(handle, target, 0, 1), right = range(handle, target, 2, 3), descriptions: unknown[] = [];
    const frozen = (value: unknown): void => { if (value && typeof value === "object") { assert.equal(Object.isFrozen(value), true); for (const child of Object.values(value)) frozen(child); } };
    registerSharedOperationHandlers(handle, { mark: (command, view) => {
      const prepared = prepareSharedMarkChange(command, view); assert.ok(prepared.ok); frozen(prepared.description); frozen(prepared.writes); descriptions.push(prepared.description);
      if (command.id === "remove") {
        const step = prepared.description.steps[0]; assert.ok(step?.kind === "mark" && step.plan.change.type === "remove");
        assert.deepEqual(step.plan.change.observed, [sharedMarkRecordKey(JSON.stringify(["range-mark", "right", 0]), 1)]);
        const observed = step.plan.change.observed;
        assert.throws(() => { (observed as string[]).push("bad"); }, TypeError);
        const scratch = sharedTextCommandPlan(view, command.target); scratch.units.length = 0; scratch.additions.length = 0; scratch.sources.length = 0;
      }
      return prepared;
    } });
    const mark = (id: string, observed: string, value: true | null) => operation({ kind: "mark", id, by: "A", target, observed: [observed], mark: { kind: "b", value } });
    assert.deepEqual(executeSharedOperations(handle, [mark("left", left, true), mark("right", right, true), mark("remove", right, null)]), { ok: true });
    assert.equal(descriptions.length, 3); assert.deepEqual(read(handle, target).map(char => [char.value, char.marks.map(group => group.kind)]), [["a", ["b"]], ["b", []], ["c", []], ["d", []]]);
  } finally { destroySharedDocument(handle); }
});

test("late invalid mark ids or foreign ranges refuse the entire list without delivered writes", () => {
  const handle = fixture();
  try {
    const target = address(handle, "audioText"), own = range(handle, target, 0, 2), foreign = range(handle, address(handle, "visualText"), 0, 2), before = encodeSharedState(handle), vector = encodeSharedStateVector(handle);
    const updates: Uint8Array[] = [], stop = deliveryReplica(handle).onLocalUpdate(bytes => updates.push(bytes));
    const first = operation({ kind: "mark", id: "first", by: "A", target, observed: [own], mark: { kind: "i", value: true } });
    for (const last of [operation({ kind: "mark", id: "foreign", by: "A", target, observed: [foreign], mark: { kind: "b", value: true } }),
      operation({ kind: "mark", id: "bad", by: "A", target, observed: [own], mark: { kind: "tag", id: "T\ufffd", value: "P" } }),
      operation({ kind: "mark", id: "payload", by: "A", target, observed: [own], mark: { kind: "tag", id: "T", value: "P\ufffd" } }), first]) {
      const result = executeSharedOperations(handle, [first, last]); assert.ok(!result.ok); assert.equal(result.index, 1);
      assert.deepEqual(encodeSharedState(handle), before); assert.deepEqual(encodeSharedStateVector(handle), vector); assert.deepEqual(updates, []);
    }
    stop();
  } finally { destroySharedDocument(handle); }
});

test("duplicate command ids on two writers preserve both additions in either client assignment", () => {
  for (const swap of [false, true]) for (const order of deliveryOrders) {
    const h = new Stage1ExecutorHarness([{ id: "R1", text: "abcd" }]);
    try {
      collabState(h.a).doc.clientID = swap ? 2 : 1; collabState(h.b).doc.clientID = swap ? 1 : 2;
      const a = operation({ kind: "mark", id: "same", by: "A", target: h.target("R1"), observed: [h.range("A", "R1", 0, 1)], mark: { kind: "b", value: true } });
      const b = operation({ kind: "mark", id: "same", by: "B", target: h.target("R1"), observed: [h.range("B", "R1", 3, 4)], mark: { kind: "i", value: true } });
      if (order === "D3") { h.execute("B", [b]); h.queue.deliverFrom("B", order); h.execute("A", [a]); }
      else { h.execute("A", [a]); if (order === "D2" || order === "late-C") h.queue.flush(order); if (order === "late-C") h.join(); h.execute("B", [b]); }
      h.check(order, { rows: [{ id: "R1", characters: [["s1", "a", { b: true }], ["s2", "b", {}], ["s3", "c", {}], ["s4", "d", { i: true }]] }], carets: {}, recovery: [] });
    } finally { h.destroy(); }
  }
});

test("range mark preparation reads one cached text and no whole root", () => {
  const counts: number[] = [];
  for (const size of [0, 10000]) {
    const handle = fixture();
    try {
      const target = address(handle, "audioText"), observed = range(handle, target, 1, 3);
      transactSharedDocument(handle, "local-command", () => { for (let index = 0; index < size; index++) collabState(handle).roots.people.set("P" + index, { name: "unrelated" }); });
      const reads = mock.method(Y.Text.prototype, "toDelta"), gets = mock.method(Y.Doc.prototype, "get"), restores: (() => void)[] = [];
      for (const root of Object.values(collabState(handle).roots)) {
        if (root instanceof Y.Map) for (const method of ["keys", "entries", "values", "forEach", "toJSON", Symbol.iterator] as const) { const spy = mock.method(root, method, () => { throw new Error("Whole root read"); }); restores.push(() => spy.mock.restore()); }
        else { const spy = mock.method(root, "toArray", () => { throw new Error("Whole root read"); }); restores.push(() => spy.mock.restore()); }
      }
      try {
        const commands = [true, null].map((value, index) => operation({ kind: "mark", id: "mark" + index, by: "A", target, observed: [observed], mark: { kind: "b", value } }));
        assert.deepEqual(executeSharedOperations(handle, commands), { ok: true }); counts.push(reads.mock.callCount()); assert.equal(gets.mock.callCount(), 0);
      } finally { reads.mock.restore(); gets.mock.restore(); restores.forEach(restore => restore()); }
    } finally { destroySharedDocument(handle); }
  }
  assert.deepEqual(counts, [2, 2]);
});

for (const kind of ["comment", "tag", "link"] as const) test(`two writers give ${kind} additions distinct native occurrences and remove only observed additions`, () => {
  const literal: Readonly<Record<string, string | boolean>> = kind === "comment" ? { "c:C": true } : kind === "tag" ? { tag: "P" } : { href: "https://x" };
  let runs = 0;
  for (const swap of [false, true]) for (const order of deliveryOrders) {
    const h = new Stage1ExecutorHarness([{ id: "R1", text: "abcd" }]);
    try {
      collabState(h.a).doc.clientID = swap ? 2 : 1; collabState(h.b).doc.clientID = swap ? 1 : 2;
      const mark = markTraceExample(kind), a = range(h.a, h.target("R1"), 1, 3), b = range(h.b, h.target("R1"), 2, 4), all = range(h.a, h.target("R1"), 0, 4);
      const add = (observed: string) => operation({ kind: "mark", id: "same", by: "Writer", target: h.target("R1"), observed: [observed], mark });
      const writeA = () => h.execute("A", [add(a), operation({ kind: "mark", id: "remove", by: "A", target: h.target("R1"), observed: [all], mark: { ...mark, value: null } })]);
      const writeB = () => h.execute("B", [add(b)]);
      if (order === "D3") { writeB(); h.queue.deliverFrom("B", order); writeA(); }
      else { writeA(); if (order === "D2" || order === "late-C") h.queue.flush(order); if (order === "late-C") h.join(); writeB(); }
      const surviving = order === "D3" ? {} : literal;
      h.check(order, { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["s3", "c", surviving], ["s4", "d", surviving]] }], carets: {}, recovery: [] });
      for (const handle of [h.a, h.b, h.c]) {
        const prep = createSharedPreparation(handle), facade = prep.view.text(["segments", "b:R1", "text"]); assert.ok(facade); prep.close();
        const ids = facade.records.flatMap(item => item.record.type === "add" && "id" in item.record.mark ? [item.record.mark.id] : []).sort();
        assert.deepEqual(ids, ['["mark-occurrence","1","same",0]', '["mark-occurrence","2","same",0]']);
      }
      runs++;
    } finally { h.destroy(); }
  }
  assert.equal(runs, 12);
});
