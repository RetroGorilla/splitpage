import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import { formatNativeText } from "../../../../src/adapters/collab/native/format-commands.ts";
import { createNativeHeading, removeNativeHeading, renameNativeHeading, restoreNativeHeading } from "../../../../src/adapters/collab/native/heading-commands.ts";
import { NativeScriptReader, readNativeOnce } from "../../../../src/adapters/collab/native/reader.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { anchorNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import { convertedScript, edit, joinedScript, ScriptNet } from "./helpers.ts";
import type { Delivery } from "./helpers.ts";
import { testNativeUndo } from "./undo-harness.ts";

after(() => { dom.window.close(); });

type Schedule = Delivery | "shuffled" | "state";
const SCHEDULES: readonly Schedule[] = ["forward", "reverse", "twice", "shuffled", "state"];
const narr = (beat: string) => ({ beat, cell: "narration" as const });
const nameOf = (beat: string) => ({ beat, cell: "name" as const });
const run = (text: string) => [{ text, marks: {} }];

function script(beats: string, headings: Readonly<Record<string, string>> = {}): NativeScript {
  const rows = [...beats].map(id => ({ id, audioText: id.toLowerCase(), visualText: "v" + id }));
  const sections = Object.entries(headings).map(([firstSceneId, id]) => ({ id, name: "Name " + id, firstSceneId }));
  return convertedScript(migrateRows({ schema: 2, title: "T", docId: "d", rev: 0, rows, sections, comments: [], people: [], productionTags: [], brollShots: [] }), 100);
}

function segment(copy: NativeScript, key: string): Y.Map<unknown> {
  const record = copy.roots.segments.get(key);
  assert.ok(record);
  return record;
}

function textOf(record: Y.Map<unknown>): Y.Text {
  const text: unknown = record.get("text");
  assert.ok(text instanceof Y.Text);
  return text;
}

function beatId(marker: unknown): string | null {
  if (!marker || typeof marker !== "object" || !("b" in marker)) return null;
  return typeof marker.b === "string" ? marker.b : null;
}

function cut(copy: NativeScript, ids: readonly string[]): void {
  copy.doc.transact(() => {
    for (const record of copy.roots.segments.values()) {
      const text = textOf(record), head = beatId(record.get("head"));
      const spans = [{ id: head, start: 0, end: 0 }];
      let at = 0;
      for (const item of text.toDelta() as { insert: unknown }[]) {
        if (typeof item.insert === "string") at += item.insert.length;
        else {
          at++;
          if (beatId(item.insert)) spans.push({ id: beatId(item.insert), start: at - 1, end: at });
        }
        const span = spans.at(-1);
        if (span) span.end = at;
      }
      for (const span of spans.toReversed()) {
        if (span.id && ids.includes(span.id) && span.end > span.start) text.delete(span.start, span.end - span.start);
      }
      if (head && ids.includes(head)) record.delete("head");
    }
  }, copy.origin);
}

function view(reader: NativeScriptReader) {
  return [
    reader.outline(), reader.rows(), reader.document(), reader.recovery(), reader.problems(), reader.unplaced(),
    reader.rows().flatMap(row => (row.members.length ? row.members : [row.id]).map(id => reader.narrationSpans(id)))
  ];
}

function lines(reader: NativeScriptReader): string[] {
  return reader.outline().map(entry => entry.kind === "heading" ? "#" + entry.id + "=" + entry.name : entry.id + "=" + reader.row(entry.id)?.audioText);
}

function check(copy: NativeScript, warm = copy.reader): void {
  const before = Y.encodeStateAsUpdate(copy.doc);
  readNativeOnce(copy.roots, fresh => {
    assert.deepEqual(view(warm), view(fresh), "warm and fresh");
    assert.deepEqual(Y.encodeStateAsUpdate(copy.doc), before, "reading wrote to Yjs");
    const seen = new Set<string>();
    for (const row of warm.rows()) for (const id of row.members) {
      assert.ok(!seen.has(id), "shown twice: " + id);
      seen.add(id);
      assert.ok(copy.roots.beats.has(id) && copy.roots.visuals.has(id), "shown without containers: " + id);
    }
    assert.deepEqual(warm.unplaced(), []);
    for (const row of warm.rows()) {
      if (row.members.length > 1 || !/^[a-zA-Z]*$/.test(row.audioText)) continue;
      assert.equal(anchorNativeText(copy, narr(row.id), 0, row.audioText.length).kind, "anchored", row.id + " is editable");
    }
  });
}

function storedNarration(copy: NativeScript): string[] {
  return [...copy.roots.segments.values()].flatMap(record => [...textOf(record).toString()]).sort();
}

function settle(a: NativeScript, b: NativeScript, net: ScriptNet, expected: readonly string[]): void {
  net.settle();
  const late = joinedScript(a, 900);
  try {
    for (const copy of [a, b, late]) {
      check(copy);
      assert.deepEqual(lines(copy.reader), expected);
      if (copy.reader.rows().every(row => row.members.length < 2 && /^[a-zA-Z]*$/.test(row.audioText))) {
        assert.deepEqual(copy.reader.rows().flatMap(row => [...row.audioText]).sort(), storedNarration(copy), "every stored letter is shown once");
      }
      assert.deepEqual(view(copy.reader), view(a.reader));
    }
  } finally { late.doc.destroy(); }
}

