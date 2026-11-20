import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { nativeInitialRank } from "../../../../src/adapters/collab/native/convert.ts";
import { formatNativeText } from "../../../../src/adapters/collab/native/format-commands.ts";
import { createNativeHeading, removeNativeHeading, renameNativeHeading } from "../../../../src/adapters/collab/native/heading-commands.ts";
import { moveNativeBlocks } from "../../../../src/adapters/collab/native/move-commands.ts";
import type { NativeMoveBlock } from "../../../../src/adapters/collab/native/move-commands.ts";
import { openNativeScript } from "../../../../src/adapters/collab/native/script.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { anchorNativeText, typeNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import { ScriptNet, joinedScript } from "./helpers.ts";
import type { Delivery } from "./helpers.ts";
import { caret, join, press, remove, split, undoOf } from "./structure-harness.ts";

after(() => { dom.window.close(); });

const DELIVERIES: readonly Delivery[] = ["forward", "reverse", "twice"];
const TWO_CLIENTS: readonly (readonly number[])[] = [[2, 3], [3, 2]];
const THREE_CLIENTS: readonly (readonly number[])[] = [[2, 3, 4], [4, 3, 2]];
const beat = (id: string): NativeMoveBlock => ({ kind: "beat", id });
const heading = (id: string): NativeMoveBlock => ({ kind: "heading", id });

interface E10World {
  readonly net: ScriptNet;
  readonly a: NativeScript;
  readonly b: NativeScript;
  readonly undoA: Y.UndoManager;
  readonly undoB: Y.UndoManager;
  readonly order: Delivery;
  readonly aWins: boolean;
}

// why: E10 places D at the head of its own segment between scenes P (A-C) and Q (E-H) so segment-head races hit D
function seedE10(): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = 1;
  const script = openNativeScript(doc);
  const blocks: readonly (readonly ["h" | "b", string, string, string])[] = [
    ["h", "P", "x", ""], ["b", "A", "ab", "A"], ["b", "B", "cd", "B"], ["b", "C", "ef", "C"], ["b", "D", "gh", "D"],
    ["h", "Q", "y", ""], ["b", "E", "ij", "E"], ["b", "F", "kl", "F"], ["b", "G", "mn", "G"], ["b", "H", "op", "H"]
  ];
  doc.transact(() => {
    script.roots.meta.set("format", 1);
    script.roots.meta.set("docId", JSON.stringify("e10"));
    script.roots.meta.set("schema", JSON.stringify(2));
    const title = new Y.Text();
    script.roots.meta.set("title", title);
    title.insert(0, "E10", {});
    let text: Y.Text | null = null;
    blocks.forEach(([kind, id, body, vis], index) => {
      const rank = nativeInitialRank(index);
      if (kind === "h" || id === "D") {
        const key = kind + ":" + id, seg = new Y.Map<unknown>();
        text = new Y.Text();
        script.roots.segments.set(key, seg);
        seg.set("head", { [kind]: id });
        seg.set("text", text);
        script.roots.order.push([key]);
      } else if (text) text.insertEmbed(text.length, { b: id }, {});
      if (kind === "h") {
        const rec = new Y.Map<unknown>(), name = new Y.Text();
        script.roots.headings.set(id, rec);
        rec.set("rank", rank);
        script.roots.names.set(id, name);
        name.insert(0, body, {});
      } else {
        const rec = new Y.Map<unknown>(), visual = new Y.Text();
        script.roots.beats.set(id, rec);
        rec.set("rank", rank);
        if (id === "C") rec.set("paragraphStart", JSON.stringify(true));
        rec.set("extra", JSON.stringify({}));
        script.roots.visuals.set(id, visual);
        visual.insert(0, vis, {});
        text?.insert(text.length, body, {});
      }
    });
  }, "conversion");
  const bytes = Y.encodeStateAsUpdate(doc);
  script.close();
  return bytes;
}

const E10_BYTES = seedE10();

function openCopies(clients: readonly number[]): { net: ScriptNet; all: NativeScript[]; undo: Y.UndoManager[] } {
  const seed = openNativeScript(new Y.Doc());
  Y.applyUpdate(seed.doc, E10_BYTES, "remote");
  const all = clients.map(client => joinedScript(seed, client));
  seed.close();
  return { net: new ScriptNet(all), all, undo: all.map(undoOf) };
}

