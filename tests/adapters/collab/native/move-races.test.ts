import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { createNativeHeading, removeNativeHeading, renameNativeHeading } from "../../../../src/adapters/collab/native/heading-commands.ts";
import { moveNativeBlocks } from "../../../../src/adapters/collab/native/move-commands.ts";
import { nativeSegmentSpans } from "../../../../src/adapters/collab/native/reader.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { anchorNativeText, typeNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import { ScriptNet, convertedScript, joinedScript } from "./helpers.ts";
import type { Delivery } from "./helpers.ts";
import { blockOrder, caret, copiesOf, join, press, remove, rowsOf, split, stateOf, storedOf, structureScript, undoOf } from "./structure-harness.ts";

after(() => { dom.window.close(); });

const ROWS = { A: "ab", B: "cd", C: "ef", D: "gh", E: "ij", F: "kl", G: "mn", H: "op" };
const VISUALS = { A: "1", B: "2", C: "3", D: "4", E: "5", F: "6", G: "7", H: "8" };
const BASE = structureScript(ROWS, VISUALS, [{ id: "P", name: "x", before: "A" }, { id: "Q", name: "y", before: "E" }]);
const DELIVERIES: readonly Delivery[] = ["forward", "reverse", "twice"];
const CLIENTS = [[2, 3], [3, 2], [2, 3, 4], [4, 2, 3]];
const START = "#P A B C D #Q E F G H", MOVED = "#P A C D #Q E F B G H", END = "#P A C D #Q E F G H B";

function fixtureHead(): NativeScript {
  const seed = convertedScript(BASE);
  const { segments, order } = seed.roots, source = segments.get("h:P"), last = nativeSegmentSpans(source)?.at(-1), text = source?.get("text");
  assert.ok(text instanceof Y.Text && last?.key === "b:D");
  seed.doc.transact(() => {
    const separate = new Y.Map<unknown>(), narration = new Y.Text();
    text.delete(last.start - 1, last.end - last.start + 1);
    segments.set("b:D", separate);
    separate.set("head", { b: "D" });
    separate.set("text", narration);
    narration.insert(0, ROWS.D, {});
    order.insert(1, ["b:D"]);
  });
  return seed;
}

interface Collision {
  readonly a: NativeScript;
  readonly b: NativeScript;
  readonly ua: Y.UndoManager;
  readonly ub: Y.UndoManager;
  readonly sync: () => void;
  readonly named: Map<string, string>;
}

function cases(run: (world: Collision, copies: NativeScript[], net: ScriptNet) => void): void {
  for (const clients of CLIENTS) for (const delivery of DELIVERIES) {
    const seed = fixtureHead(), all = clients.map(id => joinedScript(seed, id));
    seed.doc.destroy();
    const [a, b] = all;
    assert.ok(a && b);
    const net = new ScriptNet(all);
    const ua = undoOf(a), ub = undoOf(b);
    try { run({ a, b, ua, ub, sync: () => net.settle(delivery), named: new Map() }, all, net); }
    finally { for (const script of all) script.doc.destroy(); }
  }
}

function move(script: NativeScript, ids: string[], before: string | null): void {
  assert.deepEqual(moveNativeBlocks(script, ids, before), { kind: "written" });
}

function typeIn(script: NativeScript, id: string, cell: "visual" | "narration", text: string): void {
  const anchor = anchorNativeText(script, { beat: id, cell }, 1);
  assert.equal(anchor.kind, "anchored");
  assert.ok(anchor.kind === "anchored");
  assert.equal(typeNativeText(script, anchor.range, text, {}).kind, "written");
}

function heading(script: NativeScript, before: string): void {
  assert.deepEqual(createNativeHeading(script, caret(script, before, 0), "R", "r"), { kind: "written" });
}

function cut(world: Collision, actor: NativeScript, beat: string, name = "X", offset = 1): string {
  const id = split(actor, beat, offset);
  world.named.set(id, name);
  return id;
}

function top(script: NativeScript): void { move(script, ["Q", "E", "F", "G", "H"], "P"); }
function drop(script: NativeScript): void { move(script, ["B"], "G"); }
function audio(script: NativeScript, id: string): string | undefined { return script.reader.row(id)?.audioText; }

interface History {
  readonly name: string;
  readonly play: (world: Collision) => void;
  readonly order: string | readonly string[];
  readonly deleted?: keyof typeof ROWS;
  readonly added?: string;
  readonly inspect?: (script: NativeScript, world: Collision) => void;
}

