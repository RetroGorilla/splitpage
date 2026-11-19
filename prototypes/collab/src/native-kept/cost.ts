import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import * as Y from "yjs";
import { ChosenReplica } from "../native-chosen/replica.ts";
import { KeptReplica } from "./replica.ts";

class BuiltMeter extends ChosenReplica {
  constructor() { super(2, undefined, "cells"); }
  rebuild(): number { this.forgetViews(); return this.outline().length; }
}

class KeptMeter extends KeptReplica {
  constructor() { super(2); }
  rebuild(): number { this.forgetViews(); return this.outline().length; }
}

function fixture(size: number, edited: boolean): Uint8Array {
  const replica = new ChosenReplica(1, undefined, "cells");
  try {
    replica.doc.transact(() => {
      let text = new Y.Text();
      for (let index = 0; index < size; index++) {
        const id = `B${index}`;
        if (index % 30 === 0) {
          const key = `S${index}`, segment = new Y.Map<unknown>();
          text = new Y.Text();
          replica.segments.set(key, segment);
          segment.set("head", { b: id });
          segment.set("text", text);
          replica.order.push([key]);
        } else text.insertEmbed(text.length, { b: id }, {});
        text.insert(text.length, "n".repeat(120), {});
        const record = new Y.Map<unknown>();
        const visual = new Y.Text();
        replica.beats.set(id, record);
        replica.visuals.set(id, visual);
        record.set("status", edited ? "todo" : "ready");
        visual.insert(0, "v".repeat(48), {});
        if (edited) {
          record.set("status", "ready");
          visual.insert(12, "edit", { b: true });
          visual.delete(18, 4);
        }
      }
      replica.initializeRanks();
    }, "hydration");
    return replica.encode();
  } finally { replica.destroy(); }
}

function load(bytes: Uint8Array, keep: boolean): BuiltMeter | KeptMeter {
  const replica = keep ? new KeptMeter() : new BuiltMeter();
  Y.applyUpdate(replica.doc, bytes, "remote");
  replica.changes();
  return replica;
}

function cut(bytes: Uint8Array, keep: boolean, start: number, count: number): { editor: Uint8Array; fresh: Uint8Array } {
  const editor = load(bytes, keep);
  try {
    editor.deleteRows(Array.from({ length: count }, (_, i) => `B${start + i}`));
    const update = editor.encode();
    const fresh = load(update, keep);
    try { return { editor: update, fresh: fresh.encode() }; } finally { fresh.destroy(); }
  } finally { editor.destroy(); }
}

function storage(size: number, edited: boolean) {
  const bytes = fixture(size, edited);
  const built = cut(bytes, false, 0, size), kept = cut(bytes, true, 0, size);
  const fresh = load(kept.fresh, true);
  let withoutCells: number, withoutText: number;
  try {
    fresh.doc.transact(() => {
      for (const cell of fresh.visuals.values()) cell.delete(0, cell.length);
    }, "measurement");
    withoutText = fresh.encode().byteLength;
    fresh.doc.transact(() => {
      for (const id of [...fresh.visuals.keys()]) fresh.visuals.delete(id);
    }, "measurement");
    withoutCells = fresh.encode().byteLength;
  } finally { fresh.destroy(); }
  return {
    size, edited, before: bytes.byteLength,
    built: { editor: built.editor.byteLength, fresh: built.fresh.byteLength },
    kept: { editor: kept.editor.byteLength, fresh: kept.fresh.byteLength },
    extraPerBeat: (kept.fresh.byteLength - built.fresh.byteLength) / size,
    marginalPerBeat: {
      record: (withoutCells - built.fresh.byteLength) / size,
      cellMetadata: (withoutText - withoutCells) / size,
      textAndMarks: (kept.fresh.byteLength - withoutText) / size
    }
  };
}

function watchMaps(replica: ChosenReplica): { counts: { scans: number; gets: number }; restore: () => void } {
  const counts = { scans: 0, gets: 0 }, reset: (() => void)[] = [];
  for (const map of [replica.beats, replica.visuals]) {
    for (const name of [Symbol.iterator, "forEach", "entries", "values", "keys", "get"] as const) {
      const original = map[name] as (...args: unknown[]) => unknown;
      Object.defineProperty(map, name, { configurable: true, value: (...args: unknown[]): unknown => {
        if (name === "get") counts.gets++; else counts.scans++;
        return original.apply(map, args);
      } });
      reset.push(() => { Reflect.deleteProperty(map, name); });
    }
  }
  return { counts, restore: () => { for (const fn of reset) fn(); } };
}

function median(values: number[]): number {
  const middle = values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  assert.ok(middle !== undefined);
  return +middle.toFixed(3);
}

function time(bytes: Uint8Array, keep: boolean, removed: number) {
  const copy = load(bytes, keep);
  try {
    const live = 900, watch = watchMaps(copy);
    const read = (): number => copy.rebuild();
    const key = (): void => { copy.splice("B451", "audioText", 5, 5, [{ text: "k", marks: {} }]); copy.changes(); };
    const access = {
      read: (() => { assert.equal(read(), live); return { ...watch.counts }; })(),
      key: (() => { watch.counts.gets = 0; key(); return { ...watch.counts }; })()
    };
    watch.restore();
    assert.deepEqual([access.read.scans, access.key.scans], [0, 0]);
    const samples = (n: number, warmup: number, run: () => unknown): number => {
      const values: number[] = [];
      for (let i = 0; i < n + warmup; i++) {
        const start = performance.now();
        run();
        if (i >= warmup) values.push(performance.now() - start);
      }
      return median(values);
    };
    return { keep, removed, records: copy.beats.size, cells: copy.visuals.size, access, readMs: samples(51, 10, read), keyMs: samples(201, 20, key) };
  } finally { copy.destroy(); }
}

for (const size of [30, 300, 900]) for (const edited of [false, true]) console.log(JSON.stringify(storage(size, edited)));
for (const removed of [0, 900, 9000]) {
  const initial = fixture(900 + removed, true);
  for (const keep of [false, true]) {
    const bytes = removed ? cut(initial, keep, 900, removed).fresh : initial;
    console.log(JSON.stringify(time(bytes, keep, removed)));
  }
}
