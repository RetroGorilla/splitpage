import { createMonitoredSharedDocument as createSharedDocument } from "../helpers.ts";
import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { destroySharedDocument, encodeSharedState, applySharedUpdate, transactSharedDocument } from "../../../../src/adapters/collab/document.ts";
import { hydrateSharedDocument } from "../../../../src/adapters/collab/hydrate.ts";
import { collabState } from "../../../../src/adapters/collab/state.ts";
import { prepareSharedMarkRecord, writeSharedMarkRecord, readSharedMarkCharacters } from "../../../../src/adapters/collab/mark-store.ts";
import { readSharedMarkRecord, sharedMarkRecordKey } from "../../../../src/adapters/collab/mark-record.ts";
import { readSharedTextTarget } from "../../../../src/adapters/collab/text-target.ts";
import { createSharedAnchor, resolveSharedTextAnchor, readSharedAnchor } from "../../../../src/adapters/collab/anchors.ts";
import { monitorSharedFormatting, validatedFixture } from "../helpers.ts";
import { assertReplicasAgree } from "../../../collab/agreement.ts";
import { MarkTraceHistory } from "./driver.ts";
import { formattingLibraryControl } from "../formatting-controls.ts";

function fixture() {
  const handle = createSharedDocument(); monitorSharedFormatting(handle);
  hydrateSharedDocument(handle, validatedFixture({ title: "abcd", rows: [{ id: "R1", audioText: "abcd", visualText: "abcd" }], sections: [{ id: "H1", name: "abcd", firstSceneId: "R1" }] }));
  return handle;
}
function address(field: "audioText" | "visualText" | "heading" | "title") {
  const target = readSharedTextTarget({ field, owner: field === "heading" ? "H1" : "R1", segment: field === "audioText" ? "b:R1" : field === "heading" ? "h:H1" : "R1" });
  assert.ok(target); return target;
}

for (const field of ["audioText", "visualText", "heading", "title"] as const) test(`mark store and typed anchors support ${field} without formatting items`, () => {
  const handle = fixture(), target = address(field);
  try {
    const ref = createSharedAnchor(handle, target, 1, "after"); assert.ok(ref);
    assert.equal((JSON.parse(ref) as { v: number }).v, field === "visualText" || field === "title" ? 2 : 1);
    assert.equal(resolveSharedTextAnchor(handle, ref, target), 1);
    if (field === "audioText" || field === "heading") {
      const bytes = (JSON.parse(ref) as { relative: number[] }).relative;
      assert.equal(readSharedAnchor(JSON.stringify({ v: 2, target, relative: bytes })), null);
      assert.equal(createSharedAnchor(handle, target.segment, 1, "after"), ref);
    }
    assert.equal(resolveSharedTextAnchor(handle, ref, address(field === "visualText" ? "audioText" : "visualText")), null);
    const record = prepareSharedMarkRecord(handle, target, "A1", 1, 3, { type: "add", mark: { kind: "i", value: true } }); assert.ok(record);
    assert.deepEqual(writeSharedMarkRecord(handle, target, "A1", record), { ok: true });
    assert.deepEqual(readSharedMarkCharacters(handle, target)?.map(char => char.marks.map(group => [group.kind, group.id, group.values])), [[], [["i", null, [true]]], [["i", null, [true]]], []]);
    const bytes = encodeSharedState(handle);
    assert.deepEqual(writeSharedMarkRecord(handle, target, "A1", record), { ok: false, reason: "existing-record" });
    assert.deepEqual(encodeSharedState(handle), bytes);
  } finally { destroySharedDocument(handle); }
});

