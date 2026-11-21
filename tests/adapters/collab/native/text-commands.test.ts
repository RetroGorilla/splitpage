import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import type { ValidatedDocument } from "../../../../src/core/document/validated.ts";
import type { StoredImageRef } from "../../../../src/core/document/text-policy.ts";
import type { Marks, Run } from "../../../../src/core/text/runs.ts";
import { formatNativeText } from "../../../../src/adapters/collab/native/format-commands.ts";
import { createNativeHeading, renameNativeHeading } from "../../../../src/adapters/collab/native/heading-commands.ts";
import { nativeMarkName } from "../../../../src/adapters/collab/native/inline.ts";
import { nativeSegmentSpans } from "../../../../src/adapters/collab/native/reader.ts";
import { removeNativeRows, splitNativeRow } from "../../../../src/adapters/collab/native/structure-commands.ts";
import { anchorNativeText, deleteNativeText, replaceNativeText, typeNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import type { NativeTextRange, NativeTextTarget } from "../../../../src/adapters/collab/native/text-commands.ts";
import { closeNativeScript, openNativeScript } from "../../../../src/adapters/collab/native/script.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { ScriptNet, convertedScript, edit, joinedScript, shown } from "./helpers.ts";

after(() => { dom.window.close(); });

const NARRATION = (beat: string): NativeTextTarget => ({ beat, cell: "narration" });
const VISUAL = (beat: string): NativeTextTarget => ({ beat, cell: "visual" });
const TAG = "t:prop:lamp";

function script(rows: Record<string, string>, visuals: Record<string, string> = {}): ValidatedDocument {
  return migrateRows({
    schema: 2, title: "Commands", docId: "doc-commands", rev: 0,
    rows: Object.entries(rows).map(([id, audioText]) => ({ id, audioText, visualText: visuals[id] ?? "" })),
    comments: [], people: [], productionTags: [{ id: TAG, cat: "prop", name: "lamp" }], brollShots: []
  });
}

function copies(source: ValidatedDocument, count = 3): { net: ScriptNet; all: NativeScript[] } {
  const seed = convertedScript(source, 1), all = Array.from({ length: count }, (_, index) => joinedScript(seed, index + 2));
  return { net: new ScriptNet(all), all };
}

function one(rows: Record<string, string>, visuals: Record<string, string> = {}): NativeScript {
  const copy = copies(script(rows, visuals), 1).all[0];
  assert.ok(copy);
  return copy;
}

function narration(copy: NativeScript, beat: string): string {
  return (copy.reader.row(beat)?.narration ?? []).map(run => run.atom ? "￼" : run.text).join("");
}

function range(copy: NativeScript, target: NativeTextTarget, from: number, to = from): NativeTextRange {
  const anchored = anchorNativeText(copy, target, from, to);
  assert.equal(anchored.kind, "anchored");
  return (anchored as { range: NativeTextRange }).range;
}

function type(copy: NativeScript, beat: string, at: number, text: string, marks: Marks = {}): void {
  assert.equal(typeNativeText(copy, range(copy, NARRATION(beat), at), text, marks).kind, "written");
}

function cut(copy: NativeScript, beat: string, from: number, to: number): void {
  assert.equal(deleteNativeText(copy, range(copy, NARRATION(beat), from, to)).kind, "written");
}

function segmentText(copy: NativeScript, key: string): Y.Text {
  const text = copy.roots.segments.get(key)?.get("text");
  assert.ok(text instanceof Y.Text);
  return text;
}

test("T01: a cut and a keystroke inside it on two copies", () => {
  const { net, all: [a, b] } = copies(script({ R1: "abcd" }));
  assert.ok(a && b);
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

test("a caret at the start of a beat or the end of the segment stays in that beat after removal and undo", () => {
  const { net, all: [a, b] } = copies(script({ R1: "Hello", R2: "World", R3: "Last" }), 2);
  assert.ok(a && b);
  const start = range(a, NARRATION("R2"), 0), end = range(a, NARRATION("R3"), 4);
  const undo = new Y.UndoManager(b.roots.segments, { trackedOrigins: new Set([b.origin]) });
  try {
    assert.equal(removeNativeRows(b, ["R1"]).kind, "written");
    net.deliver(b, a);
    assert.equal(typeNativeText(a, start, "?", {}).kind, "written");
    assert.equal(typeNativeText(a, end, "!", {}).kind, "written");
    net.settle();
    assert.deepEqual(net.agree(), ["R2: ?World / ", "R3: Last! / "]);
    assert.ok(undo.undo());
    net.settle();
    assert.deepEqual(net.agree(), ["R1: Hello / ", "R2: ?World / ", "R3: Last! / "]);
  } finally { undo.destroy(); }
});

test("T04: typing, typing at the start and a cut on two copies", () => {
  const { net, all: [a, b] } = copies(script({ R1: "abcd" }));
  assert.ok(a && b);
  type(a, "R1", 2, "xy"); type(b, "R1", 0, "Z"); cut(b, "R1", 4, 5);
  for (const order of ["reverse", "twice", "forward"] as const) net.settle(order);
  assert.deepEqual(net.agree(), ["R1: Zabxyc / "]);
});

test("finding 1: a selection taken before a peer's edit still names the same letters", () => {
  const { net, all: [a, b] } = copies(script({ R1: "abc" }), 2);
  assert.ok(a && b);
  const selection = range(b, NARRATION("R1"), 1, 2);
  type(a, "R1", 0, "X"); net.deliver(a, b);
  assert.equal(deleteNativeText(b, selection).kind, "written");
  assert.equal(narration(b, "R1"), "Xac");
  const gone = range(b, NARRATION("R1"), 1, 2);
  cut(a, "R1", 0, 3); net.settle();
  assert.equal(deleteNativeText(b, gone).kind, "unchanged");
  assert.equal(narration(b, "R1"), "c");
});

test("finding 1: a span shortened before the command runs never lets it reach the next boundary", () => {
  const copy = one({ R1: "abc", R2: "abc" }), selection = range(copy, NARRATION("R1"), 1, 3);
  segmentText(copy, "b:R1").delete(0, 1);
  assert.equal(deleteNativeText(copy, selection).kind, "written");
  assert.deepEqual(copy.reader.rows().map(row => row.id + "=" + row.audioText), ["R1=", "R2=abc"]);
});

test("finding 1: inside another open transaction a command refuses and writes nothing", () => {
  const copy = one({ R1: "abc", R2: "abc" }), selection = range(copy, NARRATION("R1"), 2, 3), outcomes: string[] = [];
  copy.doc.transact(() => {
    segmentText(copy, "b:R1").delete(0, 1);
    outcomes.push(deleteNativeText(copy, selection).kind);
    copy.roots.beats.delete("R2");
    outcomes.push(typeNativeText(copy, selection, "Z", {}).kind);
    outcomes.push(anchorNativeText(copy, NARRATION("R1"), 0).kind);
  });
  assert.deepEqual(outcomes, ["recovery", "recovery", "refused"]);
  assert.deepEqual(nativeSegmentSpans(copy.roots.segments.get("b:R1"))?.map(span => [span.key, span.end - span.start]), [["b:R1", 2], ["b:R2", 3]]);
  assert.equal(narration(copy, "R1"), "bcabc");
});

test("finding 1: a command called from an observer refuses", () => {
  const { net, all: [a, b] } = copies(script({ R1: "abc" }), 2);
  assert.ok(a && b);
  const selection = range(b, NARRATION("R1"), 0, 1), seen: string[] = [];
  b.roots.segments.observeDeep(() => { seen.push(deleteNativeText(b, selection).kind); });
  type(a, "R1", 3, "d"); net.deliver(a, b);
  assert.deepEqual(seen, ["recovery"]);
  assert.equal(narration(b, "R1"), "abcd");
});

test("finding 4: units the cell policy hides are refused before writing", () => {
  const copy = one({ R1: "ab" });
  copy.doc.on("update", () => undefined);
  const before = Y.encodeStateVector(copy.doc), at = range(copy, NARRATION("R1"), 1);
  for (const text of ["​", "￼", "x\u0007", "\r", "\ud800"]) {
    const outcome = typeNativeText(copy, at, text, {});
    assert.ok(outcome.kind === "recovery" && outcome.reason === "text", JSON.stringify(text));
  }
  const ref: StoredImageRef = { sha256: "a".repeat(64) };
  Object.assign(ref, { extension: 10n });
  const bad: Run[] = [{ text: "Q", marks: {} }, { atom: "image", ref, text: "", marks: {} }];
  assert.deepEqual(replaceNativeText(copy, range(copy, NARRATION("R1"), 0, 1), bad), { kind: "recovery", reason: "text", runs: bad });
  assert.deepEqual(replaceNativeText(copy, at, [{ text: "x", marks: { tag: "bad\u001fid" } }]).kind, "recovery");
  assert.deepEqual(Y.encodeStateVector(copy.doc), before);
  assert.equal(narration(copy, "R1"), "ab");
});

test("finding 6: a row whose segment text is gone refuses in both cells", () => {
  const copy = one({ R1: "ab" });
  copy.roots.segments.get("b:R1")?.delete("text");
  for (const target of [NARRATION("R1"), VISUAL("R1")]) assert.deepEqual(anchorNativeText(copy, target, 0), { kind: "refused", reason: "missing" });
  assert.deepEqual(copy.reader.problems(), [{ kind: "no-text", where: "segments/b:R1" }]);
});

test("finding 6: a closed script refuses, also with a range taken before it closed", () => {
  const copy = one({ R1: "abc", R2: "def" }), selection = range(copy, NARRATION("R1"), 2, 3);
  closeNativeScript(copy);
  const before = Y.encodeStateVector(copy.doc);
  assert.deepEqual(anchorNativeText(copy, NARRATION("R1"), 0), { kind: "refused", reason: "closed" });
  assert.deepEqual(deleteNativeText(copy, selection), { kind: "recovery", reason: "closed", runs: [] });
  assert.deepEqual(Y.encodeStateVector(copy.doc), before);
  assert.throws(() => copy.reader.rows(), /closed/);
});

test("the visual cell types and deletes on its own, and every copy reads it", () => {
  const { net, all: [a, b] } = copies(script({ R1: "ab" }, { R1: "<strong>wide</strong> shot" }));
  assert.ok(a && b);
  assert.equal(edit(a, VISUAL("R1"), 4, 4, [{ text: "!", marks: {} }]).kind, "written");
  assert.equal(edit(b, VISUAL("R1"), 0, 1, []).kind, "written");
  net.settle("reverse");
  assert.deepEqual(net.agree(), ["R1: ab / <strong>ide</strong>! shot"]);
});

test("typing writes the attributes it is given, not the neighbour's", () => {
  const copy = one({ R1: "<strong>bold</strong>" });
  type(copy, "R1", 4, " plain");
  type(copy, "R1", 0, ">", { i: true });
  assert.equal(copy.reader.row("R1")?.audioText, "<em>&gt;</em><strong>bold</strong> plain");
});

function tagKeys(copy: NativeScript, beat: string): string[] {
  const items = nativeSegmentSpans(copy.roots.segments.get("b:" + beat))?.[0]?.items ?? [];
  return [...new Set(items.flatMap(item => Object.keys(item.attributes ?? {}).filter(key => nativeMarkName(key) === "t:" + TAG)))];
}

test("typing next to a tag application keeps its key; a separate application gets a fresh one", () => {
  const copy = one({ R1: "a lamp b" }), tagged: Marks = { tag: TAG };
  type(copy, "R1", 2, "L", tagged); type(copy, "R1", 3, "AMP", tagged);
  assert.equal(tagKeys(copy, "R1").length, 1);
  type(copy, "R1", 12, "X", tagged);
  assert.equal(tagKeys(copy, "R1").length, 2);
  assert.match(String(copy.reader.row("R1")?.audioText), /^a <span class="tag-anchor"[^>]*>LAMP<\/span>lamp b<span class="tag-anchor"[^>]*>X<\/span>$/);
});

test("a replacement inserts before it deletes, in one transaction", () => {
  const copy = one({ R1: "abcd" }), text = segmentText(copy, "b:R1") as Y.Text & Record<string, unknown>, calls: string[] = [];
  const insert = text.insert.bind(text), remove = text.delete.bind(text);
  text.insert = (...args: Parameters<Y.Text["insert"]>) => { calls.push("insert"); assert.ok(args[2] && typeof args[2] === "object"); insert(...args); };
  text.delete = (...args: Parameters<Y.Text["delete"]>) => { calls.push("delete"); remove(...args); };
  const selection = range(copy, NARRATION("R1"), 1, 3);
  let transactions = 0;
  copy.doc.on("afterTransaction", () => { transactions++; });
  assert.equal(replaceNativeText(copy, selection, [{ text: "X", marks: {} }]).kind, "written");
  assert.deepEqual(calls, ["insert", "delete"]);
  assert.equal(transactions, 1);
  assert.equal(narration(copy, "R1"), "aXd");
});

test("anchoring refuses a missing row, a bad range and a split surrogate pair", () => {
  const copy = one({ R1: "a🎬b" }), before = Y.encodeStateVector(copy.doc);
  for (const [target, from, to, reason] of [
    [NARRATION("R9"), 0, 0, "missing"], [VISUAL("R9"), 0, 0, "missing"], [NARRATION("R1"), 0, 5, "range"], [NARRATION("R1"), 2, 1, "range"],
    [NARRATION("R1"), 0.5, 1, "range"], [NARRATION("R1"), 2, 2, "range"], [NARRATION("R1"), 0, 2, "range"]
  ] as const) assert.deepEqual(anchorNativeText(copy, target, from, to), { kind: "refused", reason }, `${target.beat} ${from} ${to}`);
  assert.deepEqual(Y.encodeStateVector(copy.doc), before);
  assert.equal(narration(copy, "R1"), "a🎬b");
});

test("an empty edit is unchanged and writes nothing", () => {
  const copy = one({ R1: "abcd" }), before = Y.encodeStateVector(copy.doc);
  assert.equal(typeNativeText(copy, range(copy, NARRATION("R1"), 2), "", {}).kind, "unchanged");
  assert.equal(deleteNativeText(copy, range(copy, NARRATION("R1"), 3)).kind, "unchanged");
  assert.deepEqual(Y.encodeStateVector(copy.doc), before);
});

test("an edit stamp is written with the typing, once per change of stamp, also on deletion", () => {
  const copy = one({ R1: "abcd" });
  let edits = 0;
  copy.roots.edited.observe(() => { edits++; });
  const stamp = { by: "writer", at: "2026-11-19T10:00:00Z" };
  assert.equal(typeNativeText(copy, range(copy, NARRATION("R1"), 0), "x", {}, stamp).kind, "written");
  assert.equal(typeNativeText(copy, range(copy, NARRATION("R1"), 1), "y", {}, stamp).kind, "written");
  assert.equal(edits, 1);
  assert.deepEqual([copy.reader.row("R1")?.fields.updatedBy, copy.reader.row("R1")?.fields.updatedAt], [stamp.by, stamp.at]);
  assert.equal(typeNativeText(copy, range(copy, NARRATION("R1"), 2), "z", {}).kind, "written");
  assert.equal(deleteNativeText(copy, range(copy, NARRATION("R1"), 0, 1), { ...stamp, at: "2026-11-19T10:01:00Z" }).kind, "written");
  assert.equal(edits, 2);
});

test("the shown outline reads every row once, with nothing unplaced", () => {
  const { net, all: [a, b] } = copies(script({ R1: "ab", R2: "", R3: "cd" }));
  assert.ok(a && b);
  type(a, "R2", 0, "middle"); type(b, "R3", 2, "!");
  net.settle("twice");
  assert.deepEqual(net.agree(), ["R1: ab / ", "R2: middle / ", "R3: cd! / "]);
  assert.deepEqual(shown(a).filter(line => !line.startsWith("R")), []);
});

test("round 3, fix 2: a tag, comment or link id the string codec would change is refused and nothing is written", () => {
  const { net, all: [a, b] } = copies(script({ R1: "ab" }), 2);
  assert.ok(a && b);
  const before = Y.encodeStateVector(a.doc), at = range(a, NARRATION("R1"), 1);
  for (const marks of [{ tag: "t:prop:\ud800" }, { cmt: ["c\udc00"] }, { href: "https://x/\ud800" }] as Marks[]) {
    const outcome = typeNativeText(a, at, "x", marks);
    assert.ok(outcome.kind === "recovery" && outcome.reason === "text", JSON.stringify(marks));
  }
  assert.deepEqual(replaceNativeText(a, at, [{ atom: "who", name: "w\ud800", text: "@w\ud800", marks: {} } as Run]).kind, "recovery");
  assert.deepEqual(Y.encodeStateVector(a.doc), before);
  net.settle();
  assert.deepEqual(net.agree(), ["R1: ab / "]);
});

test("round 3, fix 3: the stamp is read once, before anything is written", () => {
  const copy = one({ R1: "ab" });
  let reads = 0;
  const stamp = { get by(): string { if (reads++) throw new Error("read twice"); return "writer"; }, at: "2026-11-19T10:00:00Z" };
  assert.equal(typeNativeText(copy, range(copy, NARRATION("R1"), 2), "c", {}, stamp).kind, "written");
  assert.equal(narration(copy, "R1"), "abc");
  assert.deepEqual(copy.roots.edited.get("R1"), { by: JSON.stringify("writer"), at: JSON.stringify(stamp.at) });
  const throwing = { get by(): string { throw new Error("no stamp"); }, at: "x" }, before = Y.encodeStateVector(copy.doc);
  assert.equal(typeNativeText(copy, range(copy, NARRATION("R1"), 3), "d", {}, throwing).kind, "recovery");
  assert.deepEqual(Y.encodeStateVector(copy.doc), before);
});

test("round 3, fix 6: a handle closes when its document is destroyed", () => {
  const copy = one({ R1: "ab" }), selection = range(copy, NARRATION("R1"), 0, 1);
  copy.doc.destroy();
  assert.equal(copy.closed(), true);
  assert.deepEqual(deleteNativeText(copy, selection), { kind: "recovery", reason: "closed", runs: [] });
  assert.deepEqual(anchorNativeText(copy, NARRATION("R1"), 0), { kind: "refused", reason: "closed" });
});

test("a script callback that throws during a command keeps the command's outcome, and the next command throws it before writing", () => {
  const copy = one({ R1: "ab" }), failure = new Error("detaching failed"), text = segmentText(copy, "b:R1");
  copy.reader.close = () => { throw failure; };
  copy.roots.segments.observeDeep(() => { copy.doc.destroy(); });
  let outcome = "";
  assert.doesNotThrow(() => { outcome = typeNativeText(copy, range(copy, NARRATION("R1"), 2), "c", {}).kind; });
  assert.deepEqual([outcome, text.toString(), copy.closed()], ["written", "abc", true]);
  assert.throws(() => anchorNativeText(copy, NARRATION("R1"), 0), failure);
  assert.deepEqual(anchorNativeText(copy, NARRATION("R1"), 0), { kind: "refused", reason: "closed" });
});

test("round 3, fix 6: a handle opened inside a running transaction is busy and refuses", () => {
  const copy = one({ R1: "ab" });
  let outcome = "", busy = false, second: NativeScript | null = null;
  copy.doc.transact(() => {
    second = openNativeScript(copy.doc);
    busy = second.busy();
    outcome = anchorNativeText(second, NARRATION("R1"), 0).kind;
  });
  assert.deepEqual([busy, outcome], [true, "refused"]);
  assert.ok(second);
  assert.equal((second as NativeScript).busy(), false);
  assert.equal(narration(copy, "R1"), "ab");
});

test("round 3, fix 6: a malformed relative position is a range refusal, not a throw", () => {
  const copy = one({ R1: "ab" }), before = Y.encodeStateVector(copy.doc), good = range(copy, NARRATION("R1"), 0, 1);
  for (const position of [Y.createRelativePositionFromJSON({ item: { client: 424242, clock: 3 }, assoc: 0 }), {} as Y.RelativePosition, null as unknown as Y.RelativePosition]) {
    assert.deepEqual(deleteNativeText(copy, { ...good, from: position }), { kind: "recovery", reason: "range", runs: [] });
  }
  assert.deepEqual(Y.encodeStateVector(copy.doc), before);
});

test("closing round, item 2: a position whose association is not a whole number of the expected sign is a range refusal", () => {
  const copy = one({ R1: "abc" }), before = Y.encodeStateVector(copy.doc), good = range(copy, NARRATION("R1"), 1, 2);
  const withAssoc = (position: Y.RelativePosition, assoc: number): Y.RelativePosition => Y.createRelativePositionFromJSON({ ...Y.relativePositionToJSON(position), assoc });
  for (const bad of [
    { ...good, from: withAssoc(good.from, NaN) }, { ...good, from: withAssoc(good.from, Infinity) }, { ...good, from: withAssoc(good.from, 0.5) },
    { ...good, from: withAssoc(good.from, -1) }, { ...good, to: withAssoc(good.to, NaN) }, { ...good, to: withAssoc(good.to, 0) }
  ]) assert.deepEqual(deleteNativeText(copy, bad), { kind: "recovery", reason: "range", runs: [] });
  assert.deepEqual(Y.encodeStateVector(copy.doc), before);
  assert.equal(narration(copy, "R1"), "abc");
  assert.equal(deleteNativeText(copy, good).kind, "written");
  assert.equal(narration(copy, "R1"), "ac");
});

test("round 3, item 8: a selection a peer typed into deletes what was typed too, as a live selection does", () => {
  const { net, all: [a, b] } = copies(script({ R1: "abcdef" }), 2);
  assert.ok(a && b);
  const selection = range(b, NARRATION("R1"), 2, 4);
  type(a, "R1", 3, "X"); net.deliver(a, b);
  assert.equal(narration(b, "R1"), "abcXdef");
  assert.equal(deleteNativeText(b, selection).kind, "written");
  assert.equal(narration(b, "R1"), "abef");
});

test("round 3, item 8: when a peer deleted both ends of a selection, the selection has collapsed and deletes nothing", () => {
  const { net, all: [a, b] } = copies(script({ R1: "abcdef" }), 2);
  assert.ok(a && b);
  const selection = range(b, NARRATION("R1"), 2, 4), typing = range(b, NARRATION("R1"), 2, 4);
  type(a, "R1", 3, "X"); cut(a, "R1", 4, 5); cut(a, "R1", 2, 3); net.deliver(a, b);
  assert.equal(narration(b, "R1"), "abXef");
  assert.equal(deleteNativeText(b, selection).kind, "unchanged");
  assert.equal(typeNativeText(b, typing, "Z", {}).kind, "written");
  assert.equal(narration(b, "R1"), "abZXef");
  net.settle();
  assert.deepEqual(net.agree(), ["R1: abZXef / "]);
});

test("a refused caret or selection, including root-named positions, leaves doc.share and encoded state unchanged", () => {
  const source = migrateRows({
    schema: 2, title: "Commands", docId: "doc-refused-caret", rev: 0,
    rows: [{ id: "R1", audioText: "abcd", visualText: "vis" }],
    sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }],
    comments: [], people: [], productionTags: [], brollShots: []
  });
  const copy = convertedScript(source, 2);
  try {
    const shareBefore = [...copy.doc.share.keys()].sort();
    const stateBefore = Y.encodeStateAsUpdate(copy.doc);
    const vectorBefore = Y.encodeStateVector(copy.doc);
    const goodCaret = range(copy, NARRATION("R1"), 1);
    const goodSelection = range(copy, NARRATION("R1"), 1, 3);
    const goodNameSelection = range(copy, { beat: "H1", cell: "name" }, 0, 2);
    const rootNamed = (tname: string, assoc = 0): Y.RelativePosition =>
      Y.createRelativePositionFromJSON({ type: null, tname, item: null, assoc });
    const roguePositions: readonly Y.RelativePosition[] = [
      rootNamed("rogue-root", 0),
      rootNamed("", 0),
      rootNamed("beats", 0),
      { type: goodCaret.from.type, tname: "rogue-with-type", item: null, assoc: 0 } as unknown as Y.RelativePosition,
      Y.createRelativePositionFromJSON({ type: { client: 999999, clock: 99 }, tname: null, item: null, assoc: 0 }),
      Y.createRelativePositionFromJSON({ type: goodCaret.from.type, tname: null, item: { client: 999999, clock: 99 }, assoc: 0 })
    ];
    for (const position of roguePositions) {
      const badCaret: NativeTextRange = { target: NARRATION("R1"), from: position, to: position };
      const badName: NativeTextRange = { target: { beat: "H1", cell: "name" }, from: position, to: position };
      assert.deepEqual(typeNativeText(copy, badCaret, "X", {}), { kind: "recovery", reason: "range", runs: [{ text: "X", marks: {} }] });
      assert.deepEqual(deleteNativeText(copy, badCaret), { kind: "recovery", reason: "range", runs: [] });
      assert.deepEqual(formatNativeText(copy, badCaret, { kind: "plain", mark: "b", on: true }), { kind: "refused", reason: "range" });
      assert.deepEqual(splitNativeRow(copy, badCaret), { kind: "refused", reason: "range" });
      assert.deepEqual(createNativeHeading(copy, badCaret, "H2", "Two"), { kind: "refused", reason: "range" });
      assert.deepEqual(renameNativeHeading(copy, badName, "Other"), { kind: "refused", reason: "range" });
    }
    const badSelectionEnd: NativeTextRange = { ...goodSelection, to: rootNamed("rogue-end", -1) };
    const badSelectionStart: NativeTextRange = { ...goodSelection, from: rootNamed("rogue-start", 0) };
    const badNameSelection: NativeTextRange = { ...goodNameSelection, to: rootNamed("rogue-name", -1) };
    for (const bad of [badSelectionEnd, badSelectionStart]) {
      assert.deepEqual(typeNativeText(copy, bad, "X", {}), { kind: "recovery", reason: "range", runs: [{ text: "X", marks: {} }] });
      assert.deepEqual(deleteNativeText(copy, bad), { kind: "recovery", reason: "range", runs: [] });
      assert.deepEqual(formatNativeText(copy, bad, { kind: "plain", mark: "b", on: true }), { kind: "refused", reason: "range" });
    }
    assert.deepEqual(renameNativeHeading(copy, badNameSelection, "Other"), { kind: "refused", reason: "range" });
    assert.deepEqual([...copy.doc.share.keys()].sort(), shareBefore);
    assert.equal(copy.doc.share.has("rogue-root"), false);
    assert.equal(copy.doc.share.has(""), false);
    assert.equal(copy.doc.share.has("rogue-with-type"), false);
    assert.equal(copy.doc.share.has("rogue-end"), false);
    assert.equal(copy.doc.share.has("rogue-start"), false);
    assert.equal(copy.doc.share.has("rogue-name"), false);
    assert.deepEqual(Y.encodeStateAsUpdate(copy.doc), stateBefore);
    assert.deepEqual(Y.encodeStateVector(copy.doc), vectorBefore);
  } finally { copy.doc.destroy(); }
});
