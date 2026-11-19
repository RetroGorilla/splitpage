import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import type { ValidatedDocument } from "../../../../src/core/document/validated.ts";
import { setMark } from "../../../../src/core/text/edits.ts";
import type { MarkName, Run } from "../../../../src/core/text/runs.ts";
import { formatNativeText } from "../../../../src/adapters/collab/native/format-commands.ts";
import type { NativeFormatOutcome, NativeMarkChange } from "../../../../src/adapters/collab/native/format-commands.ts";
import { nativeMarkName } from "../../../../src/adapters/collab/native/inline.ts";
import type { NativeDeltaItem } from "../../../../src/adapters/collab/native/inline.ts";
import { nativeSegmentSpans } from "../../../../src/adapters/collab/native/reader.ts";
import { closeNativeScript } from "../../../../src/adapters/collab/native/script.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { anchorNativeText, deleteNativeText, replaceNativeText, typeNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import type { NativeTextRange, NativeTextTarget } from "../../../../src/adapters/collab/native/text-commands.ts";
import { printCell, readCell } from "./format-harness.ts";
import { ScriptNet, cells, convertedScript, joinedScript } from "./helpers.ts";

after(() => { dom.window.close(); });

const NARRATION = (beat: string): NativeTextTarget => ({ beat, cell: "narration" });
const VISUAL = (beat: string): NativeTextTarget => ({ beat, cell: "visual" });
const LAMP = "t:prop:lamp", ROPE = "t:prop:rope";
const BOLD: NativeMarkChange = { kind: "plain", mark: "b", on: true };
const ANCHOR = (name: string): string => `<span class="tag-anchor" data-tag-cat="prop" data-tag-name="${name}" contenteditable="false">`;
const tag = (id: string, on = true): NativeMarkChange => ({ kind: "tag", id, on });

function source(rows: Record<string, string>, visuals: Record<string, string> = {}): ValidatedDocument {
  return migrateRows({
    schema: 2, title: "Formatting", docId: "doc-format", rev: 0,
    rows: Object.entries(rows).map(([id, audioText]) => ({ id, audioText, visualText: visuals[id] ?? "" })),
    comments: [], people: [], brollShots: [],
    productionTags: [{ id: LAMP, cat: "prop", name: "lamp" }, { id: ROPE, cat: "prop", name: "rope" }, { id: "t:prop:zebra", cat: "prop", name: "zebra" },
      { id: "t:prop:apple", cat: "prop", name: "apple" }, { id: "t:prop:ring", cat: "prop", name: "ring" }]
  });
}

function copies(document: ValidatedDocument, count = 2, seedClient = 1, clients: readonly number[] = []): { net: ScriptNet; all: NativeScript[] } {
  const seed = convertedScript(document, seedClient), all = Array.from({ length: count }, (_, index) => joinedScript(seed, clients[index] ?? index + 2));
  return { net: new ScriptNet(all), all };
}

function pair(document: ValidatedDocument, seedClient = 1, clients: readonly number[] = []): [ScriptNet, NativeScript, NativeScript] {
  const { net, all: [a, b] } = copies(document, 2, seedClient, clients);
  assert.ok(a && b);
  return [net, a, b];
}

function range(copy: NativeScript, target: NativeTextTarget, from: number, to: number): NativeTextRange {
  const anchored = anchorNativeText(copy, target, from, to);
  assert.equal(anchored.kind, "anchored");
  return (anchored as { range: NativeTextRange }).range;
}

function format(copy: NativeScript, target: NativeTextTarget, from: number, to: number, change: NativeMarkChange): NativeFormatOutcome["kind"] {
  return formatNativeText(copy, range(copy, target, from, to), change).kind;
}

function html(copy: NativeScript, beat: string, cell: "narration" | "visual" = "narration"): string {
  const row = copy.reader.row(beat);
  return (cell === "narration" ? row?.audioText : row?.visualText) ?? "missing";
}

function narrationRuns(copy: NativeScript, beat: string): readonly Run[] {
  return copy.reader.row(beat)?.narration ?? [];
}

function tagKeys(copy: NativeScript, beat: string, id: string): string[] {
  const items: readonly NativeDeltaItem[] = nativeSegmentSpans(copy.roots.segments.get("b:" + beat))?.[0]?.items ?? [];
  return [...new Set(items.flatMap(item => Object.keys(item.attributes ?? {}).filter(key => nativeMarkName(key) === "t:" + id)))].sort();
}

function unwritten(copy: NativeScript, act: () => void): void {
  const before = Y.encodeStateVector(copy.doc);
  act();
  assert.deepEqual(Y.encodeStateVector(copy.doc), before);
}

test("plain kinds turn on and off on a range, on two copies and a late joiner, in both cells", () => {
  const [net, a, b] = pair(source({ R1: "abcdef" }, { R1: "wide shot" }));
  assert.equal(format(a, NARRATION("R1"), 1, 3, BOLD), "written");
  assert.equal(format(b, NARRATION("R1"), 2, 5, { kind: "plain", mark: "i", on: true }), "written");
  assert.equal(format(b, VISUAL("R1"), 0, 4, { kind: "plain", mark: "hl", on: true }), "written");
  net.settle();
  assert.deepEqual(net.agree(), ["R1: a<strong>b<em>c</em></strong><em>de</em>f / <mark>wide</mark> shot"]);
  assert.equal(format(a, NARRATION("R1"), 0, 6, { kind: "plain", mark: "i", on: false }), "written");
  assert.equal(format(b, VISUAL("R1"), 1, 2, { kind: "plain", mark: "hl", on: false }), "written");
  net.settle("reverse");
  assert.deepEqual(net.agree(), ["R1: a<strong>bc</strong>def / <mark>w</mark>i<mark>de</mark> shot"]);
});