for (const item of [
  { title: "(a) E9 segment-head cut against typing", beats: "AB", heads: {}, id: "A", expected: ["B=xb"] },
  { title: "E9 embedded cut against typing", beats: "ABC", heads: {}, id: "B", expected: ["A=ax", "C=c"] },
  { title: "E9 tail cut against typing", beats: "ABC", heads: {}, id: "C", expected: ["A=a", "B=bx"] },
  { title: "(a) E9 single-beat segment cut with a preceding beat", beats: "AB", heads: { B: "H" }, id: "B", expected: ["A=ax", "#H=Name H"] },
  { title: "(b) E9 only beat cut against typing", beats: "A", heads: {}, id: "A", expected: ["~stray=x"] },
  { title: "(f) E11 heading followed by a surviving beat", beats: "ABC", heads: { B: "H" }, id: "B", expected: ["A=a", "#H=Name H", "C=xc"] },
  { title: "(f) E11 with no directly following beat or preceding beat", beats: "AB", heads: { A: "H", B: "I" }, id: "A", expected: ["#H=Name H", "#I=Name I", "B=xb"] },
  { title: "(f) E11 with no beat left", beats: "A", heads: { A: "H" }, id: "A", expected: ["~stray=x", "#H=Name H"] }
] as const) {
  test(item.title, () => {
    const a = script(item.beats, item.heads), b = joinedScript(a, 200), net = new ScriptNet([a, b]);
    try {
      for (const copy of [a, b]) check(copy);
      cut(a, [item.id]);
      check(a);
      assert.equal(edit(b, narr(item.id), 0, 0, run("x")).kind, "written");
      check(b);
      settle(a, b, net, item.expected);
      assert.equal(a.reader.row(item.id), null);
      assert.equal(a.roots.visuals.get(item.id)?.toString(), "v" + item.id);
      assert.deepEqual(a.reader.recovery(), []);
      assert.equal(anchorNativeText(a, { beat: item.id, cell: "visual" }, 0).kind, "refused");
    } finally { a.doc.destroy(); b.doc.destroy(); }
  });
}

test("(c) E11 and E14 double cut and double undo keeps two letters and one boundary owner", () => {
  const a = script("ABC"), b = joinedScript(a, 200), net = new ScriptNet([a, b]);
  const undo = [a, b].map(copy => testNativeUndo(copy));
  try {
    for (const copy of [a, b]) { check(copy); cut(copy, ["B"]); check(copy); }
    settle(a, b, net, ["A=a", "C=c"]);
    for (const [index, copy] of [a, b].entries()) { assert.ok(undo[index]?.undo()); check(copy); }
    settle(a, b, net, ["A=a", "B=bb", "C=c"]);
    assert.equal(a.reader.narrationSpans("B").length > 0, true);
  } finally { for (const manager of undo) manager.destroy(); a.doc.destroy(); b.doc.destroy(); }
});

test("(d) E9 a join to a cut beat stops counting and counts again when the cut is undone", () => {
  const a = script("ABC"), b = joinedScript(a, 200), net = new ScriptNet([a, b]);
  const undo = testNativeUndo(a);
  try {
    for (const copy of [a, b]) check(copy);
    cut(a, ["B"]);
    check(a);
    b.roots.beats.get("C")?.set("joined", { into: "B", glue: " " });
    check(b);
    assert.equal(b.reader.row("B")?.audioText, "b c");
    assert.deepEqual(b.reader.row("B")?.members, ["B", "C"]);
    assert.equal(edit(b, narr("C"), 1, 1, run("x")).kind, "written");
    settle(a, b, net, ["A=a", "C=cx"]);
    assert.deepEqual(a.reader.problems(), [{ kind: "join-not-read", where: "beats/C" }]);
    assert.ok(undo.undo());
    settle(a, b, net, ["A=a", "B=b cx"]);
    assert.deepEqual(a.reader.row("B")?.members, ["B", "C"]);
    assert.match(a.reader.row("B")?.visualText ?? "", /vB.*vC/s);
  } finally { undo.destroy(); a.doc.destroy(); b.doc.destroy(); }
});

test("(e) E14 the winning move's undo leaves no rank and the beat follows its narration neighbour", () => {
  const a = script("ABC", { C: "H" }), b = joinedScript(a, 200), net = new ScriptNet([a, b]);
  a.doc.clientID = 101;
  const record = b.roots.beats.get("B");
  assert.ok(record);
  const undo = testNativeUndo(b);
  try {
    for (const copy of [a, b]) check(copy);
    a.roots.beats.get("B")?.set("rank", "");
    b.doc.transact(() => { record.set("rank", "~"); }, b.origin);
    for (const copy of [a, b]) check(copy);
    settle(a, b, net, ["A=a", "#H=Name H", "C=c", "B=b"]);
    assert.ok(undo.undo());
    settle(a, b, net, ["A=a", "B=b", "#H=Name H", "C=c"]);
    assert.equal(a.roots.beats.get("B")?.has("rank"), false);
  } finally { undo.destroy(); a.doc.destroy(); b.doc.destroy(); }
});

test("E5 remove against rename, also when a heading is followed by recovered narration", () => {
  const genesis = script("AB", { B: "H" }), a = joinedScript(genesis, 150), b = joinedScript(genesis, 200), net = new ScriptNet([a, b]);
  genesis.doc.destroy();
  try {
    const rank = a.roots.headings.get("H")?.get("rank"), boundary = a.reader.headingBoundary("H", false);
    const anchored = anchorNativeText(b, nameOf("H"), 6);
    assert.equal(anchored.kind, "anchored");
    assert.equal(removeNativeHeading(a, "H").kind, "written");
    assert.equal(anchored.kind === "anchored" && renameNativeHeading(b, anchored.range, "X").kind, "written");
    cut(a, ["B"]);
    assert.equal(edit(b, narr("B"), 0, 0, run("x")).kind, "written");
    settle(a, b, net, ["A=ax"]);
    assert.deepEqual(a.reader.recovery(), [{ id: "H", name: "Name HX" }]);
    assert.equal(a.roots.headings.get("H")?.get("rank"), rank);
    assert.deepEqual(a.reader.headingBoundary("H", true), boundary);
    const state = Y.encodeStateAsUpdate(a.doc);
    assert.equal(anchored.kind === "anchored" && renameNativeHeading(a, anchored.range, "bad").kind, "refused");
    assert.deepEqual(Y.encodeStateAsUpdate(a.doc), state);
    assert.equal(restoreNativeHeading(a, "H").kind, "written");
    settle(a, b, net, ["A=ax", "#H=Name HX"]);
    assert.deepEqual(b.reader.recovery(), []);
  } finally { a.doc.destroy(); b.doc.destroy(); }
});

