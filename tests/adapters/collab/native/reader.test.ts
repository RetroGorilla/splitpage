import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import type { ValidatedDocument } from "../../../../src/core/document/validated.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { createNativeHeading } from "../../../../src/adapters/collab/native/heading-commands.ts";
import { clearNativeField, setNativeField } from "../../../../src/adapters/collab/native/record-commands.ts";
import { joinNativeRow, removeNativeRows } from "../../../../src/adapters/collab/native/structure-commands.ts";
import { anchorNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import { ScriptNet, convertedScript, edit, freshlyShown, joinedScript, shown } from "./helpers.ts";

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

test("narration caret accepts member boundaries and refuses glue interiors and fractional offsets", t => {
  const script = convertedScript(small({ R1: "Hello", R2: "World" }));
  t.after(() => { script.doc.destroy(); });
  assert.equal(joinNativeRow(script, "R2", "R1", "--").kind, "written");
  assert.deepEqual(script.reader.narrationCaret("R1", 5), { beat: "R1", offset: 5 });
  assert.equal(script.reader.narrationCaret("R1", 6), null);
  assert.deepEqual(script.reader.narrationCaret("R1", 7), { beat: "R2", offset: 0 });
  assert.equal(script.reader.narrationCaret("R1", 2.5), null);
  assert.equal(script.reader.narrationCaret("R1", -1), null);
});

test("a narration-only stray row supplies no caret target", t => {
  const script = convertedScript(small({ R1: "stray words" }));
  t.after(() => { script.doc.destroy(); });
  script.roots.visuals.delete("R1");
  const row = script.reader.rows()[0];
  assert.ok(row);
  assert.deepEqual(row.members, []);
  assert.equal(row.audioText, "stray words");
  assert.equal(script.reader.narrationCaret(row.id, 0), null);
});

test("a truly empty joined row can still receive its first letter", t => {
  const script = convertedScript(small({ R1: "", R2: "" }));
  t.after(() => { script.doc.destroy(); });
  assert.equal(joinNativeRow(script, "R2", "R1", " ").kind, "written");
  assert.equal(script.reader.row("R1")?.audioText, "");
  assert.deepEqual(script.reader.narrationCaret("R1", 0), { beat: "R1", offset: 0 });
});

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
  script.roots.beats.get("R1")?.set('f:"note"', "{bad");
  script.roots.beats.get("R1")?.set("status", "not json");
  script.roots.people.get("p1")?.set('f:"name"', "{bad");
  script.roots.people.get("p1")?.set("f:name", JSON.stringify("x"));
  script.roots.replies.set("[bad", new Y.Map<unknown>());
  assert.equal(script.reader.row("R1")?.audioText, "ab");
  assert.deepEqual(script.reader.document().people, [{ id: "p1" }]);
  assert.deepEqual(problemKinds(script), ["bad-value beats/R1/status", 'bad-value beats/R1/f:"note"', "bad-key replies/[bad", 'bad-value people/p1/f:"name"', "bad-key people/p1/f:name"]);
});

test("only canonical ordinary beat keys are shown, and raw aliases never shadow a command", () => {
  const script = convertedScript(small({ R1: "ab" })), record = script.roots.beats.get("R1");
  assert.ok(record);
  const target = { kind: "beat", id: "R1" } as const;
  const invalid = new Map([
    ['f:"status"', '"shot"'], ['f:"note" ', '"alias"'], ["extra", '{"note":"old storage"}'],
    ["f:17", '"non-string name"'], ['f:"imageRef"', '"fake image"'], ['f:"visualImage"', '"legacy image"']
  ]);
  for (const [key, value] of invalid) record.set(key, value);
  assert.deepEqual(problemKinds(script).sort(), [...invalid.keys()].map(key => "bad-key beats/R1/" + key).sort());
  assert.deepEqual(setNativeField(script, { ...target, field: "status" }, "ready"), { kind: "written" });
  assert.equal(script.reader.document().rows[0]?.status, "ready");
  assert.deepEqual(setNativeField(script, { ...target, field: "note" }, "written"), { kind: "written" });
  assert.equal(script.reader.document().rows[0]?.note, "written");
  assert.deepEqual(clearNativeField(script, { ...target, field: "note" }), { kind: "written" });
  const row = script.reader.document().rows[0];
  assert.ok(row);
  assert.equal(Object.hasOwn(row, "note"), false);
  assert.equal(Object.hasOwn(row, "extra"), false);
  assert.equal(Object.hasOwn(row, "rank"), false);
  assert.equal(Object.hasOwn(row, "visualImage"), false);
  assert.equal(row.imageRef, null);
  assert.deepEqual(problemKinds(script).sort(), [...invalid.keys()].map(key => "bad-key beats/R1/" + key).sort());
  script.doc.destroy();
});