test("a change the range already shows is unchanged and writes nothing", () => {
  const [, a] = pair(source({ R1: "<strong>abc</strong>d" }));
  unwritten(a, () => {
    assert.equal(format(a, NARRATION("R1"), 0, 3, BOLD), "unchanged");
    assert.equal(format(a, NARRATION("R1"), 3, 4, { kind: "plain", mark: "b", on: false }), "unchanged");
    assert.equal(format(a, NARRATION("R1"), 0, 4, { kind: "comment", id: "c1", on: false }), "unchanged");
    assert.equal(format(a, NARRATION("R1"), 0, 4, { kind: "link", href: null }), "unchanged");
    assert.equal(format(a, NARRATION("R1"), 0, 4, tag(LAMP, false)), "unchanged");
    assert.equal(format(a, NARRATION("R1"), 2, 2, BOLD), "unchanged");
  });
  assert.equal(format(a, NARRATION("R1"), 0, 4, BOLD), "written");
  assert.equal(html(a, "R1"), "<strong>abcd</strong>");
});

test("a mark only text can carry is unchanged on a range holding only an atom; a mark atoms carry formats it", () => {
  const [net, a] = pair(source({ R1: "ab" }));
  const who: Run = { atom: "who", name: "Ann", text: "@Ann", marks: {} };
  assert.equal(replaceNativeText(a, range(a, NARRATION("R1"), 1, 1), [who]).kind, "written");
  unwritten(a, () => {
    for (const change of [tag(LAMP), { kind: "plain", mark: "dir", on: true }, { kind: "plain", mark: "cue", on: true }] as NativeMarkChange[]) {
      assert.equal(format(a, NARRATION("R1"), 1, 2, change), "unchanged", JSON.stringify(change));
    }
  });
  assert.equal(format(a, NARRATION("R1"), 1, 2, BOLD), "written");
  assert.equal(format(a, NARRATION("R1"), 1, 2, { kind: "comment", id: "c1", on: true }), "written");
  net.settle();
  const [row] = net.agree();
  assert.match(String(row), /^R1: a<span class="cmt-anchor" data-cmt="c1"><strong><span class="who-anchor" data-who="Ann"[^>]*>@Ann<\/span><\/strong><\/span>b \/ $/);
  assert.deepEqual(narrationRuns(a, "R1")[1]?.marks, { b: true, cmt: ["c1"] });
});

test("comment marks: two copies comment overlapping letters at once and both comments stay", () => {
  const [net, a, b] = pair(source({ R1: "abcdef" }));
  assert.equal(format(a, NARRATION("R1"), 0, 4, { kind: "comment", id: "c1", on: true }), "written");
  assert.equal(format(b, NARRATION("R1"), 2, 6, { kind: "comment", id: "c2", on: true }), "written");
  net.settle();
  net.agree();
  assert.deepEqual(narrationRuns(a, "R1").map(run => [run.atom ? "" : run.text, run.marks.cmt]), [["ab", ["c1"]], ["cd", ["c1", "c2"]], ["ef", ["c2"]]]);
  assert.equal(format(b, NARRATION("R1"), 0, 6, { kind: "comment", id: "c1", on: false }), "written");
  net.settle();
  net.agree();
  assert.deepEqual(narrationRuns(a, "R1").map(run => [run.atom ? "" : run.text, run.marks.cmt]), [["ab", undefined], ["cdef", ["c2"]]]);
});

test("links: setting one replaces the links the range shows, clearing removes them, and two at once read the same everywhere", () => {
  const [net, a, b] = pair(source({ R1: "abcdef" }));
  assert.equal(format(a, NARRATION("R1"), 0, 4, { kind: "link", href: "https://one.example/" }), "written");
  net.settle();
  assert.equal(format(b, NARRATION("R1"), 2, 6, { kind: "link", href: "https://two.example/" }), "written");
  net.settle();
  assert.deepEqual(narrationRuns(a, "R1").map(run => [run.atom ? "" : run.text, run.marks.href]), [["ab", "https://one.example/"], ["cdef", "https://two.example/"]]);
  assert.equal(format(a, NARRATION("R1"), 0, 1, { kind: "link", href: "https://one.example/" }), "unchanged");
  assert.equal(format(a, NARRATION("R1"), 1, 3, { kind: "link", href: "https://three.example/" }), "written");
  assert.equal(format(b, NARRATION("R1"), 2, 4, { kind: "link", href: "https://four.example/" }), "written");
  net.settle();
  net.agree();
  const links = narrationRuns(b, "R1").map(run => [run.atom ? "" : run.text, run.marks.href]);
  assert.deepEqual(links, [["a", "https://one.example/"], ["b", "https://three.example/"], ["c", "https://four.example/"], ["d", "https://four.example/"], ["ef", "https://two.example/"]].reduce<(string | undefined)[][]>((all, entry) => {
    const last = all.at(-1);
    if (last && last[1] === entry[1]) last[0] += entry[0] ?? ""; else all.push([...entry]);
    return all;
  }, []));
  assert.equal(format(a, NARRATION("R1"), 0, 6, { kind: "link", href: null }), "written");
  net.settle();
  assert.deepEqual(net.agree(), ["R1: abcdef / "]);
});