const histories: readonly History[] = [
  { name: "join moving", play: ({ a, b }) => { drop(a); join(b, "B", "A", ""); }, order: MOVED,
    inspect: script => assert.deepEqual(script.reader.row("B")?.members, ["B"]) },
  { name: "join next", play: ({ a, b }) => { move(a, ["E"], null); join(b, "F", "E", ""); }, order: "#P A B C D #Q F G H E",
    inspect: script => assert.deepEqual(script.reader.row("F")?.members, ["F"]) },
  { name: "split landing", play: world => { drop(world.a); cut(world, world.b, "F"); }, order: "#P A C D #Q E F X B G H" },
  { name: "heading at source", play: ({ a, b }) => { drop(a); heading(b, "B"); }, order: "#P A #R C D #Q E F B G H" },
  { name: "scene overlap", play: ({ a, b }) => { top(a); move(b, ["F"], "B"); }, order: ["#Q E F G H #P A B C D", "#Q E G H #P A F B C D"] },
  { name: "split moving", play: world => { drop(world.a); cut(world, world.b, "B"); }, order: "#P A X C D #Q E F B G H",
    inspect: (script, { named }) => { assert.equal(audio(script, "B"), "c"); assert.equal(audio(script, [...named.keys()][0] ?? ""), "d"); } },
  { name: "same beat", play: ({ a, b }) => { drop(a); move(b, ["B"], null); }, order: [MOVED, END],
    inspect: (script, { a, b }) => assert.equal(blockOrder(script).join(" "), a.doc.clientID > b.doc.clientID ? MOVED : END) },
  { name: "opposing moves", play: ({ a, b }) => { drop(a); move(b, ["F"], "C"); }, order: "#P A F C D #Q E B G H" },
  { name: "same run cut", play: ({ a, b }) => { drop(a); move(b, ["B", "C"], null); },
    order: ["#P A D #Q E F B G H C", "#P A D #Q E F G H B C"] },
  { name: "delete moving", play: ({ a, b }) => { drop(a); remove(b, "B"); }, order: "#P A C D #Q E F G H", deleted: "B" },
  { name: "delete landing", play: ({ a, b }) => { drop(a); remove(b, "F"); }, order: "#P A C D #Q E B G H", deleted: "F" },
  { name: "delete run start", play: ({ a, b }) => { move(a, ["B", "C"], "G"); remove(b, "B"); },
    order: "#P A D #Q E F C G H", deleted: "B" },
  { name: "heading at destination", play: ({ a, b }) => { drop(a); heading(b, "G"); }, order: "#P A C D #Q E F #R B G H" },
  { name: "rename moved heading", play: ({ a, b }) => {
    top(a);
    const range = anchorNativeText(b, { beat: "Q", cell: "name" }, 1);
    assert.ok(range.kind === "anchored");
    assert.equal(renameNativeHeading(b, range.range, "w").kind, "written");
  }, order: "#Q E F G H #P A B C D", inspect: script => assert.deepEqual(script.reader.outline()[0], { kind: "heading", id: "Q", name: "yw" }) },
  { name: "remove moved heading", play: ({ a, b }) => { top(a); assert.equal(removeNativeHeading(b, "Q").kind, "written"); },
    order: "E F G H #P A B C D", inspect: script => assert.deepEqual(script.reader.recovery(), [{ id: "Q", name: "y" }]) },
  { name: "undo remote move", play: ({ a, b, ua, sync }) => {
    drop(a); sync(); move(b, ["B"], null); sync();
    ua.undo(); assert.equal(blockOrder(a).join(" "), END);
    ua.redo(); assert.equal(blockOrder(a).join(" "), END);
  }, order: END },
  { name: "undo remote edit", play: ({ a, b, ua, sync }) => {
    drop(a); typeIn(b, "B", "narration", "q"); sync(); press(ua, a);
    assert.equal(blockOrder(a).join(" "), START); assert.equal(audio(a, "B"), "cqd");
    press(ua, a, true);
  }, order: MOVED, added: "q", inspect: script => assert.equal(audio(script, "B"), "cqd") },
  { name: "undo ranked split", play: world => {
    const { a, b, ua, sync } = world, x = cut(world, a, "B");
    sync(); move(b, [x], "G"); press(ua, a);
  }, order: START, inspect: script => assert.equal(audio(script, "B"), "cd") },
  { name: "late joiner", play: ({ a, b }) => { drop(a); typeIn(b, "B", "visual", "W"); }, order: MOVED,
    inspect: script => assert.equal(script.reader.row("B")?.visualText, "2W") },
  { name: "delete while editing", play: ({ a, b, ua, sync }) => {
    remove(a, "B"); typeIn(b, "B", "visual", "W"); sync();
    press(ua, a); assert.equal(a.reader.row("B")?.visualText, "2W"); press(ua, a, true);
  },
    order: "#P A C D #Q E F G H", deleted: "B",
    inspect: script => { assert.equal(script.roots.visuals.get("B")?.toString(), "2W"); assert.equal(script.reader.row("B"), null); } },
  { name: "undo real deletion", play: ({ a, b, ub, sync }) => {
    drop(a); sync(); remove(b, "B"); press(ub, b); assert.equal(blockOrder(b).join(" "), MOVED); press(ub, b, true);
  }, order: "#P A C D #Q E F G H", deleted: "B" },
  { name: "two splits", play: world => { cut(world, world.a, "B", "X", 0); cut(world, world.b, "B", "Y"); },
    order: "#P A B X Y C D #Q E F G H", inspect: (script, { named }) => {
      assert.equal(audio(script, "B"), "");
      assert.deepEqual([...named.keys()].map(id => audio(script, id)), ["c", "d"]);
    } },
  { name: "move after seen split", play: world => { cut(world, world.b, "B"); world.sync(); drop(world.a); }, order: "#P A X C D #Q E F B G H" },
  { name: "split housekeeping vs move", play: world => {
    drop(world.b); world.sync(); cut(world, world.b, "F"); move(world.a, ["B"], null);
  }, order: "#P A C D #Q E F X G H B" },
  { name: "heading above segment head", play: ({ a, b }) => { move(a, ["D"], "G"); heading(b, "D"); }, order: "#P A B C #R #Q E F D G H" },
  { name: "delete segment head", play: ({ a, b }) => { move(a, ["D"], "G"); remove(b, "D"); }, order: "#P A B C #Q E F G H", deleted: "D" },
  { name: "delete head while typing", play: ({ a, b }) => { move(a, ["D"], "G"); remove(b, "D"); typeIn(a, "D", "narration", "q"); },
    order: "#P A B C #Q E F G H", deleted: "D", added: "q", inspect: script => assert.equal(audio(script, "C"), "efq") },
  { name: "drop between tied halves", play: world => {
    const x = cut(world, world.b, "B"); world.sync(); move(world.a, ["D"], x);
  }, order: "#P A B D X C #Q E F G H" },
  { name: "drop onto heading", play: ({ a }) => move(a, ["B"], "E"), order: "#P A C D #Q B E F G H",
    inspect: script => assert.deepEqual(script.reader.document().sections, [
      { id: "P", name: "x", firstSceneId: "A" }, { id: "Q", name: "y", firstSceneId: "B" }
    ]) }
];

