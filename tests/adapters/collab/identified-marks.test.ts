import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { beatPos, setMarkAcross } from "../../../src/core/flow/flow.ts";
import { readMarkChange } from "../../../src/core/collab/read-operation.ts";
import { prepareSharedMarkTranslation } from "../../../src/adapters/collab/mark-translation.ts";
import { readSharedStoredMark } from "../../../src/adapters/collab/stored-mark.ts";
import { prepareSharedMarkRecord, writeSharedMarkRecord, readSharedMarkCharacters } from "../../../src/adapters/collab/mark-store.ts";
import { readSharedMarkRecord, sharedMarkRecordKey } from "../../../src/adapters/collab/mark-record.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState, readSharedRevision, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { registerSharedOperationHandlers } from "../../../src/adapters/collab/operation-handlers.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { prepareTextMarkWrite, preparedTextDescription } from "../../../src/adapters/collab/text-description.ts";
import { sharedTextCommandPlan } from "../../../src/adapters/collab/executor-text-plan.ts";
import { resolveSharedTextReference } from "../../../src/adapters/collab/executor-references.ts";
import { createMonitoredSharedDocument, validatedFixture } from "./helpers.ts";
import { operation, ref } from "./executor-support.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import { DeliveryQueue } from "../../collab/delivery.ts";
import { deliveryReplica } from "./helpers.ts";

const target = Object.freeze({ owner: ref("R1"), segment: ref("b:R1"), field: "audioText" as const });

test("wire comments remain boolean while stored comments require stable anchor payloads", () => {
  const input = { kind: "mark", id: "op", by: "A", target, observed: [], mark: { kind: "comment", id: "anchor1", value: true } };
  assert.ok(readMarkChange(input)); assert.equal(readMarkChange({ ...input, mark: { ...input.mark, value: "anchor1" } }), null);
  assert.deepEqual(readSharedStoredMark({ kind: "comment", id: "occurrence", value: "anchor1" }), { id: "occurrence", kind: "comment", value: "anchor1" });
  for (const mark of [{ kind: "comment", id: "C1", value: true }, { kind: "comment", id: "native", value: "anchor\ufffd" },
    { kind: "comment", id: "native", value: "anchor\ud800" }, { kind: "comment", id: "native\ufffd", value: "anchor1" }]) assert.equal(readSharedStoredMark(mark), null);
});

test("one prepare translator derives occurrences and removes payload matches rather than native-id matches", () => {
  for (const kind of ["comment", "tag", "link"] as const) {
    const name = kind === "link" ? "https://name" : "name", other = kind === "link" ? "https://other" : "other";
    const wire = kind === "comment" ? { kind, id: ref(name), value: true as const } : { kind, id: ref(name), value: ref(other) };
    const translated = prepareSharedMarkTranslation(wire, "1", "op", [2, 3]);
    assert.deepEqual(translated, { type: "add", mark: { id: '["mark-occurrence","1","op",2,3]', kind, value: name } });
    assert.notDeepEqual(translated, prepareSharedMarkTranslation(wire, "2", "op", [2, 3]));
    assert.notDeepEqual(translated, prepareSharedMarkTranslation(wire, "1", "op", [2, 4]));
    const records = [{ identity: ref("R4"), mark: { kind, id: ref("native2"), value: ref(name) } },
      { identity: ref("R2"), mark: { kind, id: ref(name), value: ref(other) } }, { identity: ref("R1"), mark: { kind, id: ref("native1"), value: ref(name) } }];
    assert.deepEqual(prepareSharedMarkTranslation({ ...wire, value: null }, "1", "clear", [0], records), { type: "remove", observed: ["R1", "R4"] });
    assert.deepEqual(prepareSharedMarkTranslation({ ...wire, id: ref("absent"), value: null }, "1", "clear", [0], records), { type: "remove", observed: [] });
  }
  assert.deepEqual(prepareSharedMarkTranslation({ kind: "b", value: true }, "1", "bold", [0]), { type: "add", mark: { kind: "b", value: true } });
});

