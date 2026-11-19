import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import * as Y from "yjs";
import type { ChosenReplica } from "../native-chosen/replica.ts";
import { ALL_RULES } from "../native/variant.ts";
import { OPTIONS, makeOption } from "./variants.ts";
import type { RankOption } from "./variants.ts";

const NAMES = "cells";

// why: E11's cost fixture: 30 beats per segment, a heading at the head of every third segment, 120 letters of
// narration and 48 of visual text per beat; each boundary is the one the option writes at hydration
function fixture(option: RankOption, size: number): Uint8Array {
  const replica = makeOption(option)(1, ALL_RULES, NAMES);
  let places = 0;
  replica.doc.transact(() => {
    let text = new Y.Text();
    for (let n = 0; n < size; n++) {
      const id = `B${n}`;
      if (n % 30 === 0) {
        const segment = new Y.Map<unknown>(), key = `S${n}`, heading = n % 90 === 0;
        text = new Y.Text();
        replica.segments.set(key, segment);
        segment.set("head", heading ? replica.hydratedBoundary(places++, "h", `H${n}`) : replica.hydratedBoundary(places++, "b", id));
        segment.set("text", text);
        replica.order.push([key]);
        if (heading) {
          replica.headings.set(`H${n}`, new Y.Map<unknown>());
          const cell = new Y.Text(); cell.insert(0, `Scene ${n}`, {}); replica.names.set(`H${n}`, cell);
          text.insertEmbed(text.length, replica.hydratedBoundary(places++, "b", id), {});
        }
      } else text.insertEmbed(text.length, replica.hydratedBoundary(places++, "b", id), {});
      text.insert(text.length, "n".repeat(120), {});
      replica.beats.set(id, new Y.Map<unknown>([["status", "ready"]]));
      const visual = new Y.Text();
      visual.insert(0, "v".repeat(48), {});
      replica.visuals.set(id, visual);
    }
  }, "hydration");
  replica.initializeRanks();
  const result = replica.encode();
  replica.destroy();
  return result;
}

function open(option: RankOption, bytes: Uint8Array, client: number): ChosenReplica {
  const replica = makeOption(option)(client, ALL_RULES, NAMES);
  Y.applyUpdate(replica.doc, bytes, "remote");
  replica.changes();
  return replica;
}

const fresh = (option: RankOption, replica: ChosenReplica): number => {
  const copy = open(option, replica.encode(), 99), length = copy.encode().length;
  copy.destroy();
  return length;
};

const median = (values: number[]): number => Number(values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]?.toFixed(3));

// why: E10's move schedule: random single-row drops, each to after another row
function schedule(beats: number, count: number, seed: number): { first: string; target: string }[] {
  const order = Array.from({ length: beats }, (_, i) => `B${i}`), moves: { first: string; target: string }[] = [];
  const choose = (limit: number): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed * limit / 0x100000000); };
  while (moves.length < count) {
    const from = choose(beats - 1), to = choose(beats - 1), first = order[from], target = order[to];
    if (from === to || from === to + 1 || !first || !target) continue;
    moves.push({ first, target });
    order.splice(from, 1);
    order.splice(order.indexOf(target) + 1, 0, first);
  }
  return moves;
}

function lifetime(option: RankOption): { initial: number; perRow: number; sentPerMove: number; keptPerMove: number } {
  const replica = open(option, fixture(option, 300), 2), initial = fresh(option, replica), moves = schedule(300, 1000, 17), perRow = Number((initial / 300).toFixed(2));
  let sent = 0;
  replica.doc.on("update", (update: Uint8Array) => { sent += update.length; });
  try {
    for (const move of moves) { assert.ok(replica.drop({ unit: "row", first: move.first, target: move.target, after: true })); replica.changes(); }
    return { initial, perRow, sentPerMove: Number((sent / moves.length).toFixed(2)), keptPerMove: Number(((fresh(option, replica) - initial) / moves.length).toFixed(2)) };
  } finally { replica.destroy(); }
}

function timing(option: RankOption, size: number): { readMs: number; moveMs: number } {
  const bytes = fixture(option, size), reads: number[] = [], moves: number[] = [];
  const replica = open(option, bytes, 2);
  try {
    for (let n = 0; n < 60; n++) {
      const start = performance.now();
      (replica as unknown as { forgetViews: () => void }).forgetViews();
      assert.equal(replica.rows().length, size);
      if (n >= 10) reads.push(performance.now() - start);
    }
  } finally { replica.destroy(); }
  for (let n = 0; n < 40; n++) {
    const copy = open(option, bytes, 2);
    try {
      const start = performance.now();
      assert.ok(copy.drop({ unit: "row", first: `B${size / 2 + 1}`, target: "B3", after: true }));
      copy.changes();
      if (n >= 8) moves.push(performance.now() - start);
    } finally { copy.destroy(); }
  }
  return { readMs: median(reads), moveMs: median(moves) };
}

for (const option of process.argv.slice(2).length ? process.argv.slice(2) as RankOption[] : OPTIONS) {
  console.log(JSON.stringify({ option, ...lifetime(option), at900: timing(option, 900) }));
}