function snapshotWithoutRanks(script: NativeScript): string {
  const mapEntries = (map: Y.Map<Y.Map<unknown>>) => [...map.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, rec]) => [
    id, [...rec.entries()].filter(([key]) => key !== "rank").sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  ]);
  const textEntries = (map: Y.Map<Y.Text>): [string, unknown][] => [...map.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, text]) => [id, text.toDelta() as unknown]);
  const segments: [string, unknown, unknown][] = [...script.roots.segments.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, seg]) => [
    id, seg.get("head") ?? null, seg.get("text") instanceof Y.Text ? (seg.get("text") as Y.Text).toDelta() as unknown : null
  ]);
  return JSON.stringify({
    order: script.roots.order.toArray(),
    segments,
    beats: mapEntries(script.roots.beats),
    headings: mapEntries(script.roots.headings),
    visuals: textEntries(script.roots.visuals),
    names: textEntries(script.roots.names),
    edited: [...script.roots.edited.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  });
}

function blockTag(block: { readonly kind: "beat" | "heading"; readonly id: string }): string {
  return block.kind + ":" + block.id;
}

function move(script: NativeScript, blocks: readonly NativeMoveBlock[], drop: NativeMoveBlock | null): void {
  const beforeSnap = snapshotWithoutRanks(script), beforeOrder = script.reader.rankedOrder();
  const movedKeys = blocks.flatMap(ref => {
    if (ref.kind === "heading") return [blockTag(ref)];
    return beforeOrder.filter(entry => entry.kind === "beat" && entry.head === ref.id).map(blockTag);
  });
  const movedSet = new Set(movedKeys);
  const remaining = beforeOrder.map(blockTag).filter(key => !movedSet.has(key));
  const insertAt = drop === null ? remaining.length : remaining.indexOf(blockTag(drop));
  const expected = [...remaining.slice(0, insertAt), ...movedKeys, ...remaining.slice(insertAt)];
  assert.deepEqual(moveNativeBlocks(script, blocks, drop), { kind: "written" });
  script.reader.refresh();
  assert.equal(snapshotWithoutRanks(script), beforeSnap, "move wrote something other than ranks");
  assert.deepEqual(script.reader.rankedOrder().map(blockTag), expected, "moved blocks did not land as a run directly before drop");
}

function typeIn(script: NativeScript, id: string, cell: "narration" | "visual", at: number, text: string): void {
  const anchored = anchorNativeText(script, { beat: id, cell }, at);
  assert.equal(anchored.kind, "anchored");
  assert.equal(typeNativeText(script, (anchored as { range: Parameters<typeof typeNativeText>[1] }).range, text, {}).kind, "written");
  script.reader.refresh();
}

function createHeading(script: NativeScript, above: string, id: string, name: string): void {
  assert.deepEqual(createNativeHeading(script, caret(script, above, 0), id, name), { kind: "written" });
  script.reader.refresh();
}

function renameHeading(script: NativeScript, id: string, at: number, text: string): void {
  const anchored = anchorNativeText(script, { beat: id, cell: "name" }, at);
  assert.equal(anchored.kind, "anchored");
  assert.deepEqual(renameNativeHeading(script, (anchored as { range: Parameters<typeof renameNativeHeading>[1] }).range, text), { kind: "written" });
  script.reader.refresh();
}

function orderString(script: NativeScript, mapIds: ReadonlyMap<string, string> = new Map()): string {
  const name = (id: string): string => mapIds.get(id) ?? id;
  return script.reader.outline().flatMap(entry => {
    if (entry.kind === "heading") return ["#" + name(entry.id)];
    const members = script.reader.row(entry.id)?.members ?? [entry.id];
    return members.map(name);
  }).join(" ");
}

function thirdWriterWork(copy: NativeScript): void {
  typeIn(copy, "H", "visual", 0, "Z");
  renameHeading(copy, "P", 1, "z");
  const anchored = anchorNativeText(copy, { beat: "A", cell: "narration" }, 0, 1);
  assert.equal(anchored.kind, "anchored");
  if (anchored.kind === "anchored") {
    assert.equal(formatNativeText(copy, anchored.range, { kind: "tag", id: "t:prop:lamp", on: true }).kind, "written");
  }
  createHeading(copy, "E", "T", "temp");
  assert.deepEqual(removeNativeHeading(copy, "T"), { kind: "written" });
  copy.reader.refresh();
}

interface E10Case {
  readonly name: string;
  readonly run: (world: E10World, ids: Map<string, string>) => void;
  readonly check: (script: NativeScript, world: E10World, ids: ReadonlyMap<string, string>) => void;
}

