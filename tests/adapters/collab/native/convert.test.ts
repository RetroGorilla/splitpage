import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import type { DocumentShape } from "../../../../src/core/document/validated.ts";
import { convertToNativeScript, NATIVE_SEGMENT_BEATS } from "../../../../src/adapters/collab/native/convert.ts";
import { nativeBlockOf } from "../../../../src/adapters/collab/native/inline.ts";
import type { NativeDeltaItem } from "../../../../src/adapters/collab/native/inline.ts";
import { openNativeScript } from "../../../../src/adapters/collab/native/script.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { cells, convertedScript, fixture, fixtures, freshlyShown, joinedScript, shown } from "./helpers.ts";

after(() => { dom.window.close(); });

const ports = { cells, creation: "creation-1", at: "2026-11-19T00:00:00Z", by: "converter" };

function readBack(document: DocumentShape): DocumentShape {
  const script = convertedScript(document), late = joinedScript(script, 2);
  assert.deepEqual(shown(late), shown(script));
  assert.deepEqual(freshlyShown(late), shown(script));
  assert.deepEqual(late.reader.unplaced(), []);
  return migrateRows(structuredClone(late.reader.document()));
}

const knownDifferences: Record<string, string> = {
  "merge-text-unicode-and-atoms.json/inputs/base": "the rich-text reader removes the stored U+200B in visual text",
  "merge-text-unicode-and-atoms.json/inputs/mine": "the rich-text reader removes the stored U+200B in visual text",
  "merge-text-unicode-and-atoms.json/inputs/theirs": "the rich-text reader removes the stored U+200B in visual text",
  "migrate-golden.json/scenarios/media in cells/output": "the rich-text reader settles the mid-line audio-cue span",
  "supplement.splitpage": "a link's local location is not shared"
};

function expectedOf(name: string, source: DocumentShape): DocumentShape {
  const expected = structuredClone(source);
  if (name.startsWith("merge-text-unicode-and-atoms.json/")) {
    const row = expected.rows[3]; assert.ok(row && typeof row.visualText === "string");
    row.visualText = row.visualText.replace(/\u200b/g, "");
  }
  if (name === "migrate-golden.json/scenarios/media in cells/output") {
    const row = expected.rows[1]; assert.ok(row && typeof row.audioText === "string");
    row.audioText = row.audioText.replace('<span class="audio-cue">SFX: ', "SFX: ").replace("Thunder</span></span>", "Thunder</span>");
  }
  if (name === "supplement.splitpage") {
    const links = expected.rows[0]?.imageLinks as Record<string, unknown>[];
    assert.deepEqual(links.map(link => link.location), [{ kind: "path", path: "C:\\shoot\\take.mp4" }, { kind: "bundled", name: "notes.pdf" }]);
    for (const link of links) delete link.location;
  }
  return expected;
}

test("conversion round trip: all 291 real-shaped fixtures read back, five known differences", () => {
  let differing = 0;
  assert.equal(fixtures.length, 291);
  for (const item of fixtures) {
    const source = migrateRows(structuredClone(item.document)), read = readBack(source);
    assert.deepEqual(read, expectedOf(item.name, source), item.name);
    try { assert.deepEqual(read, source); } catch {
      assert.ok(Object.hasOwn(knownDifferences, item.name), item.name + " differs without a declared reason");
      differing++;
    }
  }
  assert.equal(differing, Object.keys(knownDifferences).length);
});

function withHeadings(document: DocumentShape, at: readonly number[]): DocumentShape {
  const sections = at.map((index, number) => ({ id: "sec-" + number, name: `Part ${number + 1} — “${["Open", "Middle", "Turn", "Close", "Coda"][number % 5]}”`, firstSceneId: document.rows[index]?.id }));
  return migrateRows({ ...structuredClone(document), sections });
}

function segmentItems(script: NativeScript, key: string): NativeDeltaItem[] {
  const text = script.roots.segments.get(key)?.get("text");
  assert.ok(text instanceof Y.Text, key);
  return text.toDelta() as NativeDeltaItem[];
}