for (const history of histories) test(`E10: ${history.name}`, t => {
  const measured = new Map<string, number>();
  cases((world, copies, net) => {
    history.play(world);
    world.sync();
    net.agree();
    const source = Object.entries(ROWS).filter(([id]) => id !== history.deleted).map(([, value]) => value).join("") + (history.added ?? "");
    const sorted = (value: string): string => [...value].sort().join("");
    for (const script of copies) {
      const order = blockOrder(script).map(id => world.named.get(id) ?? id).join(" ");
      const expected = typeof history.order === "string" ? [history.order] : history.order;
      assert.ok(expected.includes(order), order);
      assert.equal(sorted(script.reader.rows().map(row => row.audioText).join("")), sorted(source));
      assert.equal(sorted([...script.roots.segments.values()].map(segment => {
        const text = segment.get("text");
        return text instanceof Y.Text ? text.toString() : "";
      }).join("")), sorted(source));
      for (const [id, value] of Object.entries(VISUALS)) {
        assert.ok(script.roots.beats.has(id), id);
        assert.equal(script.roots.visuals.get(id)?.toString(), value + (id === "B" && ["late joiner", "delete while editing"].includes(history.name) ? "W" : ""));
      }
      history.inspect?.(script, world);
      if (script === world.a) measured.set(order, (measured.get(order) ?? 0) + 1);
    }
  });
  t.diagnostic(JSON.stringify(Object.fromEntries(measured)));
});