const WHOLE = "#P A C D #Q E F B G H";
const START = "#P A B C D #Q E F G H";
const SCENE_Q: readonly NativeMoveBlock[] = [heading("Q"), beat("E"), beat("F"), beat("G"), beat("H")];

const CASES: readonly E10Case[] = [
  {
    name: "join moving",
    run: ({ a, b }) => { move(a, [beat("B")], beat("G")); join(b, "B", "A", " "); },
    // why: unlike E10's boolean join, rule (d) checks joined.into === row above; B moved below F, so B stays its own row
    check: script => {
      assert.equal(orderString(script), WHOLE);
      assert.deepEqual(script.reader.row("F")?.members, ["F"]);
      assert.deepEqual(script.reader.row("B")?.members, ["B"]);
      assert.ok(script.reader.problems().some(p => p.kind === "join-not-read" && p.where === "beats/B"));
    }
  },
  {
    name: "join next",
    run: ({ a, b }) => { move(a, [beat("E")], null); join(b, "F", "E", " "); },
    check: script => {
      assert.equal(orderString(script), "#P A B C D #Q F G H E");
      assert.deepEqual(script.reader.row("F")?.members, ["F"]);
    }
  },
  {
    name: "split landing",
    run: ({ a, b }, ids) => { move(a, [beat("B")], beat("G")); ids.set(split(b, "F", 1), "X"); },
    check: (script, _, ids) => { assert.equal(orderString(script, ids), "#P A C D #Q E F X B G H"); }
  },
  {
    name: "heading at source",
    run: ({ a, b }) => { move(a, [beat("B")], beat("G")); createHeading(b, "B", "R", "z"); },
    check: script => { assert.equal(orderString(script), "#P A #R C D #Q E F B G H"); }
  },
  {
    name: "scene overlap",
    run: ({ a, b }) => { move(a, SCENE_Q, heading("P")); move(b, [beat("F")], beat("B")); },
    check: (script, { aWins }) => {
      assert.equal(orderString(script), aWins ? "#Q E F G H #P A B C D" : "#Q E G H #P A F B C D");
    }
  },
  {
    name: "split moving",
    run: ({ a, b }, ids) => { move(a, [beat("B")], beat("G")); ids.set(split(b, "B", 1), "X"); },
    check: (script, _, ids) => {
      assert.equal(orderString(script, ids), "#P A X C D #Q E F B G H");
      assert.equal(script.reader.row("B")?.audioText, "c");
      const xId = [...ids.keys()][0];
      assert.ok(xId);
      assert.equal(script.reader.row(xId)?.audioText, "d");
    }
  },
  {
    name: "same beat",
    run: ({ a, b }) => { move(a, [beat("B")], beat("G")); move(b, [beat("B")], null); },
    check: (script, { aWins }) => {
      assert.equal(orderString(script), aWins ? WHOLE : "#P A C D #Q E F G H B");
    }
  },
  {
    name: "opposing moves",
    run: ({ a, b }) => { move(a, [beat("B")], beat("G")); move(b, [beat("F")], beat("C")); },
    check: script => { assert.equal(orderString(script), "#P A F C D #Q E B G H"); }
  },
  {
    name: "same run cut",
    run: ({ a, b }) => { move(a, [beat("B")], beat("G")); move(b, [beat("B"), beat("C")], null); },
    check: (script, { aWins }) => {
      assert.equal(orderString(script), aWins ? "#P A D #Q E F B G H C" : "#P A D #Q E F G H B C");
    }
  },
  {
    name: "delete moving",
    run: ({ a, b }) => { move(a, [beat("B")], beat("G")); remove(b, "B"); },
    check: script => { assert.equal(orderString(script), "#P A C D #Q E F G H"); }
  },
  {
    name: "delete landing",
    run: ({ a, b }) => { move(a, [beat("B")], beat("G")); remove(b, "F"); },
    check: script => { assert.equal(orderString(script), "#P A C D #Q E B G H"); }
  },
  {
    name: "delete run start",
    run: ({ a, b }) => { move(a, [beat("B"), beat("C")], beat("G")); remove(b, "B"); },
    check: script => { assert.equal(orderString(script), "#P A D #Q E F C G H"); }
  },
  {
    name: "heading at destination",
    run: ({ a, b }) => { move(a, [beat("B")], beat("G")); createHeading(b, "G", "R", "z"); },
    check: script => { assert.equal(orderString(script), "#P A C D #Q E F B #R G H"); }
  },
  {
    name: "rename moved heading",
    run: ({ a, b }) => { move(a, SCENE_Q, heading("P")); renameHeading(b, "Q", 1, "w"); },
    check: script => {
      assert.equal(orderString(script), "#Q E F G H #P A B C D");
      const h = script.reader.outline().find(e => e.kind === "heading" && e.id === "Q");
      assert.equal(h?.kind === "heading" ? h.name : null, "yw");
    }
  },
  {
    name: "remove moved heading",
    run: ({ a, b }) => { move(a, SCENE_Q, heading("P")); assert.deepEqual(removeNativeHeading(b, "Q"), { kind: "written" }); },
    check: script => {
      assert.equal(orderString(script), "E F G H #P A B C D");
      assert.ok(script.reader.recovery().some(h => h.id === "Q" && h.name === "y"));
    }
  },
  {
    name: "undo remote move",
    run: ({ net, a, b, undoA, order }) => {
      move(a, [beat("B")], beat("G"));
      net.deliver(a, b, order);
      move(b, [beat("B")], null);
      net.deliver(b, a, order);
      undoA.undo(); a.reader.refresh();
      assert.equal(orderString(a), "#P A C D #Q E F G H B");
      undoA.redo(); a.reader.refresh();
    },
    check: script => { assert.equal(orderString(script), "#P A C D #Q E F G H B"); }
  },
  {
    name: "undo remote edit",
    run: ({ net, a, b, undoA, order }) => {
      move(a, [beat("B")], beat("G"));
      typeIn(b, "B", "narration", 1, "q");
      net.deliver(b, a, order);
      press(undoA, a);
      assert.equal(orderString(a), START);
      assert.equal(a.reader.row("B")?.audioText, "cqd");
      press(undoA, a, true);
    },
    check: script => {
      assert.equal(orderString(script), WHOLE);
      assert.equal(script.reader.row("B")?.audioText, "cqd");
    }
  },
  {
    name: "undo ranked split",
    run: ({ net, a, b, undoA, order }) => {
      const created = split(a, "B", 1);
      net.deliver(a, b, order);
      move(b, [beat(created)], beat("G"));
      press(undoA, a);
    },
    check: script => {
      assert.equal(orderString(script), START);
      assert.equal(script.reader.row("B")?.audioText, "cd");
    }
  },
  {
    name: "late joiner",
    run: ({ a, b }) => { move(a, [beat("B")], beat("G")); typeIn(b, "B", "visual", 1, "W"); },
    check: script => {
      assert.equal(orderString(script), WHOLE);
      assert.equal(script.reader.row("B")?.visualText, "BW");
    }
  },
  {
    name: "delete while editing",
    run: ({ a, b }) => {
      remove(a, "B");
      typeIn(b, "B", "visual", 1, "W");
      b.doc.transact(() => { b.roots.beats.get("B")?.set("status", JSON.stringify("ready")); }, b.origin);
    },
    // why: decision 4 keeps records and visual cells on removal, fixing E10's broken loss of unseen visual/field edits
    check: script => {
      assert.equal(orderString(script), "#P A C D #Q E F G H");
      assert.equal(script.roots.visuals.get("B")?.toString(), "BW");
      assert.equal(script.roots.beats.get("B")?.get("status"), JSON.stringify("ready"));
    }
  },
  {
    name: "undo real deletion",
    run: ({ net, a, b, undoB, order }) => {
      move(a, [beat("B")], beat("G"));
      net.deliver(a, b, order);
      remove(b, "B");
      press(undoB, b);
      assert.equal(orderString(b), WHOLE);
      assert.equal(b.reader.row("B")?.visualText, "B");
      press(undoB, b, true);
    },
    check: script => { assert.equal(orderString(script), "#P A C D #Q E F G H"); }
  },
  {
    name: "two splits",
    run: ({ a, b }, ids) => {
      ids.set(split(a, "B", 0), "X");
      ids.set(split(b, "B", 1), "Y");
    },
    check: (script, _, ids) => {
      assert.equal(orderString(script, ids), "#P A B X Y C D #Q E F G H");
      const [xId, yId] = [...ids.keys()];
      assert.ok(xId && yId);
      assert.deepEqual([script.reader.row("B")?.audioText, script.reader.row(xId)?.audioText, script.reader.row(yId)?.audioText], ["", "c", "d"]);
    }
  },
  {
    name: "move after seen split",
    run: ({ net, a, b, order }, ids) => {
      const created = split(b, "B", 1);
      net.deliver(b, a, order);
      move(a, [beat("B")], beat("G"));
      ids.set(created, "X");
    },
    check: (script, _, ids) => { assert.equal(orderString(script, ids), "#P A X C D #Q E F B G H"); }
  },
  {
    name: "split housekeeping vs move",
    run: ({ net, a, b, order }, ids) => {
      move(b, [beat("B")], beat("G"));
      net.deliver(b, a, order);
      const created = split(b, "F", 1);
      move(a, [beat("B")], null);
      ids.set(created, "X");
    },
    check: (script, _, ids) => { assert.equal(orderString(script, ids), "#P A C D #Q E F X G H B"); }
  },
  {
    name: "heading above segment head",
    run: ({ a, b }) => { move(a, [beat("D")], beat("G")); createHeading(b, "D", "R", "z"); },
    check: script => { assert.equal(orderString(script), "#P A B C #R #Q E F D G H"); }
  },
  {
    name: "delete segment head",
    run: ({ a, b }) => {
      move(a, [beat("D")], beat("G"));
      a.doc.transact(() => { a.roots.beats.get("D")?.set("status", JSON.stringify("ready")); }, a.origin);
      remove(b, "D");
    },
    check: script => {
      assert.equal(orderString(script), "#P A B C #Q E F G H");
      assert.equal(script.roots.visuals.get("D")?.toString(), "D");
      assert.equal(script.roots.beats.get("D")?.get("status"), JSON.stringify("ready"));
    }
  },
  {
    name: "delete head while typing",
    run: ({ a, b }) => { move(a, [beat("D")], beat("G")); remove(b, "D"); typeIn(a, "D", "narration", 1, "q"); },
    // why: rule (a) exposes typing into a removed segment head in the nearest surviving beat (C), fixing E10's stranding
    check: script => {
      assert.equal(orderString(script), "#P A B C #Q E F G H");
      assert.equal(script.reader.row("C")?.audioText, "efq");
      assert.deepEqual(script.reader.unplaced(), []);
    }
  },
  {
    name: "drop between tied halves",
    run: ({ net, a, b, order }, ids) => {
      const created = split(b, "B", 1);
      net.deliver(b, a, order);
      move(a, [beat("D")], beat(created));
      ids.set(created, "X");
    },
    check: (script, _, ids) => { assert.equal(orderString(script, ids), "#P A B D X C #Q E F G H"); }
  },
  {
    name: "drop onto heading",
    run: ({ a }) => { move(a, [beat("B")], beat("E")); },
    check: script => { assert.equal(orderString(script), "#P A C D #Q B E F G H"); }
  }
];

