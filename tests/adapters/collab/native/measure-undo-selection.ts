import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { serialize } from "node:v8";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import { openNativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { snapshotNativeUndoAnchor } from "../../../../src/adapters/collab/native/text-commands.ts";
import { beatField } from "./record-harness.ts";
import { largeState } from "./structural.ts";

type Session = ReturnType<typeof openNativeSession>;
const state = largeState();
const field = { beat: "B451", cell: "narration" } as const;
const letters = 1_000, rounds = 5;

function open(bytes = state): Session {
  const copy = openNativeSession({ kind: "state", state: bytes }, { actor: "Writer", sanitize: html => String(html ?? "") });
  copy.ydoc.clientID = 0xf1234567;
  copy.document();
  return copy;
}

function anchor(copy: Session, from: number, to = from) {
  const result = copy.commands.anchorText(field, from, to);
  assert.equal(result.kind, "anchored");
  return result.range;
}

function endpoints(copy: Session, to: number) {
  const start = anchor(copy, 60);
  return to === 60 ? start : { anchor: start, head: anchor(copy, to) };
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
        step.recordAfter();
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

function anchorCost(copy: Session, script: ReturnType<typeof openNativeScript>, to: number) {
  const samples: number[] = [];
  for (let index = 0; index < letters; index++) {
    const start = performance.now();
    assert(snapshotNativeUndoAnchor(script, endpoints(copy, to)));
    samples.push(performance.now() - start);
  }
  return median(samples);
}

async function measureTyping() {
  typing(false);
  typing(true);
  await Promise.resolve();
  const plain: number[] = [], selected: number[] = [], caret: number[] = [], range: number[] = [];
  const copy = open(), script = openNativeScript(copy.ydoc);
  try {
    assert.equal(copy.commands.typeText(anchor(copy, 60), "x", {}).kind, "written");
    for (let round = 0; round < rounds; round++) {
      for (const selectedFirst of round % 2 === 0 ? [false, true] : [true, false]) {
        (selectedFirst ? selected : plain).push(typing(selectedFirst));
        await Promise.resolve();
      }
      caret.push(anchorCost(copy, script, 60));
      range.push(anchorCost(copy, script, 68));
    }
    const print = (values: readonly number[]): string =>
      `${median(values).toFixed(4)} [${Math.min(...values).toFixed(4)}-${Math.max(...values).toFixed(4)}]`;
    console.log(`Node ${process.version} ${process.arch}. ${rounds} rounds of ${letters} keys on 900 beats, median ms [round min-max].`);
    console.log(`Typing without selection: ${print(plain)}. With before and after carets: ${print(selected)}. Delta: ${(median(selected) - median(plain)).toFixed(4)} ms.`);
    for (const [label, to, samples] of [["Caret", 60, caret], ["Range", 68, range]] as const) {
      const stored = snapshotNativeUndoAnchor(script, endpoints(copy, to));
      assert(stored);
      const positions = Y.encodeRelativePosition(stored.anchor.position).length
        + (stored.anchor === stored.head ? 0 : Y.encodeRelativePosition(stored.head.position).length);
      console.log(`${label} anchor + snapshot: ${print(samples)} ms. One selection: ${positions} position bytes, ${serialize(stored).length} V8 snapshot bytes including targets.`);
    }
  } finally {
    script.close();
    copy.close();
    await Promise.resolve();
  }
}

function withWriters(writers: number): Uint8Array {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    for (let writer = 1; writer < writers; writer++) {
      doc.clientID = 0xf0000000 + writer;
      doc.getMap("meta").set("measurement", writer);
    }
    assert.equal(Y.decodeStateVector(Y.encodeStateVector(doc)).size, writers);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

async function retainedHeap(bytes: Uint8Array, selected: boolean, gc: () => void): Promise<number> {
  const copy = open(bytes), status = beatField(field.beat, "status");
  try {
    gc();
    const start = process.memoryUsage().heapUsed;
    for (let i = 0; i < 10_000; i++) {
      const value = i % 2 ? "ready" : "shot";
      if (selected) {
        const step = copy.commands.setField.withSelection(endpoints(copy, 68), status, value);
        assert.equal(step.result.kind, "written");
        step.recordAfter(endpoints(copy, 68));
      } else assert.equal(copy.commands.setField(status, value).kind, "written");
    }
    await Promise.resolve();
    gc();
    return process.memoryUsage().heapUsed - start;
  } finally {
    copy.close();
    await Promise.resolve();
  }
}

async function measureMemory() {
  const gc = globalThis.gc;
  assert(gc, "Run with --expose-gc for the retained heap measurement.");
  for (const writers of [2, 1002]) {
    const copy = open(withWriters(writers)), script = openNativeScript(copy.ydoc);
    try {
      const range = endpoints(copy, 68);
      const stored = snapshotNativeUndoAnchor(script, range);
      assert(stored);
      assert(!("seen" in stored));
      console.log(`${writers} writers: 0 retained state-vector bytes, ${serialize(stored).length} V8 snapshot bytes for one range.`);
    } finally {
      script.close();
      copy.close();
      await Promise.resolve();
    }
  }
  const bytes = withWriters(102);
  const plain = await retainedHeap(bytes, false, gc), selected = await retainedHeap(bytes, true, gc);
  console.log(`10,000 steps with 102 writers: ${(selected / 1e6).toFixed(2)} MB heap with two ranges per step, ${(plain / 1e6).toFixed(2)} MB without selection, ${((selected - plain) / 1e6).toFixed(2)} MB difference.`);
}

try {
  if (process.argv.includes("--memory")) await measureMemory();
  else await measureTyping();
} finally {
  dom.window.close();
}