test("a tag writes a fresh application each time and an untag clears the applications seen on its range", () => {
  const [net, a, b] = pair(source({ R1: "abcdefgh" }));
  assert.equal(format(a, NARRATION("R1"), 2, 6, tag(LAMP)), "written");
  assert.equal(format(a, NARRATION("R1"), 2, 6, tag(LAMP)), "written");
  assert.equal(tagKeys(a, "R1", LAMP).length, 2);
  net.settle();
  assert.equal(format(b, NARRATION("R1"), 3, 5, tag(LAMP, false)), "written");
  net.settle();
  net.agree();
  assert.deepEqual(narrationRuns(a, "R1").map(run => [run.atom ? "" : run.text, run.marks.tag]), [["ab", undefined], ["c", LAMP], ["de", undefined], ["f", LAMP], ["gh", undefined]]);
  assert.equal(format(b, NARRATION("R1"), 0, 8, tag(LAMP, false)), "written");
  net.settle();
  assert.deepEqual(net.agree(), ["R1: abcdefgh / "]);
});

test("an untag leaves an application it had not seen, as E6's per-application keys do", () => {
  const [net, a, b] = pair(source({ R1: "abcdefgh" }));
  assert.equal(format(a, NARRATION("R1"), 2, 6, tag(LAMP)), "written");
  net.settle();
  assert.equal(format(a, NARRATION("R1"), 2, 6, tag(LAMP)), "written");
  assert.equal(format(b, NARRATION("R1"), 2, 6, tag(LAMP, false)), "written");
  net.settle();
  net.agree();
  assert.deepEqual(narrationRuns(b, "R1").map(run => [run.atom ? "" : run.text, run.marks.tag]), [["ab", undefined], ["cdef", LAMP], ["gh", undefined]]);
});

test("refusals: busy inside any open transaction or observer, closed, missing row, bad mark and bad range, each before writing", () => {
  const [net, a, b] = pair(source({ R1: "abc" }));
  const selection = range(a, NARRATION("R1"), 0, 2), outcomes: string[] = [];
  unwritten(a, () => {
    a.doc.transact(() => { outcomes.push(JSON.stringify(formatNativeText(a, selection, BOLD))); });
    assert.deepEqual(outcomes, [JSON.stringify({ kind: "refused", reason: "busy" })]);
    for (const change of [
      { kind: "plain", mark: "x", on: true }, { kind: "plain", mark: "b", on: 1 }, { kind: "tag", id: "", on: true }, { kind: "tag", id: "t:a\u001fb", on: true },
      { kind: "tag", id: "t:\ud800", on: true }, { kind: "comment", id: "c\udc00", on: true }, { kind: "comment", id: "", on: true },
      { kind: "link", href: "javascript:alert(1)" }, { kind: "link", href: "https://x/\ud800" }, { kind: "unknown" }, null
    ] as unknown as NativeMarkChange[]) assert.deepEqual(formatNativeText(a, selection, change), { kind: "refused", reason: "mark" }, JSON.stringify(change));
    for (const bad of [{ ...selection, from: null }, { ...selection, target: { beat: "R9", cell: "narration" } }, { ...selection, target: { beat: "R1", cell: "other" } }, null] as unknown as NativeTextRange[]) {
      assert.equal(formatNativeText(a, bad, BOLD).kind, "refused");
    }
    assert.deepEqual(formatNativeText(a, { ...selection, target: { beat: "R9", cell: "narration" } }, BOLD), { kind: "refused", reason: "missing" });
  });
  net.settle();
  assert.deepEqual(net.agree(), ["R1: abc / "]);
  assert.ok(b);
  closeNativeScript(a);
  unwritten(a, () => { assert.deepEqual(formatNativeText(a, selection, BOLD), { kind: "refused", reason: "closed" }); });
});

test("a formatting command called from an observer refuses as busy", () => {
  const [net, a, b] = pair(source({ R1: "abc" }));
  const selection = range(b, NARRATION("R1"), 0, 1), seen: string[] = [];
  b.roots.segments.observeDeep(() => { seen.push(JSON.stringify(formatNativeText(b, selection, BOLD))); });
  assert.equal(typeNativeText(a, range(a, NARRATION("R1"), 3, 3), "d", {}).kind, "written");
  net.deliver(a, b);
  assert.deepEqual(seen, [JSON.stringify({ kind: "refused", reason: "busy" })]);
  assert.equal(html(b, "R1"), "abcd");
});

test("the mark is read once, so a caller's getter cannot change what was checked", () => {
  const [, a] = pair(source({ R1: "abc" }));
  let reads = 0;
  const change = { kind: "tag", get id(): string { if (reads++) throw new Error("read twice"); return LAMP; }, on: true } as unknown as NativeMarkChange;
  assert.equal(formatNativeText(a, range(a, NARRATION("R1"), 0, 3), change).kind, "written");
  assert.equal(narrationRuns(a, "R1")[0]?.marks.tag, LAMP);
  let rangeReads = 0;
  const held = range(a, NARRATION("R1"), 0, 1);
  const tricky = { from: held.from, to: held.to, seen: held.seen, get target(): NativeTextTarget { return rangeReads++ ? NARRATION("R9") : NARRATION("R1"); } } as NativeTextRange;
  assert.equal(formatNativeText(a, tricky, BOLD).kind, "written");
  assert.equal(rangeReads, 1);
});