type HistoryStep = "split-start" | "split-end" | "sync" | "cut" | "cut-all" | "alice-undo" | "bob-undo" | "alice-redo" | "bob-redo";
const E17_BASES: readonly (readonly HistoryStep[])[] = [
  ["split-start", "sync", "cut", "sync", "alice-undo", "sync", "bob-undo", "sync"],
  ["split-end", "sync", "cut", "sync", "alice-undo", "sync", "bob-undo", "sync"],
  ["split-start", "sync", "cut-all", "sync", "alice-undo", "sync", "bob-undo", "sync"],
  ["split-start", "sync", "alice-undo", "cut", "sync", "bob-undo", "sync"],
  ["split-start", "sync", "cut", "bob-undo", "alice-undo", "sync"],
  ["split-start", "sync", "cut", "sync", "alice-undo", "bob-undo", "sync"]
];
const E17_CONTINUATIONS: readonly (readonly HistoryStep[])[] = [
  [],
  ["alice-redo", "sync", "bob-redo", "sync", "alice-undo", "sync"],
  ["bob-redo", "sync", "alice-redo", "sync", "bob-undo", "sync"]
];

function e17(mode: Schedule, missing: "record" | "visual" | "both", base: number, continuation: number) {
  const a = script("AB"), b = joinedScript(a, 200), record = segment(a, "b:A"), text = textOf(record);
  const scope: (Y.Text | Y.Map<Y.Map<unknown>> | Y.Map<Y.Text>)[] = [text];
  if (missing !== "visual") scope.push(a.roots.beats);
  if (missing !== "record") scope.push(a.roots.visuals);
  const undoA = missing === "both" ? testNativeUndo(a) : new Y.UndoManager(scope, { trackedOrigins: new Set([a.origin]), captureTimeout: 0 });
  const undoB = testNativeUndo(b);
  const updatesA: Uint8Array[] = [], updatesB: Uint8Array[] = [];
  const capture = (list: Uint8Array[]) => (update: Uint8Array, origin: unknown): void => { if (origin !== "remote") list.push(update); };
  a.doc.on("update", capture(updatesA)); b.doc.on("update", capture(updatesB));
  const send = (from: NativeScript, to: NativeScript, queue: Uint8Array[]): void => {
    let packets = queue.splice(0);
    if (mode === "state") packets = [Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc))];
    if (mode === "reverse") packets.reverse();
    if (mode === "twice") packets = [...packets, ...packets];
    if (mode === "shuffled") packets = [...packets.filter((_, at) => at % 2 === 1), ...packets.filter((_, at) => at % 2 === 0)];
    for (const packet of packets) { Y.applyUpdate(to.doc, packet, "remote"); check(to); }
  };
  const sync = (): void => { send(b, a, updatesB); send(a, b, updatesA); assert.deepEqual(view(a.reader), view(b.reader)); };
  let hiddenWithMarker = false;
  try {
    for (const copy of [a, b]) check(copy);
    for (const step of [...E17_BASES[base] ?? [], ...E17_CONTINUATIONS[continuation] ?? []]) {
      if (step === "split-start" || step === "split-end") {
        a.doc.transact(() => {
          text.insertEmbed(step === "split-start" ? 2 : 3, { b: "N" }, {});
          const created = new Y.Map<unknown>();
          a.roots.beats.set("N", created);
          created.set("rank", a.roots.beats.get("B")?.get("rank"));
          a.roots.visuals.set("N", new Y.Text());
        }, a.origin);
      } else if (step === "sync") sync();
      else if (step === "cut") cut(b, ["N"]);
      else if (step === "cut-all") cut(b, ["A", "B", "N"]);
      else if (step === "alice-undo") assert.ok(undoA.undo());
      else if (step === "bob-undo") assert.ok(undoB.undo());
      else if (step === "alice-redo") assert.ok(undoA.redo());
      else assert.ok(undoB.redo());
      for (const copy of [a, b]) {
        check(copy);
        const marker = (textOf(segment(copy, "b:A")).toDelta() as { insert: unknown }[]).some(item => beatId(item.insert) === "N");
        if (marker && (!copy.roots.beats.has("N") || !copy.roots.visuals.has("N"))) {
          assert.equal(copy.reader.row("N"), null);
          assert.equal(anchorNativeText(copy, narr("N"), 0).kind, "refused");
          assert.equal(anchorNativeText(copy, { beat: "N", cell: "visual" }, 0).kind, "refused");
          assert.deepEqual(copy.reader.problems().filter(problem => problem.where.endsWith("/N")).map(problem => problem.kind),
            [...copy.roots.beats.has("N") ? [] : ["missing-beat-record"], ...copy.roots.visuals.has("N") ? [] : ["missing-visual"]]);
          hiddenWithMarker = true;
        }
      }
    }
    const expected = continuation === 1 ? base === 2 ? [] : ["A=a", base === 1 ? "B=b" : "B="]
      : continuation === 2 ? base === 1 ? ["A=a", "B=b", "N="] : ["A=a", "B=", "N=b"] : ["A=a", "B=b"];
    const late = joinedScript(a, 900);
    try {
      for (const copy of [a, b, late]) {
        check(copy);
        assert.deepEqual(lines(copy.reader), expected, [mode, missing, base, continuation].join(" "));
        assert.deepEqual(copy.reader.rows().flatMap(row => [...row.audioText]).sort(), storedNarration(copy));
        assert.deepEqual(view(a.reader), view(copy.reader));
      }
    } finally { late.doc.destroy(); }
    return hiddenWithMarker;
  } finally { undoA.destroy(); undoB.destroy(); a.doc.destroy(); b.doc.destroy(); }
}