test("identified additions retain all payloads and an unobserved addition survives removal", () => {
  const handle = fixture(), target = address("audioText");
  try {
    for (const [operation, change] of [["A1", { type: "add", mark: { kind: "link", id: "L", value: "https://a" } }],
      ["B1", { type: "add", mark: { kind: "link", id: "L", value: "https://b" } }]] as const) {
      const record = prepareSharedMarkRecord(handle, target, operation, 1, 3, change); assert.ok(record);
      assert.equal(writeSharedMarkRecord(handle, target, operation, record).ok, true);
    }
    assert.deepEqual(readSharedMarkCharacters(handle, target)?.[1]?.marks[0]?.values, ["https://a", "https://b"]);
    const observed = readSharedMarkCharacters(handle, target)?.[1]?.marks[0]?.additions.find(add => add.operation === "A1")?.record; assert.ok(observed);
    const remove = prepareSharedMarkRecord(handle, target, "A2", 1, 3, { type: "remove", observed: [observed] }); assert.ok(remove);
    assert.equal(writeSharedMarkRecord(handle, target, "A2", remove).ok, true);
    assert.deepEqual(readSharedMarkCharacters(handle, target)?.[1]?.marks[0]?.values, ["https://b"]);
  } finally { destroySharedDocument(handle); }
});

test(formattingLibraryControl("monitor negative control rejects native formatting items"), () => {
  const handle = fixture();
  try {
    const segment = collabState(handle).roots.segments.get("b:R1"); assert.ok(segment instanceof Y.Map);
    const text: unknown = segment.get("text"); assert.ok(text instanceof Y.Text);
    assert.throws(() => transactSharedDocument(handle, "local-command", () => text.format(0, 1, { i: true })), /created a formatting item/);
  } finally { destroySharedDocument(handle); }
});

test("independent model rejects the lost-mark defect even when every replica agrees", () => {
  const history = new MarkTraceHistory("D1", 2, "abc");
  try {
    history.model.add({ id: "A1", kind: "add", from: 0, to: 3, mark: { kind: "i", value: true } }, new Set());
    history.known.forEach(known => known.add("A1"));
    assert.deepEqual(history.replicas[0]?.readNamed(history.book), history.replicas[1]?.readNamed(history.book));
    assert.throws(() => history.finish(), /independent rule/);
  } finally { history.destroy(); }
});

test("seeded malformed mark records and normalized ids read identically after encoded transfer", () => {
  const handle = fixture(), target = address("audioText"), peer = createSharedDocument(); monitorSharedFormatting(peer);
  try {
    const good = prepareSharedMarkRecord(handle, target, "op\ud800", 1, 3, { type: "add", mark: { kind: "tag", id: "T\ud800", value: "P\ud800" } }); assert.ok(good);
    assert.equal(writeSharedMarkRecord(handle, target, "op\ud800", good).ok, true);
    assert.equal(good.operation, "op�");
    const segment = collabState(handle).roots.segments.get("b:R1"); assert.ok(segment instanceof Y.Map);
    const store: unknown = segment.get("markRecords"); assert.ok(store instanceof Y.Map);
    const goodKey = sharedMarkRecordKey("op�", good.writer); assert.ok(goodKey); assert.equal(store.has(goodKey), true);
    const values: unknown[] = [null, true, 3, [], {}, { ...good, extra: true }, { ...good, start: "gone" }, { ...good, born: { client: 1, clock: -1, length: 2 } }, { type: "remove", operation: "bad", writer: good.writer, start: good.start, end: good.end, observed: new Array(1) }];
    let seed = 0x1414;
    for (let sample = 0; sample < 256; sample++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const operation = `bad${sample}`, value = values[seed % values.length];
      const raw: unknown = sample % 17 === 0 ? { ...good, operation } : value !== null && typeof value === "object" && !Array.isArray(value) ? { ...value, operation } : value;
      const key: string = sample % 17 === 0 || sample % 2 ? sharedMarkRecordKey(operation, good.writer) ?? "" : `["${operation}\ud800"]`;
      assert.equal(readSharedMarkRecord(key, raw) !== null, sample % 17 === 0);
      transactSharedDocument(handle, "local-command", () => store.set(key, raw));
      assert.equal(applySharedUpdate(peer, encodeSharedState(handle)).ok, true);
      assertReplicasAgree("malformed mark checkpoint", [{ order: "D1", replica: "A", output: readSharedMarkCharacters(handle, target) }, { order: "late-C", replica: "C", output: readSharedMarkCharacters(peer, target) }]);
    }
  } finally { destroySharedDocument(handle); destroySharedDocument(peer); }
});