test("a stale range covers text a peer typed inside it, and a range whose both ends a peer deleted does nothing", () => {
  const [net, a, b] = pair(source({ R1: "abcdef" }));
  const selection = range(b, NARRATION("R1"), 2, 4), collapsed = range(b, NARRATION("R1"), 2, 4);
  assert.equal(typeNativeText(a, range(a, NARRATION("R1"), 3, 3), "X", {}).kind, "written");
  net.deliver(a, b);
  assert.equal(formatNativeText(b, selection, BOLD).kind, "written");
  assert.equal(html(b, "R1"), "ab<strong>cXd</strong>ef");
  assert.equal(replaceNativeText(a, range(a, NARRATION("R1"), 4, 5), []).kind, "written");
  assert.equal(replaceNativeText(a, range(a, NARRATION("R1"), 2, 3), []).kind, "written");
  net.settle();
  unwritten(b, () => { assert.equal(formatNativeText(b, collapsed, { kind: "plain", mark: "u", on: true }).kind, "unchanged"); });
  assert.deepEqual(net.agree(), ["R1: ab<strong>X</strong>ef / "]);
});

test("carried item 2: on a tag nested in itself, an untag clears the letters it covers, whichever application holds them", () => {
  const ring = ANCHOR("ring"), nested = ring + "x" + ring + "a</span>y</span>";
  for (const [from, to, expected] of [
    [1, 2, ring + "x</span>a" + ring + "y</span>"],
    [0, 1, "x" + ring + "ay</span>"],
    [0, 3, "xay"]
  ] as const) {
    const [net, a, b] = pair(source({ R1: nested }));
    assert.equal(tagKeys(a, "R1", "t:prop:ring").length, 3);
    assert.equal(format(b, NARRATION("R1"), from, to, tag("t:prop:ring", false)), "written");
    net.settle();
    net.agree();
    assert.deepEqual(narrationRuns(a, "R1"), cells(expected), `${from}-${to}`);
  }
  const [net, a, b] = pair(source({ R1: nested }));
  assert.equal(format(a, NARRATION("R1"), 0, 3, tag("t:prop:ring")), "written");
  assert.deepEqual(narrationRuns(a, "R1"), cells(ring + "xay</span>"));
  net.settle();
  assert.equal(format(b, NARRATION("R1"), 0, 3, tag("t:prop:ring", false)), "written");
  net.settle();
  assert.deepEqual(net.agree(), ["R1: xay / "]);
});

test("carried item 1: same-extent tags keep their imported order through loading and typing", () => {
  const zebra = ANCHOR("zebra"), apple = ANCHOR("apple");
  for (const nesting of [zebra + apple + "ab</span></span>", apple + zebra + "ab</span></span>"]) {
    const [net, a, b] = pair(source({ R1: nesting + "c" }));
    const imported = cells(nesting + "c"), outer = imported[0]?.marks;
    assert.deepEqual(narrationRuns(a, "R1"), imported);
    assert.equal(typeNativeText(a, range(a, NARRATION("R1"), 1, 1), "Q", outer ?? {}).kind, "written");
    net.settle();
    net.agree();
    assert.deepEqual(narrationRuns(b, "R1"), cells(nesting.replace("ab</span>", "aQb</span>") + "c"));
  }
});

test("carried item 1: one writer's tag on exactly its own tag's letters reads outside it, as the app's own setMark places it", () => {
  for (const [from, to] of [[0, 2], [0, 1], [0, 3]] as const) {
    const writer = convertedScript(source({ R1: ANCHOR("zebra") + "ab</span>c" }), 7), net = new ScriptNet([writer, joinedScript(writer, 8)]);
    const before = narrationRuns(writer, "R1");
    assert.equal(format(writer, NARRATION("R1"), from, to, tag("t:prop:apple")), "written");
    net.settle();
    net.agree();
    assert.deepEqual(narrationRuns(writer, "R1"), setMark(before, from, to, "tag", "t:prop:apple"), `${from}-${to}`);
  }
  const [net, a] = pair(source({ R1: "abc" }));
  for (const id of ["t:prop:zebra", "t:prop:apple"]) assert.equal(format(a, NARRATION("R1"), 0, 2, tag(id)), "written");
  net.settle();
  net.agree();
  assert.deepEqual(narrationRuns(a, "R1"), setMark(setMark(cells("abc"), 0, 2, "tag", "t:prop:zebra"), 0, 2, "tag", "t:prop:apple"));
});

test("carried item 1, as built: across writers, a tag reapplied on another tag's exact letters nests by client id", () => {
  const zebra = ANCHOR("zebra"), apple = ANCHOR("apple"), nesting = zebra + apple + "ab</span></span>";
  for (const [client, expected] of [[20, apple + zebra + "ab</span></span>"], [5, nesting]] as const) {
    const [net, writer, other] = pair(source({ R1: nesting }), 10, [client, 30]);
    assert.equal(format(writer, NARRATION("R1"), 0, 2, tag("t:prop:zebra", false)), "written");
    assert.equal(format(writer, NARRATION("R1"), 0, 2, tag("t:prop:zebra")), "written");
    net.settle();
    net.agree();
    assert.deepEqual(narrationRuns(other, "R1"), cells(expected), `writer client ${client}`);
  }
});