for (const missing of ["both", "record", "visual"] as const) {
  test("(g) E17's 18 histories in five deliveries, missing " + missing, t => {
    let hidden = 0, runs = 0;
    for (const mode of SCHEDULES) for (const base of E17_BASES.keys()) for (const continuation of E17_CONTINUATIONS.keys()) {
      if (e17(mode, missing, base, continuation)) hidden++;
      runs++;
    }
    assert.equal(runs, 90);
    assert.equal(hidden, 90);
    t.diagnostic(runs + " histories, " + hidden + " reached a hidden marker, zero divergent or invalid readings");
  });
}

test("E17's seam stays before the hidden marker and a formatted selection skips the marker", () => {
  const a = script("AB"), b = joinedScript(a, 200), net = new ScriptNet([a, b]);
  const raw = textOf(segment(a, "b:A"));
  try {
    raw.insertEmbed(2, { b: "N" }, {});
    settle(a, b, net, ["A=a", "B=b"]);
    assert.equal(edit(a, narr("B"), 0, 0, run("s")).kind, "written");
    assert.equal(edit(a, narr("B"), 2, 2, run("e")).kind, "written");
    assert.deepEqual(raw.toDelta(), [{ insert: "a" }, { insert: { b: "B" } }, { insert: "s" }, { insert: { b: "N" } }, { insert: "be" }]);
    const anchored = anchorNativeText(a, narr("B"), 0, 3);
    assert.equal(anchored.kind, "anchored");
    assert.equal(anchored.kind === "anchored" && formatNativeText(a, anchored.range, { kind: "plain", mark: "b", on: true }).kind, "written");
    settle(a, b, net, ["A=a", "B=<strong>sbe</strong>"]);
    assert.deepEqual(raw.toDelta().filter((item: { insert: unknown }) => typeof item.insert === "object"), [{ insert: { b: "B" } }, { insert: { b: "N" } }]);
    assert.equal(edit(a, narr("B"), 0, 3, run("x")).kind, "written");
    settle(a, b, net, ["A=a", "B=x"]);
  } finally { a.doc.destroy(); b.doc.destroy(); }
});

test("rule (g) reassigns a prefix in a different segment without reparsing either segment when the cell returns", () => {
  const a = script("AB", { B: "H" }), b = joinedScript(a, 200), net = new ScriptNet([a, b]);
  try {
    b.roots.visuals.delete("B");
    settle(a, b, net, ["A=ab", "#H=Name H"]);
    assert.equal(edit(a, narr("A"), 2, 2, run("x")).kind, "written");
    settle(a, b, net, ["A=abx", "#H=Name H"]);
    b.roots.visuals.set("B", new Y.Text());
    const before = a.reader.counts();
    settle(a, b, net, ["A=a", "#H=Name H", "B=bx"]);
    assert.equal(a.reader.counts().parses, before.parses);
  } finally { a.doc.destroy(); b.doc.destroy(); }
});

function generatedHeadings(seed: number, observing: boolean): void {
  const a = script("AB", { B: "H" }), reader = observing ? a.reader : new NativeScriptReader(a.roots, () => () => undefined);
  try {
    let name = "Name H", removed = false, missing = false;
    const assertStep = (step: number): void => {
      const expected = missing ? ["A=ab"] : ["A=a"];
      if (!removed) expected.push("#H=" + name);
      if (!missing) expected.push("B=b");
      assert.deepEqual(lines(reader), expected, "generated seed " + seed + " step " + step);
      assert.deepEqual(reader.recovery(), removed ? [{ id: "H", name }] : []);
      check(a, reader);
    };
    assertStep(-1);
    for (let step = 0; step < 24; step++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      if ((seed >>> 30) === 0) {
        if (removed) assert.equal(restoreNativeHeading(a, "H").kind, "written");
        else assert.equal(removeNativeHeading(a, "H").kind, "written");
        removed = !removed;
      } else if ((seed >>> 30) === 1) {
        if (missing) a.roots.visuals.set("B", new Y.Text());
        else a.roots.visuals.delete("B");
        missing = !missing;
      } else if (!removed) {
        const at = seed % (name.length + 1), next = String.fromCharCode(65 + seed % 26);
        const anchored = anchorNativeText(a, nameOf("H"), at);
        assert.equal(anchored.kind, "anchored");
        assert.equal(anchored.kind === "anchored" && renameNativeHeading(a, anchored.range, next).kind, "written");
        name = name.slice(0, at) + next + name.slice(at);
      }
      assertStep(step);
    }
  } finally { reader.close(); a.doc.destroy(); }
}

test("generated heading commands and missing visual cells match the steps and a fresh reader after every step", () => {
  for (let seed = 1; seed <= 24; seed++) generatedHeadings(seed, true);
});

test("control: the same generated loop rejects disabled invalidation", () => {
  for (let seed = 1; seed <= 24; seed++) assert.throws(() => generatedHeadings(seed, false), /generated seed \d+ step \d+/);
});

