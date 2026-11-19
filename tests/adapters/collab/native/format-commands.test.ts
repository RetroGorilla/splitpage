import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import type { ValidatedDocument } from "../../../../src/core/document/validated.ts";
import { setMark } from "../../../../src/core/text/edits.ts";
import type { Run } from "../../../../src/core/text/runs.ts";
import { formatNativeText } from "../../../../src/adapters/collab/native/format-commands.ts";
import type { NativeFormatOutcome, NativeMarkChange } from "../../../../src/adapters/collab/native/format-commands.ts";
import { nativeMarkName } from "../../../../src/adapters/collab/native/inline.ts";
import type { NativeDeltaItem } from "../../../../src/adapters/collab/native/inline.ts";
import { nativeSegmentSpans } from "../../../../src/adapters/collab/native/reader.ts";
import { closeNativeScript } from "../../../../src/adapters/collab/native/script.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { anchorNativeText, replaceNativeText, typeNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import type { NativeTextRange, NativeTextTarget } from "../../../../src/adapters/collab/native/text-commands.ts";
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
  const tricky = { from: held.from, to: held.to, get target(): NativeTextTarget { return rangeReads++ ? NARRATION("R9") : NARRATION("R1"); } } as NativeTextRange;
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