test("crossing display: of two crossing tags the second shows only on its letters outside the first, on every copy", () => {
  const [net, a, b] = pair(source({ R1: "abcdefgh" }));
  assert.equal(format(a, NARRATION("R1"), 2, 6, tag(LAMP)), "written");
  assert.equal(format(b, NARRATION("R1"), 4, 7, tag(ROPE)), "written");
  for (const order of ["forward", "reverse"] as const) net.settle(order);
  net.agree();
  const expected = (copy: NativeScript): void => {
    assert.deepEqual(narrationRuns(copy, "R1").map(run => [run.atom ? "" : run.text, run.marks.tag, run.marks.innerTags]),
      [["ab", undefined, undefined], ["cdef", LAMP, undefined], ["g", ROPE, undefined], ["h", undefined, undefined]]);
  };
  expected(a); expected(b);
  assert.equal(format(a, NARRATION("R1"), 2, 6, tag(LAMP, false)), "written");
  net.settle();
  net.agree();
  assert.deepEqual(narrationRuns(b, "R1").map(run => [run.atom ? "" : run.text, run.marks.tag]), [["abcd", undefined], ["efg", ROPE], ["h", undefined]]);
  const [, solo] = pair(source({ R1: "abcdefgh" }));
  assert.equal(format(solo, NARRATION("R1"), 2, 6, tag(LAMP)), "written");
  assert.equal(format(solo, NARRATION("R1"), 4, 7, tag(ROPE)), "written");
  expected(solo);
  assert.equal(format(solo, NARRATION("R1"), 3, 5, tag(ROPE)), "written");
  assert.deepEqual(narrationRuns(solo, "R1").map(run => [run.atom ? "" : run.text, run.marks.tag, run.marks.innerTags]),
    [["ab", undefined, undefined], ["c", LAMP, undefined], ["de", LAMP, [ROPE]], ["f", LAMP, undefined], ["g", ROPE, undefined], ["h", undefined, undefined]]);
});

test("typing inside a crossing region continues only the applications the reader shows, and does not uncover the hidden one", () => {
  const [net, a, b] = pair(source({ R1: "abcdefgh" }));
  assert.equal(format(a, NARRATION("R1"), 2, 6, tag(LAMP)), "written");
  assert.equal(format(b, NARRATION("R1"), 4, 7, tag(ROPE)), "written");
  net.settle();
  const marks = narrationRuns(a, "R1")[1]?.marks ?? {};
  assert.equal(typeNativeText(a, range(a, NARRATION("R1"), 5, 5), "Z", marks).kind, "written");
  net.settle();
  net.agree();
  assert.deepEqual(narrationRuns(b, "R1").map(run => [run.atom ? "" : run.text, run.marks.tag]), [["ab", undefined], ["cdeZf", LAMP], ["g", ROPE], ["h", undefined]]);
  assert.equal(tagKeys(a, "R1", LAMP).length, 1);
});

test("rows and runs with formatting are frozen", () => {
  const [, a] = pair(source({ R1: "abc" }));
  assert.equal(format(a, NARRATION("R1"), 0, 2, tag(LAMP)), "written");
  assert.equal(format(a, NARRATION("R1"), 1, 3, { kind: "comment", id: "c1", on: true }), "written");
  const row = a.reader.row("R1");
  assert.ok(row);
  for (const value of [row, row.narration, row.narration[0], row.narration[0]?.marks, row.narration[1]?.marks.cmt, row.visual]) assert.ok(Object.isFrozen(value));
});

function storedItems(copy: NativeScript, beat: string): readonly NativeDeltaItem[] {
  return nativeSegmentSpans(copy.roots.segments.get("b:" + beat))?.[0]?.items ?? [];
}

const stored = (copy: NativeScript, beat: string): string => printCell(readCell(storedItems(copy, beat)));

function positionWith(position: Y.RelativePosition, change: Readonly<Record<string, unknown>>): Y.RelativePosition {
  return { type: position.type, tname: position.tname, item: position.item, assoc: position.assoc, ...change } as Y.RelativePosition;
}