test("malformed galleries and deeply nested fields are omitted and diagnosed, including on an unplaced beat", () => {
  const script = convertedScript(small({ R1: "ab" })), record = script.roots.beats.get("R1");
  assert.ok(record);
  const deep = "[".repeat(12_000) + "0" + "]".repeat(12_000);
  script.roots.beats.set("orphan", new Y.Map([["gallery", "{bad"]]));
  record.set('f:"payload"', deep);
  for (const raw of ["{bad", "[]", "null", '{"imageRef":null,"unknown":1}', '{"imageRef":17}', '{"imageName":"Frame"}', deep]) {
    record.set("gallery", raw);
    const row = script.reader.document().rows[0];
    assert.ok(row);
    assert.equal(Object.hasOwn(row, "imageRef"), false);
    assert.equal(Object.hasOwn(row, "imageName"), false);
    assert.equal(Object.hasOwn(row, "payload"), false);
    assert.deepEqual(problemKinds(script).sort(), [
      'bad-value beats/R1/f:"payload"', "bad-value beats/R1/gallery", "bad-value beats/orphan/gallery"
    ]);
    assert.deepEqual(setNativeField(script, { kind: "beat", id: "R1", field: "note" }, raw.length), { kind: "written" });
    assert.equal(script.reader.document().rows[0]?.note, raw.length);
  }
  script.doc.destroy();
});

test("metadata with wrong scalar types falls back to the document defaults", () => {
  const script = convertedScript(small({ R1: "ab" }));
  script.roots.meta.set("docId", "17");
  script.roots.meta.set("schema", '"two"');
  script.roots.meta.set("extra", '{"rev":false}');
  const { docId, schema, rev } = script.reader.document();
  assert.deepEqual({ docId, schema, rev }, { docId: "", schema: 0, rev: 0 });
  script.doc.destroy();
});

test("the reader builds a visual cell with 140,001 speaker embeds", () => {
  const script = convertedScript(small({ R1: "ab" })), visual = script.roots.visuals.get("R1");
  assert.ok(visual);
  const count = 140_001;
  visual.applyDelta(Array.from({ length: count }, () => ({ insert: { w: "Speaker" } })));
  const row = script.reader.row("R1");
  assert.ok(row);
  assert.equal(row.visual.length, count);
  assert.ok(row.visual.every(run => run.atom === "who" && run.name === "Speaker"));
  assert.equal(script.reader.document().rows[0]?.visualText, row.visualText);
  script.doc.destroy();
});

