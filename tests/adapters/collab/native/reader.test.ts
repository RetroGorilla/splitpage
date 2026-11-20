import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import type { ValidatedDocument } from "../../../../src/core/document/validated.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { anchorNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import { convertedScript, edit, freshlyShown, shown } from "./helpers.ts";

after(() => { dom.window.close(); });

function small(narration: Record<string, string>, extra: Record<string, unknown> = {}): ValidatedDocument {
  const rows = Object.entries(narration).map(([id, audioText]) => ({ id, audioText, visualText: "" }));
  return migrateRows({ schema: 2, title: "T", docId: "d", rev: 0, rows, comments: [], people: [], productionTags: [], brollShots: [], ...extra });
}

function segmentText(script: NativeScript, key: string): Y.Text {
  const text = script.roots.segments.get(key)?.get("text");
  assert.ok(text instanceof Y.Text, key);
  return text;
}

function problemKinds(script: NativeScript): string[] {
  return script.reader.problems().map(problem => `${problem.kind} ${problem.where}`);
}

for (const ordered of [true, false]) {
  test(`finding 5: new text in empty spans is read if their segment is ordered and reported otherwise (${ordered ? "in" : "out of"} the order)`, () => {
    const script = convertedScript(small({ R1: "a", R2: "b" })), stray = new Y.Map<unknown>(), text = new Y.Text();
    script.doc.transact(() => {
      script.roots.segments.set("s:stray", stray);
      stray.set("head", { b: "R9" });
      stray.set("text", text);
      text.insertEmbed(0, { b: "R8" }, {}); text.insertEmbed(1, { h: "H7" }, {}); text.insertEmbed(2, { b: "R1" }, {});
      if (ordered) script.roots.order.push(["s:stray"]);
    });
    assert.deepEqual(script.reader.unplaced(), []);
    script.doc.transact(() => { text.insert(3, "r", {}); text.insert(2, "h", {}); text.insert(1, "x", {}); text.insert(0, "z", {}); });
    assert.deepEqual(script.reader.unplaced().map(span => span.reason), ordered ? [] : ["no-order", "no-order", "no-order", "no-order"]);
    assert.deepEqual(script.reader.rows().map(row => row.audioText), ordered ? ["a", "bzxhr"] : ["a", "b"]);
    assert.deepEqual(shown(script), freshlyShown(script));
  });
}

test("finding 5: reordering segments that hold the same beat changes the text a warm reader shows", () => {
  const script = convertedScript(small({ R1: "a", R2: "b" })), other = new Y.Map<unknown>(), text = new Y.Text();
  script.doc.transact(() => {
    script.roots.segments.set("s:dup", other);
    other.set("head", { b: "R1" });
    other.set("text", text);
    text.insert(0, "DUP", {});
    script.roots.order.push(["s:dup"]);
  });
  assert.equal(script.reader.row("R1")?.audioText, "a");
  script.doc.transact(() => { script.roots.order.delete(0, 1); script.roots.order.push(["b:R1"]); });
  assert.equal(script.reader.row("R1")?.audioText, "DUP");
  assert.equal(script.reader.row("R2")?.audioText, "ab");
  assert.deepEqual(script.reader.unplaced(), []);
  assert.deepEqual(shown(script), freshlyShown(script));
});

test("finding 6: an unknown embed and hidden units are diagnostics, and the text around them still reads", () => {
  const script = convertedScript(small({ R1: "ab" })), raw = segmentText(script, "b:R1");
  raw.insertEmbed(1, { future: "x" }, {});
  raw.insert(1, "​￼", {});
  assert.equal(script.reader.row("R1")?.audioText, "ab");
  assert.deepEqual(problemKinds(script), ["unknown-embed segments/b:R1#0", "hidden-units segments/b:R1#0"]);
  assert.deepEqual(script.reader.unplaced(), []);
});

test("finding 6: a malformed beat extra, field value or reply key is a diagnostic, never a throw", () => {
  const script = convertedScript(small({ R1: "ab" }, { people: [{ id: "p1", name: "P" }] }));
  script.roots.beats.get("R1")?.set("extra", "{bad");
  script.roots.beats.get("R1")?.set("status", "not json");
  script.roots.people.get("p1")?.set('f:"name"', "{bad");
  script.roots.people.get("p1")?.set("f:name", JSON.stringify("x"));
  script.roots.replies.set("[bad", new Y.Map<unknown>());
  assert.equal(script.reader.row("R1")?.audioText, "ab");
  assert.deepEqual(script.reader.document().people, [{ id: "p1" }]);
  assert.deepEqual(problemKinds(script), ["bad-value beats/R1/status", "bad-value beats/R1/extra", "bad-key replies/[bad", 'bad-value people/p1/f:"name"', "bad-key people/p1/f:name"]);
});