test("review round 1, fix 1: a malformed position or seen list is a range refusal before Yjs sees it, for formatting, typing and deleting", () => {
  const [net, a] = pair(source({ R1: "abcd" }));
  const good = range(a, NARRATION("R1"), 1, 3), caret = range(a, NARRATION("R1"), 2, 2);
  const start = good.from.item as Y.ID, end = good.to.item as Y.ID, bent = positionWith(caret.from, { item: { client: start.client, clock: start.clock + 0.5 } });
  const malformed: NativeTextRange[] = [
    { ...good, to: positionWith(good.to, { item: { client: end.client, clock: end.clock + 0.5 } }) },
    { ...good, from: positionWith(good.from, { item: { client: start.client, clock: start.clock + 0.5 } }) },
    { ...good, from: positionWith(good.from, { item: { client: -1, clock: start.clock } }) },
    { ...good, to: positionWith(good.to, { item: { client: end.client, clock: String(end.clock) } }) },
    { ...good, from: positionWith(good.from, { type: { client: 0.5, clock: 0 } }) },
    { ...good, to: positionWith(good.to, { assoc: -2 }) },
    { ...good, from: positionWith(good.from, { assoc: 1 }) },
    { ...good, seen: [[a.doc.clientID, 0.5]] },
    { ...good, seen: [[1, 1], [1, 2]] },
    { ...caret, from: bent, to: bent }
  ];
  unwritten(a, () => {
    for (const bad of malformed) {
      assert.deepEqual(formatNativeText(a, bad, BOLD), { kind: "refused", reason: "range" }, JSON.stringify(bad));
      assert.deepEqual(typeNativeText(a, bad, "X", {}), { kind: "recovery", reason: "range", runs: [{ text: "X", marks: {} }] }, JSON.stringify(bad));
      assert.deepEqual(deleteNativeText(a, bad), { kind: "recovery", reason: "range", runs: [] }, JSON.stringify(bad));
    }
  });
  let reads = 0;
  const once = (position: Y.RelativePosition): Y.RelativePosition => ({
    type: position.type, tname: position.tname, assoc: position.assoc, get item() { if (reads++) throw new Error("read twice"); return position.item; }
  }) as Y.RelativePosition;
  assert.equal(formatNativeText(a, { ...good, from: once(good.from) }, BOLD).kind, "written");
  assert.equal(reads, 1);
  reads = 0;
  const typing = range(a, NARRATION("R1"), 4, 4), held = once(typing.from);
  assert.equal(typeNativeText(a, { ...typing, from: held, to: held }, "X", {}).kind, "written");
  assert.equal(reads, 1);
  const type = good.from.type as Y.ID, shared = { get client(): number { if (reads++) throw new Error("read twice"); return type.client; }, clock: type.clock };
  reads = 0;
  assert.equal(formatNativeText(a, { ...good, from: positionWith(good.from, { type: shared }), to: positionWith(good.to, { type: shared }) }, { kind: "plain", mark: "u", on: true }).kind, "written");
  assert.equal(reads, 1);
  net.settle();
  assert.deepEqual(net.agree(), ["R1: a<strong><u>bc</u></strong>dX / "]);
});

test("closing round, item 2: a caret keeps no state vector, and typing at one behaves as before", () => {
  const [net, a, b] = pair(source({ R1: "abcd" }));
  const caret = range(b, NARRATION("R1"), 2, 2), selection = range(b, NARRATION("R1"), 1, 3);
  assert.equal("seen" in caret, false);
  assert.ok(selection.seen?.length);
  assert.equal(typeNativeText(a, range(a, NARRATION("R1"), 2, 2), "X", {}).kind, "written");
  net.settle();
  unwritten(b, () => {
    assert.equal(formatNativeText(b, caret, BOLD).kind, "unchanged");
    assert.equal(deleteNativeText(b, caret).kind, "unchanged");
  });
  assert.equal(typeNativeText(b, caret, "Y", {}).kind, "written");
  net.settle();
  assert.deepEqual(net.agree(), ["R1: abXYcd / "]);
});

test("closing round, item 1, as built: a stale selection that still holds a letter of its own covers what a peer typed into it", () => {
  const [net, a, b] = pair(source({ R1: "abcd" }));
  const selection = range(b, NARRATION("R1"), 0, 3), deleting = range(b, NARRATION("R1"), 0, 3);
  assert.equal(typeNativeText(a, range(a, NARRATION("R1"), 2, 2), "X", {}).kind, "written");
  assert.equal(deleteNativeText(a, range(a, NARRATION("R1"), 3, 4)).kind, "written");
  assert.equal(deleteNativeText(a, range(a, NARRATION("R1"), 0, 1)).kind, "written");
  net.settle();
  assert.equal(html(b, "R1"), "bXd");
  assert.equal(formatNativeText(b, selection, BOLD).kind, "written");
  net.settle();
  assert.deepEqual(net.agree(), ["R1: <strong>bX</strong>d / "]);
  assert.equal(deleteNativeText(b, deleting).kind, "written");
  net.settle();
  assert.deepEqual(net.agree(), ["R1: d / "]);
});

test("closing round, item 1, as built: a stored embed no reader shows is a unit the stale selection still holds", () => {
  const [net, a, b] = pair(source({ R1: "ac" }));
  const segment = a.roots.segments.get("b:R1"), text = segment?.get("text"), span = nativeSegmentSpans(segment)?.[0];
  assert.ok(text instanceof Y.Text && span);
  text.insertEmbed(span.start + 1, { kind: "unknown" });
  net.settle();
  assert.equal(html(b, "R1"), "ac");
  const selection = range(b, NARRATION("R1"), 0, 2), deleting = range(b, NARRATION("R1"), 0, 2);
  // why: the peer edits the text directly, since a delete command on c also removes the hidden unit before it
  text.insert(span.start + 2, "X");
  text.delete(span.start + 3, 1);
  text.delete(span.start, 1);
  net.settle();
  assert.equal(stored(b, "R1"), "￼X");
  assert.equal(formatNativeText(b, selection, BOLD).kind, "written");
  net.settle();
  assert.deepEqual(net.agree(), ["R1: <strong>X</strong> / ", "problem unknown-embed segments/b:R1#0"]);
  assert.equal(deleteNativeText(b, deleting).kind, "written");
  net.settle();
  assert.deepEqual(net.agree(), ["R1:  / "]);
  assert.equal(stored(b, "R1"), "");
});