test("a move still lands in its chosen gap when the neighbour on its right is removed", () => {
  cases(({ a, b, sync }, _, net) => {
    drop(a); remove(b, "G"); sync(); net.agree();
    assert.equal(blockOrder(a).join(" "), "#P A C D #Q E F B H");
  });
});

test("two different moves into the same gap order by writer, even against stored order", () => {
  cases(({ a, b, sync }, _, net) => {
    move(a, ["C"], "G"); drop(b); sync(); net.agree();
    assert.equal(blockOrder(a).join(" "), `#P A D #Q E F ${a.doc.clientID < b.doc.clientID ? "C B" : "B C"} G H`);
  });
});

test("E15 option A: winner's undo leaves B rankless and rule (e) follows the moved narration neighbour", () => {
  cases(({ a, b, ua, ub, sync }, copies, net) => {
    move(a, ["A"], "H");
    sync();
    drop(a); move(b, ["B"], null); sync();
    const aWins = a.doc.clientID > b.doc.clientID, winner = aWins ? a : b;
    assert.equal(blockOrder(a).join(" "), aWins ? "#P C D #Q E F B G A H" : "#P C D #Q E F G A H B");
    press(aWins ? ua : ub, winner);
    sync(); net.agree();
    for (const copy of copies) {
      assert.equal(copy.roots.beats.get("B")?.has("rank"), false);
      assert.equal(blockOrder(copy).join(" "), "#P C D #Q E F G A B H");
    }
  });
});

test("a split restored without its record or visual cell cannot be moved or used as a drop target", () => {
  cases(({ a, b, ua, ub, sync }, copies, net) => {
    const x = split(a, "B", 0); sync();
    remove(b, x); sync();
    press(ua, a); sync(); press(ub, b); sync();
    for (const script of copies) {
      assert.equal(script.roots.beats.has(x), false);
      assert.match(storedOf(script), new RegExp(`\\[${x}\\]cd`));
      const before = stateOf(script);
      for (const [ids, dropId] of [[["A", x], null], [["A"], x]] as const) {
        assert.deepEqual(moveNativeBlocks(script, ids, dropId), { kind: "refused", reason: "missing" });
        assert.deepEqual(stateOf(script), before);
      }
    }
    net.agree();
  });
});

test("cross-segment second boundary: moves and racing removal undos keep the duplicate in its original segment", () => {
  const source = structureScript({ A: "ab", B: "", C: "cd", D: "ef" }, {}, [{ id: "P", name: "Scene", before: "C" }]);
  const { all: [a, b], undo: [ua, ub], net } = copiesOf(source);
  assert.ok(a && b && ua && ub);
  move(a, ["B"], "D"); net.settle();
  remove(a, "B"); remove(b, "B"); net.settle();
  press(ua, a); press(ub, b); net.settle();
  assert.equal(storedOf(a), "[A]ab[B][B] | [#P][C]cd[D]ef");
  assert.deepEqual(a.reader.narrationSpans("B"), [{ segment: "b:A", span: 1 }]);
  move(b, ["B"], "A"); net.settle();
  assert.equal(storedOf(b), "[A]ab[B][B] | [#P][C]cd[D]ef");
  remove(b, "B"); net.settle(); net.agree();
  assert.equal(storedOf(a), "[A]ab | [#P][C]cd[D]ef");
  assert.deepEqual(rowsOf(a), ["A: ab", "C: cd", "D: ef"]);
  const foreign = a.roots.segments.get("h:P")?.get("text"), original = a.roots.segments.get("b:A")?.get("text");
  assert.ok(foreign instanceof Y.Text && original instanceof Y.Text);
  a.doc.transact(() => {
    original.insertEmbed(original.length, { b: "B" }, {});
    foreign.insertEmbed(foreign.length - 2, { b: "B" }, {});
  });
  assert.deepEqual(a.reader.narrationSpans("B"), [{ segment: "b:A", span: 1 }]);
  remove(a, "B");
  assert.equal(storedOf(a), "[A]ab | [#P][C]cd[D][B]ef");
  assert.equal(audio(a, "B"), "ef");
  assert.equal(audio(a, "D"), "");
  a.doc.destroy(); b.doc.destroy();
});