test("metadata extra reports invalid JSON, non-records and present undefined", () => {
  const script = convertedScript(small({ R1: "ab" }));
  const docId = script.reader.document().docId;
  for (const stored of ["{bad", "[]", "null", undefined]) {
    script.roots.meta.set("extra", stored);
    assert.deepEqual(problemKinds(script), ["bad-value meta/extra"]);
    assert.equal(script.reader.document().docId, docId);
  }
  script.roots.meta.delete("extra");
  assert.deepEqual(problemKinds(script), []);
  script.doc.destroy();
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

test("document() is frozen at every depth across meta, rows, joined galleries, sections and collections", () => {
  const image = { sha256: "a".repeat(64), width: 10, height: 20, mime: "image/png" };
  const otherImage = { ...image, sha256: "b".repeat(64) };
  const thirdImage = { ...image, sha256: "c".repeat(64) };
  const annotation = { imageRef: otherImage, marks: [{ kind: "pen", color: "#111111", width: 0.02, points: [0, 0.5, 1, 0.5] }] };
  const source = small({ R1: "one", R2: "two", R3: "three" }, {
    metaExtra: { flags: [{ on: true }] },
    sections: [{ id: "h1", name: "Opening", firstSceneId: "R1", meta: { color: ["blue"] } }],
    comments: [{
      id: "c1", rowId: "R1", field: "audioText", anchorId: "c1", author: "Alice", body: "check",
      createdAt: "2026-11-19T00:00:00.000Z", quotedText: "one", kind: "anchor", resolved: false,
      extra: { list: [1] },
      replies: [{ id: "rp1", author: "Bob", body: "done", createdAt: "2026-11-19T00:01:00.000Z", extra: { ok: true } }]
    }],
    people: [{ id: "p1", name: "Alice", details: { roles: ["host"] } }],
    productionTags: [{ id: "t:prop:lamp", cat: "prop", name: "lamp", status: "todo", owner: "p1", notes: "", meta: { count: [2] } }],
    brollShots: [{ id: "bs1", name: "Wide", props: ["t:prop:lamp"], meta: { lenses: ["24mm"] } }]
  });
  Object.assign(source.rows[0] as Record<string, unknown>, {
    imageRef: image, imageName: "Primary", imageAnnotation: annotation,
    imageLinks: [{ href: "https://example.test/one", poster: true }],
    moreImages: [{ imageRef: thirdImage, name: "Extra", links: [{ href: "https://example.test/two", poster: true }] }],
    custom: { nested: [{ leaf: "x" }] }
  });
  Object.assign(source.rows[1] as Record<string, unknown>, { imageRef: image });
  Object.assign(source.rows[2] as Record<string, unknown>, {
    imageLinks: [{ href: "https://example.test/joined", poster: true }]
  });
  const script = convertedScript(source);
  try {
    assert.deepEqual(joinNativeRow(script, "R3", "R2", " "), { kind: "written" });
    const snapshot = script.reader.document();
    const visited = new Set<object>();
    const walk = (value: unknown, path: string): void => {
      if (value === null || typeof value !== "object" || visited.has(value)) return;
      visited.add(value);
      assert.ok(Object.isFrozen(value), `expected frozen at ${path}`);
      for (const key of Reflect.ownKeys(value)) walk((value as Record<PropertyKey, unknown>)[key], `${path}.${String(key)}`);
    };
    walk(snapshot, "document");
    assert.ok(visited.size >= 40, `expected deep traversal, visited ${visited.size}`);
    assert.ok(Array.isArray(snapshot.sections) && snapshot.sections.length === 1);
    assert.ok(snapshot.comments[0]?.replies?.length === 1);
    assert.ok(Array.isArray(snapshot.rows[0]?.moreImages));
    assert.ok(Array.isArray(snapshot.rows[1]?.moreImages));
    assert.ok(Array.isArray(snapshot.brollShots[0]?.props));
  } finally { script.doc.destroy(); }
});

test("stacked headings above one row save only the heading directly above it and report each omitted heading", () => {
  const script = convertedScript(small(
    { R1: "a", R2: "b", R3: "c", R4: "d" },
    { sections: [
      { id: "h1", name: "One", firstSceneId: "R1" },
      { id: "h2", name: "Two", firstSceneId: "R2" },
      { id: "h3", name: "Three", firstSceneId: "R3" },
      { id: "h4", name: "Four", firstSceneId: "R4" }
    ] }
  ));
  try {
    assert.deepEqual(removeNativeRows(script, ["R1", "R2"]), { kind: "written" });
    assert.deepEqual(script.reader.outline().map(entry => `${entry.kind}:${entry.id}`), [
      "heading:h1", "heading:h2", "heading:h3", "row:R3", "heading:h4", "row:R4"
    ]);
    const exported = script.reader.document();
    assert.deepEqual(exported.sections, [
      { id: "h3", name: "Three", firstSceneId: "R3" },
      { id: "h4", name: "Four", firstSceneId: "R4" }
    ]);
    assert.deepEqual(problemKinds(script), ["heading-without-row headings/h1", "heading-without-row headings/h2"]);
    assert.deepEqual(migrateRows(structuredClone(exported)).sections, exported.sections);
    assert.deepEqual(shown(script), freshlyShown(script));
  } finally { script.doc.destroy(); }

  const seed = convertedScript(small({ R1: "alpha" }), 1);
  const left = joinedScript(seed, 2), right = joinedScript(seed, 3);
  seed.doc.destroy();
  const net = new ScriptNet([left, right]);
  try {
    const leftCaret = anchorNativeText(left, { beat: "R1", cell: "narration" }, 0);
    const rightCaret = anchorNativeText(right, { beat: "R1", cell: "narration" }, 0);
    assert.ok(leftCaret.kind === "anchored" && rightCaret.kind === "anchored");
    assert.deepEqual(createNativeHeading(left, leftCaret.range, "h-left", "Left"), { kind: "written" });
    assert.deepEqual(createNativeHeading(right, rightCaret.range, "h-right", "Right"), { kind: "written" });
    net.settle();
    net.agree();
    const order = left.roots.order.toArray();
    assert.deepEqual(order, ["h:h-left", "h:h-right", "b:R1"]);
    const leftRank = left.roots.headings.get("h-left")?.get("rank");
    const rightRank = left.roots.headings.get("h-right")?.get("rank");
    const rowRank = left.roots.beats.get("R1")?.get("rank");
    assert.ok(typeof leftRank === "string" && typeof rightRank === "string" && typeof rowRank === "string");
    assert.equal(leftRank, rightRank);
    assert.ok(leftRank < rowRank);
    const created = [
      { id: "h-left", name: "Left", rank: leftRank, storedAt: order.indexOf("h:h-left") },
      { id: "h-right", name: "Right", rank: rightRank, storedAt: order.indexOf("h:h-right") }
    ].sort((a, b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.storedAt - b.storedAt);
    assert.deepEqual(created.map(entry => entry.id), ["h-left", "h-right"]);
    const [omitted, nearest] = created;
    assert.ok(omitted && nearest);
    for (const copy of [left, right]) {
      assert.deepEqual(copy.reader.outline(), [
        { kind: "heading", id: "h-left", name: "Left" },
        { kind: "heading", id: "h-right", name: "Right" },
        { kind: "row", id: "R1" }
      ]);
      assert.deepEqual(copy.reader.document().sections, [{ id: nearest.id, name: nearest.name, firstSceneId: "R1" }]);
      assert.deepEqual(problemKinds(copy), [`heading-without-row headings/${omitted.id}`]);
    }
  } finally { left.doc.destroy(); right.doc.destroy(); }
});
