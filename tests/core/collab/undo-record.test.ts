import test from "node:test";
import assert from "node:assert/strict";
import type { SharedContentRef, SharedTextAddress } from "../../../src/core/collab/operations.ts";
import { mergeSharedUndoRecords, sharedUndoGroupKey, sharedUndoPartName } from "../../../src/core/collab/undo-record.ts";
import type { SharedUndoPart, SharedUndoRecord, SharedUndoUnit } from "../../../src/core/collab/undo-record.ts";

function ref(value: string): SharedContentRef { return value as SharedContentRef; }
function cell(beat: string, field: SharedTextAddress["field"] = "audioText"): SharedTextAddress { return { owner: ref(beat), segment: ref("b:" + beat), field }; }
function unit(id: string): SharedUndoUnit { return { identity: ref(id), value: id, marks: [] }; }
function text(beat: string, inserted: string[], deleted: string[] = []): SharedUndoPart {
  return { kind: "text", target: cell(beat), inserted: inserted.map(ref), deleted: deleted.map(unit) };
}
function record(typing: string | null, ...parts: SharedUndoPart[]): SharedUndoRecord {
  return { label: "typing", selection: null, typing, parts };
}

const STATUS: SharedUndoPart = { kind: "status", target: { scope: "beat", record: ref("R1") }, event: ref("e1"), value: "ready" };

test("a part is named by its kind, a structure part by its command", () => {
  assert.equal(sharedUndoPartName(text("R1", ["a1"])), "text");
  assert.equal(sharedUndoPartName(STATUS), "status");
  assert.equal(sharedUndoPartName({ ...STATUS, kind: "status-retired" }), "status-retired");
  assert.equal(sharedUndoPartName({ kind: "structure", command: "split", operation: ref("op") }), "split");
  assert.equal(sharedUndoPartName({ kind: "structure", command: "heading-remove", operation: ref("op") }), "heading-remove");
});

test("only typing in one text groups: its key is the owner, segment and field", () => {
  assert.equal(sharedUndoGroupKey(record("a", text("R1", ["a1"]))), "[\"R1\",\"b:R1\",\"audioText\"]");
  assert.equal(sharedUndoGroupKey(record("", text("R1", [], ["s1"]), text("R1", ["a1"]))), "[\"R1\",\"b:R1\",\"audioText\"]");
  assert.equal(sharedUndoGroupKey(record(null, text("R1", ["a1"]))), null);
  assert.equal(sharedUndoGroupKey(record("a", text("R1", ["a1"]), text("R2", ["a2"]))), null);
  assert.equal(sharedUndoGroupKey(record("a", text("R1", ["a1"]), STATUS)), null);
  assert.equal(sharedUndoGroupKey(record("a")), null);
  assert.notEqual(sharedUndoGroupKey(record("a", { kind: "text", target: cell("R1", "visualText"), inserted: [ref("a1")], deleted: [] })), sharedUndoGroupKey(record("a", text("R1", ["a1"]))));
});

test("merging keeps the parts in order with the first record's label and selection, and joins what was typed", () => {
  const selection = { anchor: ref("p1"), focus: ref("p1") };
  const first: SharedUndoRecord = { label: "first", selection, typing: "ab", parts: [text("R1", ["a1", "a2"], ["s1"])] };
  const second: SharedUndoRecord = { label: "second", selection: { anchor: ref("p2"), focus: ref("p2") }, typing: "c", parts: [text("R1", ["a3"])] };
  assert.deepEqual(mergeSharedUndoRecords(first, second), { label: "first", selection, typing: "abc", parts: [text("R1", ["a1", "a2"], ["s1"]), text("R1", ["a3"])] });
});

test("a unit the group typed and then deleted leaves both lists; a unit from before the group stays deleted", () => {
  const merged = mergeSharedUndoRecords(record("ab", text("R1", ["a1", "a2"])), record("", text("R1", [], ["a2", "s4"])));
  assert.deepEqual(merged?.parts, [text("R1", ["a1"]), text("R1", [], ["s4"])]);
});

test("a part emptied by the merge is dropped, and a group that returned to its start is no record", () => {
  assert.deepEqual(mergeSharedUndoRecords(record("a", text("R1", ["a1"]), text("R1", ["a2"])), record("", text("R1", [], ["a1"])))?.parts, [text("R1", ["a2"])]);
  assert.equal(mergeSharedUndoRecords(record("a", text("R1", ["a1"])), record("", text("R1", [], ["a1"]))), null);
});

test("the same identity in another text is another unit and is not cancelled", () => {
  const merged = mergeSharedUndoRecords(record("a", text("R1", ["a1"])), record("", text("R2", [], ["a1"])));
  assert.deepEqual(merged?.parts, [text("R1", ["a1"]), text("R2", [], ["a1"])]);
});

test("merging changes neither record it was given", () => {
  const first = record("a", text("R1", ["a1"])), second = record("", text("R1", [], ["a1"]));
  const before = JSON.stringify([first, second]);
  mergeSharedUndoRecords(first, second);
  assert.equal(JSON.stringify([first, second]), before);
});