test("review round 1, fix 2: a link over a video goes on the letters only, and a video a peer stored with a link stays shown with a problem", () => {
  const [net, a, b] = pair(source({ R1: "ab" }));
  const video: Run = { atom: "video", href: "https://example.com/clip", host: "example.com", text: "", marks: {} }, one = "https://one.example/";
  assert.equal(replaceNativeText(a, range(a, NARRATION("R1"), 1, 1), [video]).kind, "written");
  net.settle();
  assert.equal(format(b, NARRATION("R1"), 0, 3, { kind: "link", href: one }), "written");
  net.settle();
  assert.deepEqual(net.agree(), [`R1: ${html(a, "R1")} / `]);
  assert.equal(stored(a, "R1"), `[a|l:${one}]￼[b|l:${one}]`);
  assert.deepEqual(narrationRuns(b, "R1").map(run => [run.atom ?? run.text, run.marks.href]), [["a", one], ["video", undefined], ["b", one]]);
  assert.equal(anchorNativeText(b, NARRATION("R1"), 1, 2).kind, "anchored");
  const segment = a.roots.segments.get("b:R1"), text = segment?.get("text"), span = nativeSegmentSpans(segment)?.[0];
  assert.ok(text instanceof Y.Text && span);
  text.format(span.start + 1, 1, { [`l:${one}`]: true });
  net.settle();
  const rows = net.agree();
  assert.deepEqual(rows.slice(1), ["problem unshown-marks segments/b:R1#0"]);
  assert.deepEqual(narrationRuns(b, "R1").map(run => [run.atom ?? run.text, run.marks.href]), [["a", one], ["video", undefined], ["b", one]]);
  assert.equal(anchorNativeText(b, NARRATION("R1"), 1, 2).kind, "anchored");
});

test("review round 1, fix 3a: a tag or direction across a person mention is stored on the letters only", () => {
  const [net, a, b] = pair(source({ R1: "ab" }));
  const who: Run = { atom: "who", name: "Ann", text: "@Ann", marks: {} };
  assert.equal(replaceNativeText(a, range(a, NARRATION("R1"), 1, 1), [who]).kind, "written");
  net.settle();
  assert.equal(format(b, NARRATION("R1"), 0, 3, tag(LAMP)), "written");
  assert.equal(format(b, NARRATION("R1"), 0, 3, { kind: "plain", mark: "dir", on: true }), "written");
  net.settle();
  assert.equal(net.agree().length, 1);
  assert.equal(stored(a, "R1"), `[a|dir,t:${LAMP}]￼[b|dir,t:${LAMP}]`);
});

test("review round 1, fix 3b: two links set at once over crossing letters read the same everywhere and report the hidden one", () => {
  const [net, a, b] = pair(source({ R1: "abcd" }));
  const one = "https://one.example/", two = "https://two.example/";
  assert.equal(format(a, NARRATION("R1"), 0, 3, { kind: "link", href: one }), "written");
  assert.equal(format(b, NARRATION("R1"), 1, 4, { kind: "link", href: two }), "written");
  net.settle();
  assert.deepEqual(net.agree().slice(1), ["problem unshown-marks segments/b:R1#0"]);
  assert.deepEqual(narrationRuns(b, "R1").map(run => [run.atom ? "" : run.text, run.marks.href]), [["abc", one], ["d", two]]);
  assert.equal(stored(a, "R1"), `[a|l:${one}][bc|l:${one},l:${two}][d|l:${two}]`);
});

test("review round 1, fix 3c: a tag id without the form tag markup reads is refused before writing", () => {
  const [net, a] = pair(source({ R1: "abc" }));
  unwritten(a, () => {
    for (const id of ["c:x", "t:Prop:x", "t:prop:", "t:prop", "lamp", "x:prop:lamp"]) for (const on of [true, false]) {
      assert.deepEqual(formatNativeText(a, range(a, NARRATION("R1"), 0, 2), tag(id, on)), { kind: "refused", reason: "mark" }, id);
    }
  });
  net.settle();
  assert.deepEqual(net.agree(), ["R1: abc / "]);
});

test("review round 1, fix 4: a stale selection whose ends a peer deleted still covers the letters left alive inside it", () => {
  const [net, a, b] = pair(source({ R1: "abcd" }));
  const selection = range(b, NARRATION("R1"), 0, 3), deleting = range(b, NARRATION("R1"), 0, 3);
  assert.equal(deleteNativeText(a, range(a, NARRATION("R1"), 2, 3)).kind, "written");
  assert.equal(deleteNativeText(a, range(a, NARRATION("R1"), 0, 1)).kind, "written");
  net.settle();
  assert.equal(html(b, "R1"), "bd");
  assert.equal(formatNativeText(b, selection, BOLD).kind, "written");
  net.settle();
  assert.deepEqual(net.agree(), ["R1: <strong>b</strong>d / "]);
  assert.equal(deleteNativeText(b, deleting).kind, "written");
  net.settle();
  assert.deepEqual(net.agree(), ["R1: d / "]);
});

