import assert from "node:assert/strict";
import { isDeepStrictEqual as equal } from "node:util";
import test from "node:test";
import * as Y from "yjs";
import { KeptReplica } from "../../src/native-kept/replica.ts";
import { ALL_RULES } from "../../src/native/variant.ts";
import type { ChosenReplica } from "../../src/native-chosen/replica.ts";
import { OPTIONS, makeOption } from "../../src/native-rank-undo/variants.ts";
import type { RankOption } from "../../src/native-rank-undo/variants.ts";
import { readStyles } from "../native-chosen/engine.ts";
import { load, outline, seed } from "../native-chosen/kit.ts";
import type { MakeReplica } from "../native-chosen/kit.ts";
import { perform } from "../native-chosen/play.ts";
import type { Cmd } from "../native-chosen/play.ts";
import { justTwo } from "./histories.ts";

type Outcome = "done" | "refused" | `throws: ${string}`;

// why: offline, Alice and Bob each delete the row and undo, Bob (the higher client) redoes, and everything is
// delivered; returns Alice's copy and Bob's
function lose(make: MakeReplica, row = "B"): ChosenReplica[] {
  const bytes = seed(justTwo(), ALL_RULES, "cells", make), copies = [load(bytes, 1, ALL_RULES, "cells", make), load(bytes, 2, ALL_RULES, "cells", make)];
  const [alice, bob] = copies;
  if (!alice || !bob) throw new Error("copy");
  const cut: Cmd = { op: "delete", rows: [row] };
  for (const [copy, cmd] of [[alice, cut], [bob, cut], [alice, { op: "undo" }], [bob, { op: "undo" }], [bob, { op: "redo" }]] as const) perform(copy, cmd as Cmd);
  for (let round = 0; round < 2; round++) for (const [from, to] of [[alice, bob], [bob, alice]] as const) {
    Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)), "remote");
    to.changes();
  }
  return copies;
}

const ACTIONS: Record<string, Cmd> = {
  "type narration": { op: "type", id: "B", field: "audio", at: 0, text: "x" },
  "type visual": { op: "type", id: "B", field: "visual", at: 0, text: "x" },
  format: { op: "format", id: "B", field: "audio", from: 0, to: 1, key: "b", on: true },
  "set a status": { op: "field", id: "B", key: "status", value: "done" },
  move: { op: "move", drop: { unit: "row", first: "B", target: "A", after: false } },
  split: { op: "split", id: "B", at: 1, created: "S" },
  join: { op: "join", id: "B" },
  delete: { op: "delete", rows: ["B"] },
  "insert a row before it": { op: "insert", before: "B", id: "N", text: "n" }
};

// why: done means the stored state changed without a throw; a throw also says whether it wrote anything first
function act(make: MakeReplica, cmd: Cmd): { outcome: Outcome; rows: string[]; record: boolean } {
  const copies = lose(make), [alice] = copies;
  if (!alice) throw new Error("copy");
  try {
    const before = readStyles(alice);
    let outcome: Outcome;
    try {
      perform(alice, cmd);
      outcome = equal(before, readStyles(alice)) ? "refused" : "done";
    } catch (error) {
      outcome = `throws: ${(error as Error).message}${equal(before, readStyles(alice)) ? "" : " (after writing)"}`;
    }
    let rows: string[];
    try { rows = outline(alice); } catch (error) { rows = [`outline throws: ${(error as Error).message}`]; }
    return { outcome, rows, record: alice.beats.has("B") };
  } finally { for (const copy of copies) copy.destroy(); }
}

const kept: MakeReplica = client => new KeptReplica(client, ALL_RULES);