test("heading commands refuse busy, stale and malformed targets before writing", () => {
  const a = script("A", { A: "H" });
  try {
    const anchored = anchorNativeText(a, nameOf("H"), 0, 1);
    assert.equal(anchored.kind, "anchored");
    if (anchored.kind !== "anchored") return;
    const { range } = anchored, original = Y.encodeStateAsUpdate(a.doc);
    a.doc.transact(() => {
      assert.deepEqual(renameNativeHeading(a, range, "X"), { kind: "refused", reason: "busy" });
      assert.deepEqual(removeNativeHeading(a, "H"), { kind: "refused", reason: "busy" });
      assert.deepEqual(restoreNativeHeading(a, "H"), { kind: "refused", reason: "busy" });
    });
    assert.deepEqual(renameNativeHeading(a, range, "\ud800"), { kind: "refused", reason: "text" });
    assert.deepEqual(removeNativeHeading(a, "\ud800"), { kind: "refused", reason: "missing" });
    assert.deepEqual(restoreNativeHeading(a, "H"), { kind: "refused", reason: "missing" });
    assert.deepEqual(renameNativeHeading(a, range, "N"), { kind: "unchanged" });
    assert.deepEqual(Y.encodeStateAsUpdate(a.doc), original);
    a.roots.headings.get("H")?.delete("rank");
    assert.equal(removeNativeHeading(a, "H").kind, "written");
    assert.deepEqual(a.reader.recovery(), [{ id: "H", name: "Name H" }]);
    assert.equal(restoreNativeHeading(a, "H").kind, "written");
    assert.equal(a.roots.headings.get("H")?.has("rank"), false);
  } finally { a.doc.destroy(); }
});

test("E5 a restore that has only seen one of two removals leaves the unseen removal in effect", () => {
  const genesis = script("A", { A: "H" }), a = joinedScript(genesis, 150), b = joinedScript(genesis, 200), net = new ScriptNet([a, b]);
  genesis.doc.destroy();
  try {
    for (const copy of [a, b]) check(copy);
    assert.equal(removeNativeHeading(a, "H").kind, "written");
    assert.equal(removeNativeHeading(b, "H").kind, "written");
    assert.equal(restoreNativeHeading(a, "H").kind, "written");
    assert.deepEqual(lines(a.reader), ["#H=Name H", "A=a"]);
    settle(a, b, net, ["A=a"]);
    assert.deepEqual(a.reader.recovery(), [{ id: "H", name: "Name H" }]);
  } finally { a.doc.destroy(); b.doc.destroy(); }
});

test("plain Yjs can restore a marker and its narration after the creation of its record was undone", () => {
  const a = new Y.Doc(), b = new Y.Doc(), alice = {}, bob = {};
  a.clientID = 11; b.clientID = 22;
  const text = a.getText("text"), record = a.getMap("record"), peerText = b.getText("text"), peerRecord = b.getMap("record");
  const send = (from: Y.Doc, to: Y.Doc): void => { Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to))); };
  text.insert(0, "b", {});
  const create = new Y.UndoManager([text, record], { trackedOrigins: new Set([alice]) });
  const remove = new Y.UndoManager(peerText, { trackedOrigins: new Set([bob]) });
  try {
    a.transact(() => { text.insertEmbed(0, { b: "N" }, {}); record.set("N", { rank: "r" }); }, alice);
    send(a, b);
    b.transact(() => { peerText.delete(0, 2); }, bob);
    send(b, a);
    assert.ok(create.undo());
    send(a, b);
    assert.ok(remove.undo());
    send(b, a);
    for (const [cell, fields] of [[text, record], [peerText, peerRecord]] as const) {
      assert.deepEqual(cell.toDelta(), [{ insert: { b: "N" } }, { insert: "b" }]);
      assert.equal(fields.has("N"), false);
    }
  } finally { create.destroy(); remove.destroy(); a.destroy(); b.destroy(); }
});

test("plain Yjs undo of the winning concurrent rank erases the key", () => {
  const seed = new Y.Doc(), a = new Y.Doc(), b = new Y.Doc(), origin = {};
  seed.clientID = 1; a.clientID = 2; b.clientID = 3;
  seed.getMap("record").set("rank", "m");
  const left = a.getMap("record"), right = b.getMap("record");
  const send = (from: Y.Doc, to: Y.Doc): void => { Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to))); };
  send(seed, a); send(seed, b);
  const undo = new Y.UndoManager(right, { trackedOrigins: new Set([origin]) });
  try {
    left.set("rank", "a");
    b.transact(() => { right.set("rank", "z"); }, origin);
    send(a, b); send(b, a);
    assert.deepEqual([left.get("rank"), right.get("rank")], ["z", "z"]);
    assert.ok(undo.undo());
    send(b, a);
    assert.deepEqual([left.has("rank"), right.has("rank")], [false, false]);
  } finally { undo.destroy(); seed.destroy(); a.destroy(); b.destroy(); }
});

