import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { ALL_RULES } from "../../src/native/variant.ts";
import type { ChosenReplica } from "../../src/native-chosen/replica.ts";
import { makeOption } from "../../src/native-rank-undo/variants.ts";
import type { EntryRankReplica, RankOption } from "../../src/native-rank-undo/variants.ts";
import { load, seed } from "../native-chosen/kit.ts";
import { perform } from "../native-chosen/play.ts";
import type { Cmd } from "../native-chosen/play.ts";
import { fourBeats } from "./histories.ts";
import { held, liveCount } from "./storage.ts";

const after = (target: string): Cmd => ({ op: "move", drop: { unit: "row", first: "B", target, after: true } });

interface Growth { rounds: number[]; rows: string[]; cleared: number; restored: number; cycles: number[] }

// why: per round, Alice moves B after C while Bob moves B after D, everything is delivered, both undo, and everything
// is delivered again; the live rank entries of B are counted once both copies have everything
function grow(option: RankOption, rounds: number): Growth {
  const make = makeOption(option), bytes = seed(fourBeats(), ALL_RULES, "cells", make);
  const copies: ChosenReplica[] = [load(bytes, 1, ALL_RULES, "cells", make), load(bytes, 2, ALL_RULES, "cells", make)];
  const [alice, bob] = copies;
  if (!alice || !bob) throw new Error("copy");
  const swap = (): void => {
    for (const [from, to] of [[alice, bob], [bob, alice]] as const) { Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)), "remote"); to.changes(); }
  };
  const live = (): number => {
    const counts = copies.map(copy => liveCount(option, held(option, copy).get("b:B") ?? []));
    assert.equal(counts[0], counts[1], "both copies hold the same entries");
    return counts[0] ?? 0;
  };
  try {
    const result: Growth = { rounds: [], rows: [], cleared: 0, restored: 0, cycles: [] };
    for (let round = 0; round < rounds; round++) {
      perform(alice, after("C")); perform(bob, after("D")); swap();
      perform(alice, { op: "undo" }); perform(bob, { op: "undo" }); swap();
      result.rounds.push(live());
    }
    result.rows = alice.rows().map(row => row.id);
    perform(alice, after("C")); swap(); result.cleared = live();
    perform(alice, { op: "undo" }); swap(); result.restored = live();
    for (let cycle = 0; cycle < rounds; cycle++) { perform(alice, { op: "redo" }); perform(alice, { op: "undo" }); swap(); result.cycles.push(live()); }
    return result;
  } finally { for (const copy of copies) copy.destroy(); }
}

test("E15 growth: C and D after rounds of two moves at once and two undos", t => {
  const c = grow("C", 8), d = grow("D", 8);
  t.diagnostic(`C: ${JSON.stringify(c)}`);
  t.diagnostic(`D: ${JSON.stringify(d)}`);
  // why: D keeps every entry the two undos bring back, and each undo brings back every entry the move it takes back
  // deleted, so the live count doubles each round: 2^n after n rounds
  assert.deepEqual(d.rounds, [2, 4, 8, 16, 32, 64, 128, 256]);
  assert.deepEqual(d.rows, ["A", "B", "C", "D"]);
  assert.equal(d.cleared, 1, "D: an ordinary move that has every entry deletes them all");
  assert.equal(d.restored, 256, "D: its undo brings them all back");
  assert.deepEqual(d.cycles, Array.from({ length: 8 }, () => 256));
  assert.deepEqual(c.rounds, Array.from({ length: 8 }, () => 1));
  assert.deepEqual(c.rows, ["A", "B", "C", "D"]);
});

test("E15 C's reader order: the move counter first, then the writer's client, then the writer's clock", () => {
  const make = makeOption("C"), bytes = seed(fourBeats(), ALL_RULES, "cells", make);
  const alice = load(bytes, 1, ALL_RULES, "cells", make), bob = load(bytes, 2, ALL_RULES, "cells", make);
  try {
    perform(alice, after("C")); perform(alice, after("D")); perform(bob, after("C"));
    for (const [from, to] of [[alice, bob], [bob, alice]] as const) { Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)), "remote"); to.changes(); }
    const shown = (alice as EntryRankReplica).shownEntry(alice.beats.get("B") as Y.Map<unknown>);
    assert.equal(shown?.client, 1, "two offline moves by Alice (stamp 3) beat one by Bob (stamp 2), although Bob's client is higher");
    assert.deepEqual([alice.rows().map(row => row.id), bob.rows().map(row => row.id)], [["A", "C", "D", "B"], ["A", "C", "D", "B"]]);
  } finally { alice.destroy(); bob.destroy(); }
});