for (const item of CASES) {
  test(`E10 collision: ${item.name}, on 2 and 3 copies across client orders and deliveries`, () => {
    let runs2 = 0, runs3 = 0;
    for (const [copies, schedules] of [[2, TWO_CLIENTS], [3, THREE_CLIENTS]] as const) {
      for (const clients of schedules) for (const order of DELIVERIES) {
        const { net, all, undo } = openCopies(clients);
        const [a, b, c] = all, [undoA, undoB] = undo;
        assert.ok(a && b && undoA && undoB);
        const world: E10World = { net, a, b, undoA, undoB, order, aWins: (clients[0] ?? 0) > (clients[1] ?? 0) };
        const ids = new Map<string, string>();
        item.run(world, ids);
        if (c) thirdWriterWork(c);
        net.settle(order);
        net.agree();
        item.check(a, world, ids);
        assert.deepEqual(a.reader.unplaced(), [], `${item.name} (${copies} copies)`);
        if (c) {
          assert.ok(a.reader.row("H")?.visualText.includes("Z"), `${item.name}: 3rd writer visual kept`);
          const pHeading = a.reader.outline().find(e => e.kind === "heading" && e.id === "P");
          assert.equal(pHeading?.kind === "heading" ? pHeading.name : null, "xz", `${item.name}: 3rd writer rename kept`);
          assert.ok(
            a.reader.row("A")?.narration.some(run => run.marks.tag === "t:prop:lamp" || run.marks.innerTags?.includes("t:prop:lamp")),
            `${item.name}: 3rd writer tag kept`
          );
          assert.ok(a.reader.recovery().some(h => h.id === "T"), `${item.name}: 3rd writer removed heading in recovery`);
        }
        for (const row of a.reader.rows()) {
          assert.equal(anchorNativeText(a, { beat: row.id, cell: "narration" }, 0).kind, "anchored", `${item.name}: ${row.id} editable`);
        }
        for (const manager of undo) manager.destroy();
        for (const copy of all) copy.close();
        if (copies === 2) runs2++; else runs3++;
      }
    }
    assert.deepEqual([runs2, runs3], [6, 6], item.name);
  });
}