test("joined fields show the highest status and both galleries, with diagnostics for fields that have no place", () => {
  const a = script("AB"), b = joinedScript(a, 200), net = new ScriptNet([a, b]);
  const left = { sha256: "a".repeat(64), mime: "image/png", width: 10, height: 20 }, right = { ...left, sha256: "b".repeat(64) };
  try {
    for (const copy of [a, b]) check(copy);
    const upper = a.roots.beats.get("A"), lower = b.roots.beats.get("B");
    assert.ok(upper && lower);
    a.doc.transact(() => {
      upper.set("status", JSON.stringify("ready"));
      upper.set("gallery", JSON.stringify({ imageRef: left, imageName: "Upper" }));
    });
    b.doc.transact(() => {
      lower.set("status", JSON.stringify("todo"));
      lower.set("gallery", JSON.stringify({ imageRef: right, imageName: "Lower" }));
      lower.set('f:"note"', JSON.stringify("lower note"));
      lower.set("joined", { into: "A", glue: " " });
    });
    settle(a, b, net, ["A=a b"]);
    assert.equal(a.reader.row("A")?.fields.status, "ready");
    lower.set("status", JSON.stringify("shot"));
    assert.deepEqual(b.reader.refresh().rows, ["A"]);
    settle(a, b, net, ["A=a b"]);
    const late = joinedScript(a, 901);
    try {
      for (const copy of [a, b, late]) {
        const fields = copy.reader.row("A")?.fields, exported = copy.reader.document().rows[0];
        for (const row of [fields, exported]) {
          assert.equal(row?.status, "shot");
          assert.deepEqual(row?.imageRef, left);
          assert.equal(row?.imageName, "Upper");
          assert.deepEqual(row?.moreImages, [{ imageRef: right, name: "Lower" }]);
        }
        assert.deepEqual(copy.reader.problems(), [
          { kind: "joined-field-not-shown", where: "beats/A/status" },
          { kind: "joined-field-not-shown", where: "beats/B/note" }
        ]);
      }
    } finally { late.doc.destroy(); }
    b.doc.transact(() => {
      lower.set("gallery", JSON.stringify({ imageRef: left, imageName: "Different name" }));
      lower.delete('f:"note"');
    });
    settle(a, b, net, ["A=a b"]);
    const duplicate = joinedScript(a, 902);
    try {
      for (const copy of [a, b, duplicate]) {
        assert.equal(copy.reader.row("A")?.fields.imageName, "Upper");
        assert.equal(copy.reader.row("A")?.fields.moreImages, undefined);
        assert.deepEqual(copy.reader.problems(), [
          { kind: "joined-field-not-shown", where: "beats/A/status" },
          { kind: "joined-field-not-shown", where: "beats/B/image" }
        ]);
      }
    } finally { duplicate.doc.destroy(); }
    lower.delete("joined");
    settle(a, b, net, ["A=a", "B=b"]);
    assert.equal(a.reader.row("B")?.fields.imageName, "Different name");
    assert.deepEqual(a.reader.problems(), []);
  } finally { a.doc.destroy(); b.doc.destroy(); }
});

test("a heading can be removed and restored when the winning concurrent rank is undone", () => {
  const genesis = script("A", { A: "H" }), a = joinedScript(genesis, 150), b = joinedScript(genesis, 200), net = new ScriptNet([a, b]);
  genesis.doc.destroy();
  const left = a.roots.headings.get("H"), right = b.roots.headings.get("H");
  assert.ok(left && right);
  const undo = testNativeUndo(b);
  try {
    for (const copy of [a, b]) check(copy);
    left.set("rank", "1");
    b.doc.transact(() => { right.set("rank", "0"); }, b.origin);
    settle(a, b, net, ["#H=Name H", "A=a"]);
    assert.equal(left.get("rank"), "0");
    assert.ok(undo.undo());
    settle(a, b, net, ["#H=Name H", "A=a"]);
    assert.equal(left.has("rank"), false);
    assert.equal(removeNativeHeading(a, "H").kind, "written");
    settle(a, b, net, ["A=a"]);
    assert.deepEqual(b.reader.recovery(), [{ id: "H", name: "Name H" }]);
    assert.equal(restoreNativeHeading(b, "H").kind, "written");
    settle(a, b, net, ["#H=Name H", "A=a"]);
    assert.equal(left.has("rank"), false);
    assert.equal(right.has("rank"), false);
  } finally { undo.destroy(); a.doc.destroy(); b.doc.destroy(); }
});

test("one-shot readers close before the next document change and new reads see the update", () => {
  const a = script("AB"), b = joinedScript(a, 200), net = new ScriptNet([a, b]);
  try {
    const closed = [a, b].map(copy => readNativeOnce(copy.roots, reader => {
      assert.deepEqual(lines(reader), ["A=a", "B=b"]);
      return reader;
    }));
    assert.equal(edit(b, narr("B"), 1, 1, run("x")).kind, "written");
    settle(a, b, net, ["A=a", "B=bx"]);
    const late = joinedScript(a, 901);
    try {
      for (const reader of closed) assert.throws(() => reader.outline(), /closed/);
      for (const copy of [a, b, late]) {
        assert.deepEqual(readNativeOnce(copy.roots, lines), ["A=a", "B=bx"]);
        const escaped = readNativeOnce(copy.roots, reader => reader);
        assert.throws(() => escaped.row("B"), /closed/);
      }
    } finally { late.doc.destroy(); }
  } finally { a.doc.destroy(); b.doc.destroy(); }
});

function caretAt(copy: NativeScript, id: string) {
  const anchored = anchorNativeText(copy, narr(id), 0);
  assert.equal(anchored.kind, "anchored");
  return anchored.range;
}