test("E15 record loss: what each command does to a row that came back with narration but no record or visual cell", t => {
  const table: Record<string, Record<RankOption, Outcome>> = {};
  for (const option of OPTIONS) {
    const copies = lose(makeOption(option));
    for (const copy of copies) {
      assert.deepEqual(outline(copy), ["A: a / ", "B: b / "], `${option}: B's narration shows`);
      assert.equal(copy.beats.has("B"), false, `${option}: B's record is gone`);
      assert.equal(copy.visuals.has("B"), false, `${option}: B's visual cell is gone`);
      copy.destroy();
    }
    for (const [name, cmd] of Object.entries(ACTIONS)) {
      const { outcome, rows } = act(makeOption(option), cmd);
      (table[name] ??= {} as Record<RankOption, Outcome>)[option] = outcome;
      t.diagnostic(`${option} / ${name}: ${outcome} | ${rows.join(", ")}`);
    }
  }
  t.diagnostic(JSON.stringify(table));
  // why: the same in every option; every throw comes before any write
  const expected: Record<string, Outcome> = {
    "type narration": "done", "type visual": "throws: Missing visual B", format: "done", "set a status": "throws: Missing beat record B",
    move: "throws: Missing record b:B", split: "throws: Missing record b:B", join: "throws: Missing beat record B", delete: "done",
    "insert a row before it": "done"
  };
  for (const [name, outcome] of Object.entries(expected)) for (const option of OPTIONS) assert.equal(table[name]?.[option], outcome, `${option} / ${name}`);
});

test("E15 record loss: a row inserted before the row with no record is whole, in every option", t => {
  for (const option of OPTIONS) {
    const copies = lose(makeOption(option)), [alice] = copies;
    if (!alice) throw new Error("copy");
    try {
      perform(alice, { op: "insert", before: "B", id: "N", text: "n" });
      assert.ok(alice.beats.has("N") && alice.visuals.has("N"), `${option}: N has a record and a visual cell`);
      perform(alice, { op: "type", id: "N", field: "visual", at: 0, text: "v" });
      perform(alice, { op: "split", id: "N", at: 0, created: "M" });
      t.diagnostic(`${option}: ${outline(alice).join(", ")}`);
      assert.deepEqual(outline(alice), option === "E" ? ["A: a / ", "N:  / v", "M: n / ", "B: b / "] : ["N:  / v", "M: n / ", "A: a / ", "B: b / "], option);
    } finally { for (const copy of copies) copy.destroy(); }
  }
});

test("E15 record loss at a segment head: the head entry races too, and option E's fixed place goes with it", t => {
  for (const option of OPTIONS) {
    const copies = lose(makeOption(option), "A");
    try {
      for (const copy of copies) {
        t.diagnostic(`${option}: ${outline(copy).join(", ")} | head ${JSON.stringify(copy.segments.get("S")?.get("head") ?? null)}`);
        assert.equal(copy.segments.get("S")?.has("head"), false, `${option}: the head entry is gone`);
        assert.equal(copy.beats.has("A") || copy.visuals.has("A"), false, `${option}: A's record and visual cell are gone`);
        assert.deepEqual(outline(copy), ["B: ab / "], `${option}: A is no row; its narration shows at the start of B's`);
      }
    } finally { for (const copy of copies) copy.destroy(); }
  }
});

test("E15 record loss with E14's kept containers on and off: whether B's record is still there", t => {
  const off = lose(makeOption("A")), on = lose(kept);
  try {
    const facts = { off: off.map(copy => [copy.beats.has("B"), copy.visuals.has("B"), outline(copy).join(", ")]), on: on.map(copy => [copy.beats.has("B"), copy.visuals.has("B"), outline(copy).join(", ")]) };
    t.diagnostic(JSON.stringify(facts));
    for (const copy of off) assert.equal(copy.beats.has("B"), false, "kept containers off: the record is gone");
    for (const copy of on) {
      assert.equal(copy.beats.has("B"), true, "kept containers on: the record is never deleted, so the two undos write nothing to it");
      assert.equal(copy.visuals.has("B"), true, "kept containers on: the visual cell stays");
      assert.deepEqual(outline(copy), ["A: a / ", "B: b / "], "kept containers on: B shows with its narration");
    }
  } finally { for (const copy of [...off, ...on]) copy.destroy(); }
});
