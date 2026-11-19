import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import * as Y from "yjs";
import { ALL_RULES, NO_RULES } from "../native/variant.ts";
import type { NativeRules } from "../native/variant.ts";
import { ChosenReplica } from "./replica.ts";
import type { ChosenNames } from "./replica.ts";

class TimedReplica extends ChosenReplica {
  measureWrite = false;
  writeStart = 0;
  writeEnd = 0;

  override transact(change: () => void): void {
    if (!this.measureWrite) {
      super.transact(change);
      return;
    }
    this.measureWrite = false;
    this.writeStart = performance.now();
    super.transact(change);
    this.writeEnd = performance.now();
  }

  rebuild(): number {
    this.forgetViews();
    return this.rows().length;
  }
}

// why: 30 beats per segment, a heading at the head of every third segment, 120 letters of narration and 48 of visual
function fixture(size: number, names: ChosenNames): Uint8Array {
  const replica = new ChosenReplica(1, ALL_RULES, names);
  replica.doc.transact(() => {
    let text = new Y.Text();
    for (let n = 0; n < size; n++) {
      const id = `B${n}`;
      if (n % 30 === 0) {
        const segment = new Y.Map<unknown>(), key = `S${n}`, heading = n % 90 === 0;
        text = new Y.Text();
        replica.segments.set(key, segment);
        segment.set("head", heading ? { h: `H${n}` } : { b: id });
        segment.set("text", text);
        replica.order.push([key]);
        if (heading) {
          replica.headings.set(`H${n}`, new Y.Map<unknown>());
          if (names === "cells") { const cell = new Y.Text(); cell.insert(0, `Scene ${n}`, {}); replica.names.set(`H${n}`, cell); }
          else text.insert(0, `Scene ${n}`, {});
          text.insertEmbed(text.length, { b: id }, {});
        }
      } else text.insertEmbed(text.length, { b: id }, {});
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

function load(bytes: Uint8Array, rules: NativeRules, names: ChosenNames): TimedReplica {
  const replica = new TimedReplica(2, rules, names);
  Y.applyUpdate(replica.doc, bytes, "remote");
  replica.changes();
  return replica;
}

const median = (values: number[]): number => {
  const sorted = values.toSorted((a, b) => a - b), middle = sorted.length / 2;
  const low = sorted[Math.floor(middle - 0.5)], high = sorted[Math.ceil(middle - 0.5)];
  assert.ok(low !== undefined && high !== undefined);
  return Number(((low + high) / 2).toFixed(3));
};

function reading(bytes: Uint8Array, rules: NativeRules, size: number, names: ChosenNames): number {
  const replica = load(bytes, rules, names), samples: number[] = [];
  try {
    for (let n = 0; n < 60; n++) {
      const start = performance.now();
      assert.equal(replica.rebuild(), size);
      if (n >= 10) samples.push(performance.now() - start);
    }
  } finally { replica.destroy(); }
  return median(samples);
}

function keystroke(bytes: Uint8Array, rules: NativeRules, size: number, names: ChosenNames): number {
  const replica = load(bytes, rules, names), samples: number[] = [], beat = `B${Math.floor(size / 2) + 1}`;
  try {
    for (let n = 0; n < 210; n++) {
      const start = performance.now();
      replica.splice(beat, "audioText", 5, 5, [{ text: "k", marks: {} }]);
      replica.changes();
      if (n >= 10) samples.push(performance.now() - start);
    }
  } finally { replica.destroy(); }
  return median(samples);
}

type Command = (replica: TimedReplica, size: number) => void;
const COMMANDS: Record<string, Command> = {
  deletion: (replica, size) => { replica.deleteRows([`B${size / 2 + 1}`]); },
  split: (replica, size) => { replica.split(`B${size / 2 + 1}`, 60, "N"); },
  move: (replica, size) => { assert.equal(replica.drop({ unit: "row", first: `B${size / 2 + 1}`, target: "B3", after: true }), true); }
};

function command(bytes: Uint8Array, size: number, run: Command, names: ChosenNames): { write: number; rebuild: number; total: number; rebuildShare: number } {
  const write: number[] = [], rebuild: number[] = [], total: number[] = [];
  for (let n = 0; n < 40; n++) {
    const replica = load(bytes, ALL_RULES, names);
    try {
      replica.measureWrite = true;
      const start = performance.now();
      run(replica, size);
      const written = performance.now();
      replica.changes();
      const shown = performance.now();
      assert.ok(start <= replica.writeStart && replica.writeEnd <= written);
      if (n >= 8) { write.push(replica.writeEnd - replica.writeStart); rebuild.push(shown - written); total.push(shown - start); }
    } finally { replica.destroy(); }
  }
  const result = { write: median(write), rebuild: median(rebuild), total: median(total) };
  return { ...result, rebuildShare: Number((result.rebuild / result.total).toFixed(2)) };
}

for (const names of ["inline", "cells"] as const) {
  for (const size of [30, 300, 900]) {
    const bytes = fixture(size, names);
    console.log(JSON.stringify({
      names, size, bytes: bytes.byteLength,
      readMs: { rules: reading(bytes, ALL_RULES, size, names), plain: reading(bytes, NO_RULES, size, names) },
      keystrokeMs: { rules: keystroke(bytes, ALL_RULES, size, names), plain: keystroke(bytes, NO_RULES, size, names) }
    }));
  }
  const large = fixture(900, names);
  for (const [name, run] of Object.entries(COMMANDS)) console.log(JSON.stringify({ names, size: 900, command: name, ms: command(large, 900, run, names) }));
}