test("create a heading above the first row and between rows, with names only in their cells", () => {
  const a = script("ABC"), b = joinedScript(a, 200), net = new ScriptNet([a, b]);
  try {
    for (const copy of [a, b]) check(copy);
    assert.equal(createNativeHeading(a, caretAt(a, "A"), "H1", "Top").kind, "written");
    settle(a, b, net, ["#H1=Top", "A=a", "B=b", "C=c"]);
    assert.equal(createNativeHeading(b, caretAt(b, "B"), "H2", "Between").kind, "written");
    settle(a, b, net, ["#H1=Top", "A=a", "#H2=Between", "B=b", "C=c"]);
    const late = joinedScript(a, 901);
    try {
      for (const copy of [a, b, late]) {
        assert.deepEqual(copy.roots.order.toArray(), ["h:H1", "b:A"]);
        assert.deepEqual(segment(copy, "h:H1").get("head"), { h: "H1" });
        assert.deepEqual(textOf(segment(copy, "b:A")).toDelta(), [
          { insert: "a" }, { insert: { h: "H2" } }, { insert: { b: "B" } }, { insert: "b" },
          { insert: { b: "C" } }, { insert: "c" }
        ]);
        assert.equal(copy.roots.names.size, 2);
        assert.deepEqual(["H1", "H2"].map(id => copy.roots.names.get(id)?.toString()), ["Top", "Between"]);
      }
    } finally { late.doc.destroy(); }
  } finally { a.doc.destroy(); b.doc.destroy(); }
});

test("a tie between adjacent rows refuses heading creation before writing on every copy", () => {
  const a = script("AB"), b = joinedScript(a, 200), net = new ScriptNet([a, b]);
  try {
    a.roots.beats.get("B")?.set("rank", a.roots.beats.get("A")?.get("rank"));
    settle(a, b, net, ["A=a", "B=b"]);
    const late = joinedScript(a, 901);
    try {
      for (const copy of [a, b, late]) {
        const before = Y.encodeStateAsUpdate(copy.doc);
        assert.deepEqual(createNativeHeading(copy, caretAt(copy, "B"), "H", "Tied"), { kind: "refused", reason: "rank" });
        assert.deepEqual(Y.encodeStateAsUpdate(copy.doc), before);
      }
    } finally { late.doc.destroy(); }
  } finally { a.doc.destroy(); b.doc.destroy(); }
});

test("create a heading above a rankless beat using its inherited rank", () => {
  const a = script("ABC", { B: "Old" }), b = joinedScript(a, 200), net = new ScriptNet([a, b]);
  try {
    assert.equal(removeNativeHeading(a, "Old").kind, "written");
    b.roots.beats.get("B")?.delete("rank");
    settle(a, b, net, ["A=a", "B=b", "C=c"]);
    assert.equal(a.reader.ranksAboveBeat("B")?.after, a.roots.headings.get("Old")?.get("rank"));
    assert.equal(createNativeHeading(a, caretAt(a, "B"), "H", "New scene").kind, "written");
    settle(a, b, net, ["A=a", "#H=New scene", "B=b", "C=c"]);
    const late = joinedScript(a, 901);
    try {
      for (const copy of [a, b, late]) {
        assert.equal(copy.roots.beats.get("B")?.has("rank"), false);
        const rank: unknown = copy.roots.headings.get("H")?.get("rank");
        assert.ok(typeof rank === "string" && rank < String(copy.roots.headings.get("Old")?.get("rank")));
      }
    } finally { late.doc.destroy(); }
  } finally { a.doc.destroy(); b.doc.destroy(); }
});

test("a leading rankless beat can follow a new heading without passing the next ranked beat", () => {
  const a = script("AB"), b = joinedScript(a, 200), net = new ScriptNet([a, b]);
  try {
    b.roots.beats.get("A")?.delete("rank");
    settle(a, b, net, ["A=a", "B=b"]);
    assert.equal(createNativeHeading(a, caretAt(a, "B"), "BeforeB", "Before B").kind, "written");
    settle(a, b, net, ["A=a", "#BeforeB=Before B", "B=b"]);
    assert.equal(createNativeHeading(b, caretAt(b, "A"), "Top", "Before A").kind, "written");
    settle(a, b, net, ["#Top=Before A", "A=a", "#BeforeB=Before B", "B=b"]);
    assert.equal(a.roots.beats.get("A")?.has("rank"), false);
  } finally { a.doc.destroy(); b.doc.destroy(); }
});

for (const target of ["A", "B"] as const) {
  test("same-gap heading creations both survive in stored tie order above " + target, () => {
    const genesis = script("ABC"), a = joinedScript(genesis, 150), b = joinedScript(genesis, 200), net = new ScriptNet([a, b]);
    genesis.doc.destroy();
    try {
      assert.equal(createNativeHeading(a, caretAt(a, target), "H1", "First").kind, "written");
      assert.equal(createNativeHeading(b, caretAt(b, target), "H2", "Second").kind, "written");
      const tail = ["#H1=First", "#H2=Second", ...target === "A" ? ["A=a"] : [], "B=b", "C=c"];
      settle(a, b, net, target === "A" ? tail : ["A=a", ...tail]);
      const rank = a.roots.headings.get("H1")?.get("rank");
      assert.equal(a.roots.headings.get("H2")?.get("rank"), rank);
      if (target === "B") {
        const raw = textOf(segment(a, "b:A"));
        a.doc.transact(() => {
          raw.insertEmbed(2, { b: "N" }, {});
          const record = new Y.Map<unknown>();
          a.roots.beats.set("N", record);
          record.set("rank", rank);
          a.roots.visuals.set("N", new Y.Text());
        });
        settle(a, b, net, ["A=a", "#H1=First", "N=", "#H2=Second", "B=b", "C=c"]);
        const late = joinedScript(a, 901);
        try {
          for (const copy of [a, b, late]) {
            const before = Y.encodeStateAsUpdate(copy.doc);
            assert.deepEqual(createNativeHeading(copy, caretAt(copy, "N"), "H3", "In the tie"), { kind: "refused", reason: "rank" });
            assert.deepEqual(Y.encodeStateAsUpdate(copy.doc), before);
          }
        } finally { late.doc.destroy(); }
      }
    } finally { a.doc.destroy(); b.doc.destroy(); }
  });
}