test("legacy boolean comment records are refused on authoring and ignored after replica transfer", () => {
  const a = createMonitoredSharedDocument(), b = createMonitoredSharedDocument();
  try {
    hydrateSharedDocument(a, validatedFixture({ rows: [{ id: "R1", audioText: "abcd" }] }));
    const good = prepareSharedMarkRecord(a, target, "old", 0, 4, { type: "add", mark: { kind: "comment", id: "occurrence", value: "anchor1" } }); assert.ok(good);
    const key = sharedMarkRecordKey("old", good.writer); assert.ok(key);
    const old = { ...good, mark: { kind: "comment", id: "C1", value: true } }, bytes = encodeSharedState(a);
    assert.equal(readSharedMarkRecord(key, old), null); assert.deepEqual(writeSharedMarkRecord(a, target, "old", old), { ok: false, reason: "invalid-record" });
    assert.deepEqual(encodeSharedState(a), bytes);
    const segment = collabState(a).roots.segments.get("b:R1"); assert.ok(segment instanceof Y.Map);
    const store: unknown = segment.get("markRecords"); assert.ok(store instanceof Y.Map);
    transactSharedDocument(a, "remote", () => store.set(key, old)); assert.ok(applySharedUpdate(b, encodeSharedState(a)).ok);
    for (const handle of [a, b]) assert.deepEqual(readSharedMarkCharacters(handle, target)?.map(char => char.marks), [[], [], [], []]);
  } finally { destroySharedDocument(a); destroySharedDocument(b); }
});

test("insertion gives every identified mark its own occurrence and keeps the wire name as payload", () => {
  const handle = createMonitoredSharedDocument();
  try {
    collabState(handle).doc.clientID = 1; hydrateSharedDocument(handle, validatedFixture({ rows: [{ id: "R1", audioText: "" }] })); registerSharedTextOperationHandlers(handle);
    assert.deepEqual(executeSharedOperations(handle, [operation({ kind: "text-insert", id: "typed", by: "A", target, at: { left: null, right: null, affinity: "before" },
      content: [{ value: "X", marks: [{ kind: "comment", id: "anchor1", value: true }, { kind: "tag", id: "t_box", value: "t_box" }, { kind: "link", id: "https://x", value: "https://x" }] },
        { value: "Y", marks: [{ kind: "comment", id: "anchor1", value: true }] }] })]), { ok: true });
    const actual = readSharedMarkCharacters(handle, target); assert.ok(actual);
    assert.deepEqual(actual.map(char => char.marks.map(group => ({ kind: group.kind, id: group.id, values: group.values }))), [
      [{ kind: "comment", id: '["mark-occurrence","1","typed",0,0]', values: ["anchor1"] }, { kind: "link", id: '["mark-occurrence","1","typed",0,2]', values: ["https://x"] }, { kind: "tag", id: '["mark-occurrence","1","typed",0,1]', values: ["t_box"] }],
      [{ kind: "comment", id: '["mark-occurrence","1","typed",1,0]', values: ["anchor1"] }]
    ]);
    assert.equal(collabState(handle).roots.comments.size, 0); assert.equal(collabState(handle).roots.tags.size, 0);
  } finally { destroySharedDocument(handle); }
});

test("hydration gives two ranges of the same anchor separate deterministic comment occurrences", () => {
  const a = createMonitoredSharedDocument(), b = createMonitoredSharedDocument(), c = createMonitoredSharedDocument();
  try {
    collabState(a).doc.clientID = 1; collabState(b).doc.clientID = 2;
    const source = validatedFixture({ rows: [{ id: "R1", audioText: '<span class="cmt-anchor" data-cmt="anchor1">a</span>bc<span class="cmt-anchor" data-cmt="anchor1">d</span>' }],
      comments: [{ id: "C1", anchorId: "anchor1", rowId: "R1", field: "audioText" }] });
    hydrateSharedDocument(a, source); hydrateSharedDocument(b, source); assert.ok(applySharedUpdate(c, encodeSharedState(a)).ok);
    const expected = [[{ kind: "comment", id: "b:R1:audioText:0000000001", values: ["anchor1"] }], [], [], [{ kind: "comment", id: "b:R1:audioText:0000000002", values: ["anchor1"] }]];
    assertReplicasAgree<unknown>("hydrated comment occurrences", [{ order: "D1", replica: "A", output: expected }, ...[a, b, c].map((handle, index) => ({
      order: index === 2 ? "late-C" as const : "D1" as const, replica: index === 0 ? "A" as const : index === 1 ? "B" as const : "C" as const,
      output: readSharedMarkCharacters(handle, target)?.map(char => char.marks.map(group => ({ kind: group.kind, id: group.id, values: group.values }))) }))]);
    for (const handle of [a, b, c]) { const comment = collabState(handle).roots.comments.get("C1"); assert.ok(comment instanceof Y.Map); assert.equal(comment.get("anchorId"), "anchor1"); }
  } finally { for (const handle of [a, b, c]) destroySharedDocument(handle); }
});

