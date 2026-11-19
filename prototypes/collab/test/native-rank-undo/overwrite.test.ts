import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { ALL_RULES } from "../../src/native/variant.ts";
import { OPTIONS, makeOption } from "../../src/native-rank-undo/variants.ts";
import type { RankOption } from "../../src/native-rank-undo/variants.ts";
import { load, seed } from "../native-chosen/kit.ts";
import type { Spec } from "../native-chosen/kit.ts";
import { perform } from "../native-chosen/play.ts";
import type { Cmd, Step } from "../native-chosen/play.ts";
import { countOverwrites, generatedLists } from "./overwrite.ts";
import type { Overwrites } from "./overwrite.ts";
import { fourBeats, twoBeats } from "./histories.ts";

const SIZE = Number(process.env.E15_SEEDS ?? 600);

// why: Alice acts, Bob sees it and acts on the same beat, Bob's change reaches Alice, and Alice undoes
function seenThenUndo(option: RankOption, spec: Spec, alice: Cmd, bob: Cmd, read: (copy: ReturnType<typeof load>) => unknown): unknown {
  const make = makeOption(option), bytes = seed(spec, ALL_RULES, "cells", make);
  const copies = [load(bytes, 1, ALL_RULES, "cells", make), load(bytes, 2, ALL_RULES, "cells", make)] as const;
  const send = (from: 0 | 1, to: 0 | 1): void => { Y.applyUpdate(copies[to].doc, Y.encodeStateAsUpdate(copies[from].doc, Y.encodeStateVector(copies[to].doc)), "remote"); copies[to].changes(); };
  try {
    perform(copies[0], alice); send(0, 1);
    perform(copies[1], bob); send(1, 0);
    perform(copies[0], { op: "undo" }); send(0, 1);
    return read(copies[1]);
  } finally { for (const copy of copies) copy.destroy(); }
}

test("E15 option B: an undo overwrites a later value someone else wrote after seeing it", () => {
  const status = (option: RankOption): unknown => seenThenUndo(option, { ...twoBeats(), beats: { A: {}, B: { status: "todo" } } },
    { op: "field", id: "B", key: "status", value: "ready" }, { op: "field", id: "B", key: "status", value: "done" }, copy => copy.beats.get("B")?.get("status"));
  assert.deepEqual(OPTIONS.map(status), ["done", "todo", "done", "done"]);
  const order = (option: RankOption): unknown => seenThenUndo(option, fourBeats(),
    { op: "move", drop: { unit: "row", first: "B", target: "C", after: true } }, { op: "move", drop: { unit: "row", first: "B", target: "D", after: true } }, copy => copy.rows().map(row => row.id).join(""));
  assert.deepEqual(OPTIONS.map(order), ["ACDB", "ABCD", "ACDB", "ACDB"]);
});

test("E15 the overwrite count sees the hand-built cases: a seen later status and a seen later move", () => {
  const steps = (key: Cmd, later: Cmd): { spec: Spec; steps: Step[] } => ({
    spec: { ...fourBeats(), beats: { A: {}, B: { status: "todo" }, C: {}, D: {} } },
    steps: [{ by: 0, cmd: key }, { from: 0, to: 1 }, { by: 1, cmd: later }, { from: 1, to: 0 }, { by: 0, cmd: { op: "undo" } }]
  });
  const lists = [
    steps({ op: "field", id: "B", key: "status", value: "ready" }, { op: "field", id: "B", key: "status", value: "done" }),
    steps({ op: "move", drop: { unit: "row", first: "B", target: "C", after: true } }, { op: "move", drop: { unit: "row", first: "B", target: "D", after: true } })
  ];
  assert.deepEqual(OPTIONS.map(option => countOverwrites(option, lists).others),
    [{}, { "beats.status": 1, "beats.rank": 1 }, {}, {}]);
});

test("E15 generated histories: how often an undo or redo press changes a value another person wrote", t => {
  const table: Record<string, Overwrites> = {}, lists = generatedLists(SIZE);
  for (const option of OPTIONS) table[option] = countOverwrites(option, lists);
  t.diagnostic(JSON.stringify(table));
  for (const option of ["A", "C", "D"] as const) assert.deepEqual(table[option]?.others, {}, `${option}: a plain undo never changes another person's value`);
});