for (const concurrent of ["cut", "split"] as const) {
  test("a heading survives when a peer performs a concurrent " + concurrent + " of its row", () => {
    const a = script("AB"), b = joinedScript(a, 200), net = new ScriptNet([a, b]);
    try {
      assert.equal(createNativeHeading(a, caretAt(a, "B"), "H", "Section").kind, "written");
      if (concurrent === "cut") cut(b, ["B"]);
      else b.doc.transact(() => {
        textOf(segment(b, "b:A")).insertEmbed(2, { b: "N" }, {});
        const record = new Y.Map<unknown>();
        b.roots.beats.set("N", record);
        record.set("rank", b.roots.beats.get("B")?.get("rank"));
        b.roots.visuals.set("N", new Y.Text());
      });
      settle(a, b, net, concurrent === "cut" ? ["A=a", "#H=Section"] : ["A=a", "#H=Section", "B=", "N=b"]);
    } finally { a.doc.destroy(); b.doc.destroy(); }
  });
}

test("a new heading keeps the row's recovered prefix and refuses stale and duplicate targets before writing", () => {
  const a = script("ABC", { B: "Old" }), b = joinedScript(a, 200), net = new ScriptNet([a, b]);
  try {
    cut(a, ["B"]);
    assert.equal(edit(b, narr("B"), 0, 0, run("x")).kind, "written");
    settle(a, b, net, ["A=a", "#Old=Name Old", "C=xc"]);
    const caret = caretAt(b, "C");
    assert.equal(createNativeHeading(b, caret, "H", "Recovered").kind, "written");
    settle(a, b, net, ["A=a", "#Old=Name Old", "#H=Recovered", "C=xc"]);
    const before = Y.encodeStateAsUpdate(b.doc), fresh = caretAt(b, "C");
    b.doc.transact(() => { assert.deepEqual(createNativeHeading(b, fresh, "Busy", "N"), { kind: "refused", reason: "busy" }); });
    assert.deepEqual(createNativeHeading(b, fresh, "H", "Duplicate"), { kind: "refused", reason: "missing" });
    assert.deepEqual(createNativeHeading(b, fresh, "\ud800", "Invalid"), { kind: "refused", reason: "missing" });
    assert.deepEqual(createNativeHeading(b, fresh, "Invalid", "\ud800"), { kind: "refused", reason: "text" });
    assert.deepEqual(Y.encodeStateAsUpdate(b.doc), before);
    cut(a, ["C"]);
    net.settle();
    const late = joinedScript(a, 901);
    try {
      for (const copy of [a, b, late]) {
        const initial = Y.encodeStateAsUpdate(copy.doc);
        assert.deepEqual(createNativeHeading(copy, fresh, "NoTarget", "Stale"), { kind: "refused", reason: "missing" });
        assert.deepEqual(Y.encodeStateAsUpdate(copy.doc), initial);
      }
    } finally { late.doc.destroy(); }
  } finally { a.doc.destroy(); b.doc.destroy(); }
});

test("heading creation preserves all narration with a recovered segment prefix and intervening heading", () => {
  const prefix = Array.from({ length: 30 }, (_, index) => ({ id: "P" + index, audioText: "p" + index }));
  const rows = [...prefix, { id: "B", audioText: "b" }, { id: "C", audioText: "c" }].map(row => ({ ...row, visualText: "" }));
  const a = convertedScript(migrateRows({ schema: 2, docId: "heading-prefix", title: "T", rev: 0, rows }), 100);
  const b = joinedScript(a, 200), observer = joinedScript(a, 300), net = new ScriptNet([a, b, observer]);
  try {
    assert.deepEqual(a.roots.order.toArray(), ["b:P0", "b:B"]);
    assert.equal(createNativeHeading(a, caretAt(a, "C"), "Existing", "Existing").kind, "written");
    net.settle();
    a.doc.transact(() => {
      const record = segment(a, "b:B");
      record.delete("head");
      textOf(record).delete(0, 1);
    }, a.origin);
    assert.equal(edit(b, narr("B"), 0, 0, run("X")).kind, "written");
    const leading = prefix.map(row => row.id + "=" + row.audioText);
    settle(a, b, net, [...leading, "#Existing=Existing", "C=Xc"]);
    assert.deepEqual(lines(observer.reader), [...leading, "#Existing=Existing", "C=Xc"]);
    const before = a.reader.rows().map(row => [row.id, row.audioText]);
    assert.equal(createNativeHeading(a, caretAt(a, "C"), "New", "New").kind, "written");
    assert.deepEqual(a.reader.rows().map(row => [row.id, row.audioText]), before);
    settle(a, b, net, [...leading, "#Existing=Existing", "#New=New", "C=Xc"]);
    assert.deepEqual(lines(observer.reader), [...leading, "#Existing=Existing", "#New=New", "C=Xc"]);
  } finally { a.doc.destroy(); b.doc.destroy(); observer.doc.destroy(); }
});

test("empty and non-string stored rank bounds refuse heading creation without writing", () => {
  const a = script("AB"), b = joinedScript(a, 200), net = new ScriptNet([a, b]);
  try {
    for (const rank of ["", 17]) {
      a.roots.beats.get("A")?.set("rank", rank);
      settle(a, b, net, ["A=a", "B=b"]);
      const late = joinedScript(a, 901);
      try {
        for (const copy of [a, b, late]) {
          const before = Y.encodeStateAsUpdate(copy.doc);
          assert.deepEqual(createNativeHeading(copy, caretAt(copy, "B"), "H", "Heading"), { kind: "refused", reason: "rank" });
          assert.deepEqual(Y.encodeStateAsUpdate(copy.doc), before);
        }
      } finally { late.doc.destroy(); }
    }
  } finally { a.doc.destroy(); b.doc.destroy(); }
});