// why: core cell normalisation reads a link, comment or direction on part of a tag across the whole tag, in the app
// alone too; the letters still store exactly what was asked
test("review round 1, pin 6, as built: a link, comment or direction set or cleared on part of a tag is stored on those letters only", () => {
  const url = "https://one.example/", lamp = ANCHOR("lamp") + "abcd</span>e";
  const kinds: [NativeMarkChange, NativeMarkChange, MarkName, unknown, string][] = [
    [{ kind: "link", href: url }, { kind: "link", href: null }, "href", url, "l:" + url],
    [{ kind: "comment", id: "c1", on: true }, { kind: "comment", id: "c1", on: false }, "cmt", ["c1"], "c:c1"],
    [{ kind: "plain", mark: "dir", on: true }, { kind: "plain", mark: "dir", on: false }, "dir", true, "dir"]
  ];
  for (const [on, off, name, value, key] of kinds) {
    const [net, a, b] = pair(source({ R1: lamp }));
    const plain = narrationRuns(a, "R1");
    assert.equal(format(a, NARRATION("R1"), 1, 2, on), "written");
    net.settle();
    net.agree();
    assert.equal(stored(b, "R1"), `[a|t:${LAMP}][b|${key},t:${LAMP}][cd|t:${LAMP}]e`, name);
    const partial = setMark(plain, 1, 2, name, value);
    assert.deepEqual(narrationRuns(b, "R1"), partial, name);
    assert.equal(format(b, NARRATION("R1"), 0, 4, on), "written");
    net.settle();
    const whole = narrationRuns(a, "R1");
    assert.equal(format(a, NARRATION("R1"), 1, 2, off), "written");
    net.settle();
    net.agree();
    assert.equal(stored(b, "R1"), `[a|${key},t:${LAMP}][b|t:${LAMP}][cd|${key},t:${LAMP}]e`, name);
    assert.deepEqual(narrationRuns(b, "R1"), setMark(whole, 1, 2, name, null), name);
    assert.deepEqual([partial, narrationRuns(b, "R1")].map(runs => runs.map(run => [run.atom ? "" : run.text, run.marks[name]])), [[["abcd", value], ["e", undefined]], [["abcd", value], ["e", undefined]]], name);
  }
});

const ownersOf = (copy: NativeScript, owners: ReadonlyMap<number, string>): string => storedItems(copy, "R1").flatMap(item => typeof item.insert !== "string" ? [] : [...item.insert].map(ch => ch + Object.keys(item.attributes ?? {})
  .filter(key => nativeMarkName(key) === "t:" + LAMP).map(key => owners.get(parseInt(key.slice(key.indexOf("\u001f") + 1), 36)) ?? "?").sort().join(""))).join(" ");

// why: each untag clears both applications on its own letters and Y.Text.format restores what it saw after its end,
// so c and d get both back; bare Y.Text.format does the same in every client and delivery order
test("review round 1, pin 8, as built: two untags at once over crossing letters leave both applications after the first untag's end", () => {
  for (const clients of [[2, 3], [3, 2]]) for (const order of ["forward", "reverse"] as const) {
    const [net, a, b] = pair(source({ R1: "abcd" }), 1, clients), owners = new Map([[a.doc.clientID, "A"], [b.doc.clientID, "B"]]);
    assert.equal(format(a, NARRATION("R1"), 0, 3, tag(LAMP)), "written");
    assert.equal(format(b, NARRATION("R1"), 1, 4, tag(LAMP)), "written");
    net.settle();
    assert.equal(format(a, NARRATION("R1"), 0, 2, tag(LAMP, false)), "written");
    assert.equal(format(b, NARRATION("R1"), 1, 3, tag(LAMP, false)), "written");
    net.settle(order);
    net.agree();
    assert.equal(ownersOf(a, owners), "a b cAB dAB", `clients ${clients.join(",")}, ${order}: asked for a b c dB`);
    assert.deepEqual(narrationRuns(b, "R1").map(run => [run.atom ? "" : run.text, run.marks.tag]), [["ab", undefined], ["cd", LAMP]]);
  }
  for (const clients of [[1, 2], [2, 1]]) for (const reverse of [false, true]) {
    const docs = [...clients, 3].map(client => { const doc = new Y.Doc(); doc.clientID = client; doc.getText("t"); return doc; });
    const [a, b, late] = docs as [Y.Doc, Y.Doc, Y.Doc];
    const sync = (): void => { for (const from of docs) for (const to of docs) if (from !== to) Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), "remote"); };
    a.getText("t").insert(0, "abcd");
    sync();
    a.getText("t").format(0, 3, { A: true });
    b.getText("t").format(1, 3, { B: true });
    sync();
    const base = Y.encodeStateVector(late);
    a.getText("t").format(0, 2, { A: null, B: null });
    b.getText("t").format(1, 2, { A: null, B: null });
    const updates = [Y.encodeStateAsUpdate(a, base), Y.encodeStateAsUpdate(b, base)];
    for (const update of reverse ? updates.reverse() : updates) Y.applyUpdate(late, update, "remote");
    sync();
    for (const doc of docs) assert.equal(printCell(readCell(doc.getText("t").toDelta() as NativeDeltaItem[])), "ab[cd|A,B]", `raw Yjs, clients ${clients.join(",")}, reverse ${reverse}`);
    for (const doc of docs) doc.destroy();
  }
});