for (const [kind, name, html, comments] of [
  ["link", "href", '<a href="https://example.com/">abcd</a>', []],
  ["tag", "tag", '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Box">abcd</span>', []],
  ["comment", "cmt", '<span class="cmt-anchor" data-cmt="anchor1">abcd</span>', [{ id: "C1", anchorId: "anchor1", rowId: "R1", field: "audioText" }]]
] as const) test(`one flow clear removes the hydrated ${kind} from abcd on every copy`, () => {
  const rt = createFlowLoadRuntime(), doc = { rows: [{ id: "R1", audioText: html }], comments: [...comments] };
  const outcome = setMarkAcross(doc, { anchor: beatPos("R1", 0), head: beatPos("R1", 4) }, name, { ...rt.ports, operations: { id: "clear", by: "A" } });
  assert.ok(outcome && "rows" in outcome); assert.equal(outcome.rows[0]?.audioText, "abcd"); assert.equal(outcome.ops?.length, 1);
  for (const order of ["D1", "dup", "late-C"] as const) {
    const a = createMonitoredSharedDocument(), b = createMonitoredSharedDocument(), c = createMonitoredSharedDocument(), queue = new DeliveryQueue<Uint8Array>(bytes => bytes.slice(), bytes => String(bytes.length));
    try {
      hydrateSharedDocument(a, validatedFixture(doc)); assert.ok(applySharedUpdate(b, encodeSharedState(a)).ok);
      queue.addReplica("A", deliveryReplica(a)); queue.addReplica("B", deliveryReplica(b));
      if (order === "late-C") queue.lateJoin("C", deliveryReplica(c), "A", encodeSharedState(a));
      registerSharedOperationHandlers(a, { mark: (command, view) => {
        const plan = sharedTextCommandPlan(view, command.target), facade = view.text(plan.path); assert.ok(facade);
        const ranges = command.observed.map(reference => resolveSharedTextReference(view, plan, reference, "range"));
        const from = Math.min(...ranges.map(range => range.from)), to = Math.max(...ranges.map(range => range.to));
        const active = new Set(facade.units.slice(from, to).flatMap(unit => unit.marks.flatMap(group => group.additions.map(add => add.record))));
        const translated = prepareSharedMarkTranslation(command.mark, view.writer, command.id, [0], plan.additions.filter(add => active.has(add.identity))); assert.ok(translated);
        const record = prepareTextMarkWrite(plan, view, "clear-record", from, to, translated); assert.equal(record.kind, "record");
        if (record.kind !== "record") throw new Error("Broken test description");
        return preparedTextDescription([{ kind: "set", path: [...plan.storePath, record.identity], value: record }], [{ kind: "mark", target: plan.target, plan: record }]);
      } });
      assert.deepEqual(executeSharedOperations(a, outcome.ops ?? [], { base: readSharedRevision(a) }), { ok: true }); queue.flush(order);
      if (order !== "late-C") queue.lateJoin("C", deliveryReplica(c), "A", encodeSharedState(a));
      const expected = [{ value: "a", marks: [] }, { value: "b", marks: [] }, { value: "c", marks: [] }, { value: "d", marks: [] }];
      assertReplicasAgree("one clear is plain", [{ order: "D1", replica: "A", output: expected }, ...[a, b, c].map((handle, index) => ({
        order: index === 2 ? "late-C" as const : order === "late-C" ? "D1" as const : order, replica: index === 0 ? "A" as const : index === 1 ? "B" as const : "C" as const,
        output: readSharedMarkCharacters(handle, target)?.map(char => ({ value: char.value, marks: char.marks })) }))]);
    } finally { queue.destroy(); for (const handle of [a, b, c]) destroySharedDocument(handle); }
  }
});
