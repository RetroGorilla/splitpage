import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { serialize } from "node:v8";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import { nativeRangeSnapshot } from "../../../../src/adapters/collab/native/text-commands.ts";
import { largeState } from "./structural.ts";

type Session = ReturnType<typeof openNativeSession>;
const state = largeState();
const field = { beat: "B451", cell: "narration" } as const;
const letters = 1_000, rounds = 5;

function open(): Session {
  const copy = openNativeSession({ kind: "state", state }, { actor: "Writer", sanitize: html => String(html ?? "") });
  copy.ydoc.clientID = 0xf1234567;
  copy.document();
  return copy;
}

function anchor(copy: Session, from: number, to = from) {
  const result = copy.commands.anchorText(field, from, to);
  assert.equal(result.kind, "anchored");
  return result.range;
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = (sorted.length - 1) / 2;
  return ((sorted[Math.floor(middle)] ?? NaN) + (sorted[Math.ceil(middle)] ?? NaN)) / 2;
}

function typing(withSelection: boolean): number {
  const copy = open(), samples: number[] = [];
  try {
    for (let index = 0; index < letters; index++) {
      const from = 60 + index, start = performance.now();
      const before = anchor(copy, from);
      if (withSelection) {
        const step = copy.commands.typeText.withSelection(before, before, "x", {});
        step.recordAfter(anchor(copy, from + 1));
        assert.equal(step.result.kind, "written");
      } else {
        assert.equal(copy.commands.typeText(before, "x", {}).kind, "written");
      }
      samples.push(performance.now() - start);
    }
    assert.equal(copy.document().rows.find(row => row.id === field.beat)?.audioText, "n".repeat(60) + "x".repeat(letters) + "n".repeat(60));
    return median(samples);
  } finally {
    copy.close();
  }
}

function anchorCost(copy: Session, to: number) {
  const samples: number[] = [];
  for (let index = 0; index < letters; index++) {
    const start = performance.now();
    assert(nativeRangeSnapshot(anchor(copy, 60, to)));
    samples.push(performance.now() - start);
  }
  return median(samples);
}

typing(false);
typing(true);
await Promise.resolve();
const plain: number[] = [], selected: number[] = [], caret: number[] = [], range: number[] = [];
const copy = open();
try {
  assert.equal(copy.commands.typeText(anchor(copy, 60), "x", {}).kind, "written");
  for (let round = 0; round < rounds; round++) {
    for (const selectedFirst of round % 2 === 0 ? [false, true] : [true, false]) {
      (selectedFirst ? selected : plain).push(typing(selectedFirst));
      await Promise.resolve();
    }
    caret.push(anchorCost(copy, 60));
    range.push(anchorCost(copy, 68));
  }
  const print = (values: readonly number[]): string =>
    `${median(values).toFixed(4)} [${Math.min(...values).toFixed(4)}-${Math.max(...values).toFixed(4)}]`;
  console.log(`Node ${process.version} ${process.arch}. ${rounds} rounds of ${letters} keys on 900 beats, median ms [round min-max].`);
  console.log(`Typing without selection: ${print(plain)}. With before and after carets: ${print(selected)}.`);
  for (const [label, to, samples] of [["Caret", 60, caret], ["Range", 68, range]] as const) {
    const anchored = anchor(copy, 60, to), stored = nativeRangeSnapshot(anchored);
    const positions = Y.encodeRelativePosition(anchored.from).length
      + (anchored.from === anchored.to ? 0 : Y.encodeRelativePosition(anchored.to).length);
    const vector = anchored.seen ? Y.encodeStateVector(new Map(anchored.seen)).length : 0;
    console.log(`${label} anchor + snapshot: ${print(samples)} ms. One anchor: ${positions} position bytes, ${vector} vector bytes, ${serialize(stored).length} V8 snapshot bytes including target.`);
  }
} finally {
  copy.close();
  await Promise.resolve();
  dom.window.close();
}