test("conversion writes heading names into name cells, never into segment text", () => {
  const demo = fixture("src/starters/long-demo.json");
  const source = withHeadings(demo, [0, 4, 11, 29]), script = convertedScript(source), late = joinedScript(script, 2);
  const sections = source.sections as { id: string; name: string }[];
  assert.equal(sections.length, 4);
  for (const section of sections) {
    assert.equal(late.roots.names.get(section.id)?.toString(), section.name);
    for (const key of late.roots.order.toArray()) {
      const text = segmentItems(late, key).map(item => typeof item.insert === "string" ? item.insert : "").join("");
      assert.ok(!text.includes(section.name), `${section.name} in ${key}`);
    }
  }
  const outline = late.reader.outline().map(entry => entry.kind === "heading" ? "# " + entry.name : entry.id);
  const expected = demo.rows.flatMap((row, index) => [...[0, 4, 11, 29].includes(index) ? ["# " + sections[[0, 4, 11, 29].indexOf(index)]?.name] : [], row.id]);
  assert.deepEqual(outline, expected);
  const read = migrateRows(structuredClone(late.reader.document()));
  assert.deepEqual(read.sections, source.sections);
  assert.deepEqual(read.rows, source.rows);
});

test("conversion lays segments at each heading and after 30 beats, keyed by their head", () => {
  const demo = fixture("src/starters/long-demo.json"), rows = Array.from({ length: 3 }, (_, copy) => demo.rows.map(row => ({ ...row, id: row.id + "-" + copy }))).flat();
  const source = withHeadings({ ...demo, rows }, [0, 40]), script = convertedScript(source);
  const heads = script.roots.order.toArray();
  assert.deepEqual(heads, ["h:sec-0", "b:" + rows[30]?.id, "h:sec-1", "b:" + rows[70]?.id]);
  for (const key of heads) assert.equal(nativeBlockOf(script.roots.segments.get(key)?.get("head")), key);
  const first = segmentItems(script, "h:sec-0");
  assert.equal(nativeBlockOf(first[0]?.insert), "b:" + rows[0]?.id);
  assert.equal(first.filter(item => nativeBlockOf(item.insert)?.startsWith("b:")).length, NATIVE_SEGMENT_BEATS);
  assert.deepEqual(migrateRows(structuredClone(script.reader.document())).rows, source.rows);
});

test("empty beats convert, read back and keep their place", () => {
  const demo = fixture("src/starters/to-camera.json");
  const source = migrateRows({ ...structuredClone(demo), rows: demo.rows.map((row, index) => index % 2 ? { ...row, audioText: "", visualText: "" } : row) });
  const read = readBack(source);
  assert.deepEqual(read.rows, source.rows);
  assert.ok(read.rows.some(row => row.audioText === "" && row.visualText === ""));
});

test("conversion refuses before writing: a used script, a missing or repeated id", () => {
  const demo = fixture("src/starters/interview.json");
  const used = new Y.Doc(); used.getMap("other").set("x", 1);
  const repeated = migrateRows(structuredClone(demo)); repeated.rows[1] = { ...repeated.rows[1], id: String(repeated.rows[0]?.id) };
  const missing = migrateRows(structuredClone(demo)); (missing.people as unknown[]).push({ name: "No id" });
  for (const [doc, source] of [[used, demo], [new Y.Doc(), repeated], [new Y.Doc(), missing]] as const) {
    const before = Y.encodeStateAsUpdate(doc), script = openNativeScript(doc);
    assert.throws(() => { convertToNativeScript(script, source, ports); });
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  }
});

test("conversion records the creation and each row's last edit", () => {
  const source = fixture("src/starters/long-demo.json"), script = convertedScript(source);
  assert.deepEqual(script.roots.births.toJSON(), { "creation-1": { at: ports.at, by: ports.by } });
  for (const row of source.rows) {
    const edited = script.roots.edited.get(row.id) as Record<string, unknown> | undefined;
    if (row.updatedAt !== undefined || row.updatedBy !== undefined) assert.deepEqual(edited, Object.fromEntries([["at", row.updatedAt], ["by", row.updatedBy]].filter(([, value]) => value !== undefined)));
    else assert.equal(edited, undefined);
  }
});