test("finding 6: a closed reader refuses to read", () => {
  const script = convertedScript(small({ R1: "ab" })), reader = script.reader;
  assert.equal(reader.row("R1")?.audioText, "ab");
  reader.close();
  assert.equal(reader.isClosed(), true);
  for (const read of [() => reader.row("R1"), () => reader.refresh(), () => reader.outline(), () => reader.narrationSpans("R1"), () => reader.document()]) assert.throws(read, /closed/);
});

test("finding 7: a malformed join is reported and the beat keeps its own row", () => {
  const script = convertedScript(small({ R1: "a", R2: "b" }));
  script.roots.beats.get("R2")?.set("joined", JSON.stringify({ into: "R1" }));
  assert.deepEqual(script.reader.outline().map(entry => entry.id), ["R1", "R2"]);
  assert.deepEqual(problemKinds(script), ["join-not-read beats/R2"]);
});

test("finding 7: document() saves a heading only when a row follows it, and problems() lists the rest", () => {
  const script = convertedScript(small({ R1: "a" }, { sections: [{ id: "h1", name: "One", firstSceneId: "R1" }] })), record = new Y.Map<unknown>(), name = new Y.Text(), segment = new Y.Map<unknown>();
  script.doc.transact(() => {
    script.roots.headings.set("H9", record);
    record.set("rank", "~");
    script.roots.names.set("H9", name);
    name.insert(0, "End");
    script.roots.segments.set("h:H9", segment);
    segment.set("head", { h: "H9" });
    segment.set("text", new Y.Text());
    script.roots.order.push(["h:H9"]);
  });
  assert.deepEqual(script.reader.outline().map(entry => entry.id), ["h1", "R1", "H9"]);
  assert.deepEqual(script.reader.document().sections, [{ id: "h1", name: "One", firstSceneId: "R1" }]);
  assert.deepEqual(problemKinds(script), ["heading-without-row headings/H9"]);
});

test("finding 8: only refresh() hands out changes; reading rows, the outline or a command's lookup keeps them", () => {
  const script = convertedScript(small({ R1: "a", R2: "b" })), target = { beat: "R1", cell: "narration" as const };
  script.reader.refresh();
  assert.equal(edit(script, target, 0, 0, [{ text: "x", marks: {} }]).kind, "written");
  script.reader.row("R1"); script.reader.rows(); script.reader.outline(); script.reader.narrationSpans("R1"); script.reader.unplaced(); script.reader.problems(); script.reader.document();
  assert.equal(anchorNativeText(script, target, 0, 1).kind, "anchored");
  assert.deepEqual(script.reader.refresh(), { rows: ["R1"], gone: [], headings: [], outline: false });
  assert.deepEqual(script.reader.refresh(), { rows: [], gone: [], headings: [], outline: false });
});

test("round 3, fix 4: one marker whose id holds a separator and two markers are different placements", () => {
  const script = convertedScript(small({ R1: "a", R2: "b", R3: "c" })), raw = segmentText(script, "b:R1");
  assert.deepEqual(script.reader.rows().map(row => row.id), ["R1", "R2", "R3"]);
  script.doc.transact(() => { raw.delete(3, 1); raw.delete(1, 1); raw.insertEmbed(1, { b: "R2|b:R3" }, {}); });
  assert.deepEqual(shown(script), freshlyShown(script));
  assert.deepEqual(script.reader.outline().map(entry => entry.id), ["R1"]);
});

test("round 3, fix 5: the spans a reader hands out cannot be changed by the caller", () => {
  const script = convertedScript(small({ R1: "a", R2: "b" })), spans = script.reader.narrationSpans("R2");
  assert.ok(Object.isFrozen(spans) && spans.every(place => Object.isFrozen(place)));
  assert.throws(() => { (spans[0] as { span: number }).span = 0; }, TypeError);
  assert.equal(edit(script, { beat: "R2", cell: "narration" }, 1, 1, [{ text: "!", marks: {} }]).kind, "written");
  assert.deepEqual(script.reader.rows().map(row => row.audioText), ["a", "b!"]);
});

test("finding 8: returned rows, outline and document are frozen", () => {
  const source = small({ R1: "a" }, { people: [{ id: "p1", name: "P", nested: { v: 1 } }] });
  (source.rows[0] as Record<string, unknown>).nested = { v: 1 };
  const script = convertedScript(source), row = script.reader.row("R1");
  assert.ok(row);
  for (const value of [row, row.narration, row.narration[0], row.fields, row.fields.nested, script.reader.outline(), script.reader.outline()[0]]) assert.ok(Object.isFrozen(value));
  const copy = script.reader.document();
  assert.throws(() => { (copy.rows[0]?.nested as { v: number }).v = 2; }, TypeError);
  assert.throws(() => { (copy.people[0]?.nested as { v: number }).v = 2; }, TypeError);
  assert.deepEqual([script.reader.document().rows[0]?.nested, script.reader.document().people[0]?.nested, script.reader.row("R1")?.fields.nested], [{ v: 1 }, { v: 1 }, { v: 1 }]);
});
