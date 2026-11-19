import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import * as Y from "yjs";
import { NativeHeadingReplica } from "../native/headings.ts";
import { removeRow } from "../native/rows.ts";
import { deleteNativeRows } from "./delete.ts";

class TimedReplica extends NativeHeadingReplica {
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
}

function fixture(size: number, perSegment: number): Uint8Array {
  const replica = new NativeHeadingReplica(1, "flag");
  replica.doc.transact(() => {
    let text = new Y.Text();
    for (let n = 0; n < size; n++) {
      const id = `B${n}`;
      if (n % perSegment === 0) {
        const segment = new Y.Map<unknown>(), key = `S${n}`;
        text = new Y.Text();
        replica.segments.set(key, segment);
        segment.set("head", { b: id });
        segment.set("text", text);
        replica.order.push([key]);
      } else text.insertEmbed(text.length, { b: id });
      text.insert(text.length, "n".repeat(120));
      const record = new Y.Map<unknown>();
      replica.beats.set(id, record);
      record.set("status", "ready");
      replica.visuals.set(id, new Y.Text("v".repeat(48)));
    }
  }, "hydration");
  const result = replica.encode();
  replica.destroy();
  return result;
}

function load(bytes: Uint8Array): TimedReplica {
  const replica = new TimedReplica(2, "flag");
  replica.keepCreated = false;
  Y.applyUpdate(replica.doc, bytes, "remote");
  assert.equal(replica.doc.gc, true);
  replica.changes();
  return replica;
}

function compactBytes(replica: NativeHeadingReplica): number {
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, replica.encode());
    return Y.encodeStateAsUpdate(copy).byteLength;
  } finally {
    copy.destroy();
  }
}

function bytesFor(bytes: Uint8Array, ids: string[], variant: "flag" | "keep" | "drop"): [number, number] {
  const replica = load(bytes);
  try {
    if (variant === "flag") for (const id of ids) removeRow(replica, id, "a");
    else deleteNativeRows(replica, { rows: ids }, variant);
    return [replica.encode().byteLength, compactBytes(replica)];
  } finally {
    replica.destroy();
  }
}

function times(bytes: Uint8Array, id: string, variant: "flag" | "keep" | "drop"): Record<string, number[]> {
  const samples = {
    plan: [] as number[], write: [] as number[], deleteRead: [] as number[], deleteTotal: [] as number[],
    undoPress: [] as number[], undoRead: [] as number[], undoTotal: [] as number[]
  };
  for (let n = 0; n < 48; n++) {
    const replica = load(bytes);
    try {
      replica.measureWrite = true;
      const start = performance.now();
      if (variant === "flag") removeRow(replica, id, "a");
      else {
        deleteNativeRows(replica, { rows: [id] }, variant);
        replica.changes();
      }
      const deleted = performance.now();
      assert.ok(replica.undo.undo());
      const undone = performance.now();
      replica.changes();
      const restored = performance.now();
      const { writeStart, writeEnd } = replica;
      assert.ok(start <= writeStart && writeStart <= writeEnd && writeEnd <= deleted);
      if (n >= 8) {
        samples.plan.push(writeStart - start);
        samples.write.push(writeEnd - writeStart);
        samples.deleteRead.push(deleted - writeEnd);
        samples.deleteTotal.push(deleted - start);
        samples.undoPress.push(undone - deleted);
        samples.undoRead.push(restored - undone);
        samples.undoTotal.push(restored - deleted);
      }
    } finally {
      replica.destroy();
    }
  }
  return Object.fromEntries(Object.entries(samples).map(([stage, values]) => {
    values.sort((a, b) => a - b);
    const lower = values[19], upper = values[20], p95 = values[37];
    assert.ok(lower !== undefined && upper !== undefined && p95 !== undefined);
    return [stage, [(lower + upper) / 2, p95].map(value => Number(value.toFixed(3)))];
  }));
}

for (const size of [300, 900]) for (const perSegment of [30, 1]) {
  const bytes = fixture(size, perSegment), row = `B${size / 2 + 1}`;
  const tenth = Array.from({ length: size / 10 }, (_, n) => `B${n * 10 + 1}`);
  for (const variant of ["flag", "keep", "drop"] as const) {
    console.log(JSON.stringify({ size, perSegment, variant, initialBytes: bytes.byteLength,
      one: bytesFor(bytes, [row], variant), tenth: bytesFor(bytes, tenth, variant), ms: times(bytes, row, variant) }));
  }
}
