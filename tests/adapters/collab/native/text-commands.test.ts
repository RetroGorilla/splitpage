import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import type { DocumentShape } from "../../../../src/core/document/validated.ts";
import type { Marks, Run } from "../../../../src/core/text/runs.ts";
import { nativeMarkName } from "../../../../src/adapters/collab/native/inline.ts";
import type { NativeDeltaItem } from "../../../../src/adapters/collab/native/inline.ts";
import { deleteNativeText, replaceNativeText, typeNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { ScriptNet, convertedScript, joinedScript, shown } from "./helpers.ts";

after(() => { dom.window.close(); });

const NARRATION = (beat: string) => ({ beat, cell: "narration" as const });
const VISUAL = (beat: string) => ({ beat, cell: "visual" as const });
const TAG = "t:prop:lamp";

function script(rows: Record<string, string>, visuals: Record<string, string> = {}): DocumentShape {
  return migrateRows({
    schema: 2, title: "Commands", docId: "doc-commands", rev: 0,
    rows: Object.entries(rows).map(([id, audioText]) => ({ id, audioText, visualText: visuals[id] ?? "" })),
    comments: [], people: [], productionTags: [{ id: TAG, cat: "prop", name: "lamp" }], brollShots: []
  });
}

function copies(source: DocumentShape, count = 3): { net: ScriptNet; all: NativeScript[] } {
  const seed = convertedScript(source, 1), all = Array.from({ length: count }, (_, index) => joinedScript(seed, index + 2));
  return { net: new ScriptNet(all), all };
}

function narration(copy: NativeScript, beat: string): string {
  return (copy.reader.row(beat)?.narration ?? []).map(run => run.atom ? "￼" : run.text).join("");
}

function type(copy: NativeScript, beat: string, at: number, text: string, marks: Marks = {}): void {
  assert.equal(typeNativeText(copy, NARRATION(beat), at, text, marks).kind, "written");
}

function cut(copy: NativeScript, beat: string, from: number, to: number): void {
  assert.equal(deleteNativeText(copy, NARRATION(beat), from, to).kind, "written");
}

test("T01: a cut and a keystroke inside it on two copies", () => {
  const { net, all: [a, b, c] } = copies(script({ R1: "abcd" }));
  assert.ok(a && b && c);
  cut(a, "R1", 1, 3); type(b, "R1", 2, "X");
  net.settle();
  assert.deepEqual(net.agree(), ["R1: aXd / "]);
});

test("T02: typing at both sides of a boundary on two copies", () => {
  const { net, all: [a, b] } = copies(script({ R1: "ab", R2: "cd" }));
  assert.ok(a && b);
  type(b, "R1", 0, "X"); net.deliver(b, a);
  type(a, "R1", 3, "c"); type(b, "R1", 3, "Y"); type(a, "R2", 0, "Z");
  net.settle();
  assert.deepEqual(net.agree(), ["R1: XabcY / ", "R2: Zcd / "]);
});

test("T04: typing, typing at the start and a cut on two copies", () => {
  const { net, all: [a, b] } = copies(script({ R1: "abcd" }));
  assert.ok(a && b);
  type(a, "R1", 2, "xy"); type(b, "R1", 0, "Z"); cut(b, "R1", 4, 5);
  for (const order of ["reverse", "twice", "forward"] as const) net.settle(order);
  assert.deepEqual(net.agree(), ["R1: Zabxyc / "]);
});

test("the visual cell types and deletes on its own, and every copy reads it", () => {
  const { net, all: [a, b] } = copies(script({ R1: "ab" }, { R1: "<strong>wide</strong> shot" }));
  assert.ok(a && b);
  assert.equal(typeNativeText(a, VISUAL("R1"), 4, "!", {}).kind, "written");
  assert.equal(deleteNativeText(b, VISUAL("R1"), 0, 1).kind, "written");
  net.settle("reverse");
  assert.deepEqual(net.agree(), ["R1: ab / <strong>ide</strong>! shot"]);
});

test("typing writes the attributes it is given, not the neighbour's", () => {
  const { all: [a] } = copies(script({ R1: "<strong>bold</strong>" }), 1);
  assert.ok(a);
  type(a, "R1", 4, " plain");
  type(a, "R1", 0, ">", { i: true });
  assert.equal(a.reader.row("R1")?.audioText, "<em>&gt;</em><strong>bold</strong> plain");
});

function tagKeys(copy: NativeScript, beat: string): string[] {
  const place = copy.reader.narrationPlace(beat);
  assert.ok(place);
  return [...new Set((place.items as NativeDeltaItem[]).flatMap(item => Object.keys(item.attributes ?? {}).filter(key => nativeMarkName(key) === "t:" + TAG)))];
}

test("typing next to a tag application keeps its key; a separate application gets a fresh one", () => {
  const { all: [a] } = copies(script({ R1: "a lamp b" }), 1);
  assert.ok(a);
  const tagged: Marks = { tag: TAG };
  type(a, "R1", 2, "L", tagged); type(a, "R1", 3, "AMP", tagged);
  assert.equal(tagKeys(a, "R1").length, 1);
  type(a, "R1", 12, "X", tagged);
  assert.equal(tagKeys(a, "R1").length, 2);
  assert.match(String(a.reader.row("R1")?.audioText), /^a <span class="tag-anchor"[^>]*>LAMP<\/span>lamp b<span class="tag-anchor"[^>]*>X<\/span>$/);
});

test("a replacement inserts before it deletes, in one transaction", () => {
  const { all: [a] } = copies(script({ R1: "abcd" }), 1);
  assert.ok(a);
  const place = a.reader.narrationPlace("R1"), calls: string[] = [];
  assert.ok(place);
  const text = place.text as Y.Text & Record<string, unknown>, insert = text.insert.bind(text), remove = text.delete.bind(text);
  text.insert = (...args: Parameters<Y.Text["insert"]>) => { calls.push("insert"); assert.ok(args[2] && typeof args[2] === "object"); insert(...args); };
  text.delete = (...args: Parameters<Y.Text["delete"]>) => { calls.push("delete"); remove(...args); };
  let transactions = 0;
  a.doc.on("afterTransaction", () => { transactions++; });
  assert.equal(replaceNativeText(a, NARRATION("R1"), 1, 3, [{ text: "X", marks: {} }]).kind, "written");
  assert.deepEqual(calls, ["insert", "delete"]);
  assert.equal(transactions, 1);
  assert.equal(narration(a, "R1"), "aXd");
});

test("refusals write nothing and hand the runs back", () => {
  const { all: [a] } = copies(script({ R1: "a🎬b" }), 1);
  assert.ok(a);
  const runs: Run[] = [{ text: "new", marks: {} }], before = Y.encodeStateVector(a.doc);
  const cases = [
    [replaceNativeText(a, NARRATION("R9"), 0, 0, runs), "missing"],
    [replaceNativeText(a, VISUAL("R9"), 0, 0, runs), "missing"],
    [replaceNativeText(a, NARRATION("R1"), 0, 5, runs), "range"],
    [replaceNativeText(a, NARRATION("R1"), 2, 1, runs), "range"],
    [replaceNativeText(a, NARRATION("R1"), 0.5, 1, runs), "range"],
    [replaceNativeText(a, NARRATION("R1"), 2, 2, runs), "range"],
    [replaceNativeText(a, NARRATION("R1"), 0, 2, runs), "range"],
    [replaceNativeText(a, NARRATION("R1"), 0, 0, [{ text: "\ud800", marks: {} }]), "text"]
  ] as const;
  for (const [outcome, reason] of cases) {
    assert.equal(outcome.kind, "recovery");
    assert.ok(outcome.kind === "recovery" && outcome.reason === reason, reason);
    assert.ok(outcome.kind === "recovery" && outcome.runs.length === 1);
  }
  assert.deepEqual(Y.encodeStateVector(a.doc), before);
  assert.equal(narration(a, "R1"), "a🎬b");
});

test("an empty edit is unchanged and writes nothing", () => {
  const { all: [a] } = copies(script({ R1: "abcd" }), 1);
  assert.ok(a);
  const before = Y.encodeStateVector(a.doc);
  assert.equal(typeNativeText(a, NARRATION("R1"), 2, "", {}).kind, "unchanged");
  assert.equal(deleteNativeText(a, NARRATION("R1"), 3, 3).kind, "unchanged");
  assert.deepEqual(Y.encodeStateVector(a.doc), before);
});

test("an edit stamp is written with the typing, once per change of stamp", () => {
  const { all: [a] } = copies(script({ R1: "abcd" }), 1);
  assert.ok(a);
  let edits = 0;
  a.roots.edited.observe(() => { edits++; });
  const stamp = { by: "writer", at: "2026-11-19T10:00:00Z" };
  assert.equal(typeNativeText(a, NARRATION("R1"), 0, "x", {}, stamp).kind, "written");
  assert.equal(typeNativeText(a, NARRATION("R1"), 1, "y", {}, stamp).kind, "written");
  assert.equal(edits, 1);
  assert.deepEqual(a.roots.edited.get("R1"), stamp);
  assert.deepEqual(a.reader.row("R1")?.fields.updatedBy, "writer");
  assert.equal(typeNativeText(a, NARRATION("R1"), 2, "z", {}).kind, "written");
  assert.equal(edits, 1);
});

test("the shown outline reads every row once, with nothing unplaced", () => {
  const { net, all: [a, b] } = copies(script({ R1: "ab", R2: "", R3: "cd" }));
  assert.ok(a && b);
  type(a, "R2", 0, "middle"); type(b, "R3", 2, "!");
  net.settle("twice");
  assert.deepEqual(net.agree(), ["R1: ab / ", "R2: middle / ", "R3: cd! / "]);
  assert.deepEqual(shown(a).filter(line => line.startsWith("unplaced")), []);
});
