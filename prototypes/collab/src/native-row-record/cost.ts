import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import * as Y from "yjs";
import { ChosenReplica } from "../native-chosen/replica.ts";
import { KeptReplica } from "../native-kept/replica.ts";
import { KeptCreationReplica, ReadRuleReplica } from "./variants.ts";

class KMeter extends KeptReplica { rebuild(): number { this.forgetViews(); return this.outline().length; } }
class RMeter extends ReadRuleReplica { rebuild(): number { this.forgetViews(); return this.outline().length; } }
class UMeter extends KeptCreationReplica { rebuild(): number { this.forgetViews(); return this.outline().length; } }
type Meter = KMeter | RMeter | UMeter;
const METERS = { K: (client: number) => new KMeter(client), R: (client: number) => new RMeter(client), U: (client: number) => new UMeter(client) };
type Option = keyof typeof METERS;

// why: E14's fixture: 30 beats per segment, 120 narration and 48 visual characters per beat, a status and a rank
function fixture(size: number): Uint8Array {
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
        const record = new Y.Map<unknown>(), visual = new Y.Text();
        replica.beats.set(id, record);
        replica.visuals.set(id, visual);
        record.set("status", "ready");
        visual.insert(0, "v".repeat(48), {});
      }
      replica.initializeRanks();
    }, "hydration");
    return replica.encode();
  } finally { replica.destroy(); }
}

function load(bytes: Uint8Array, option: Option, client = 2): Meter {
  const replica = METERS[option](client);
  Y.applyUpdate(replica.doc, bytes, "remote");
  replica.changes();
  return replica;
}

// why: one writer creates a row and takes the creation back, `count` times; a fresh copy's encoding is what every later
// copy stores, and the update sizes are what each press sends
function creationUndo(bytes: Uint8Array, option: Option, count: number, kind: "split" | "insert") {
  const editor = load(bytes, option), sent = { create: 0, undo: 0 };
  let last = 0;
  editor.doc.on("update", (update: Uint8Array) => { last += update.byteLength; });
  try {
    for (let index = 0; index < count; index++) {
      const target = `B${(index * 7) % 900}`, id = `N${index}`;
      last = 0;
      if (kind === "split") editor.split(target, 60, id, { status: "todo" }); else editor.insertBeat(target, id, "new", { status: "todo" });
      editor.changes();
      sent.create += last;
      last = 0;
      assert.equal(editor.undoPress(), true);
      editor.changes();
      sent.undo += last;
    }
    const fresh = load(editor.encode(), option, 3);
    try {
      return { option, kind, count, fresh: fresh.encode().byteLength, kept: [...fresh.beats.keys()].filter(id => id.startsWith("N")).length, sentPerCreate: sent.create / count, sentPerUndo: sent.undo / count };
    } finally { fresh.destroy(); }
  } finally { editor.destroy(); }
}

function median(values: number[]): number {
  const middle = values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  assert.ok(middle !== undefined);
  return +middle.toFixed(4);
}

function samples(n: number, warmup: number, run: () => unknown): number {
  const values: number[] = [];
  for (let i = 0; i < n + warmup; i++) {
    const start = performance.now();
    run();
    if (i >= warmup) values.push(performance.now() - start);
  }
  return median(values);
}

function time(bytes: Uint8Array, option: Option) {
  const copy = load(bytes, option);
  try {
    let next = 0;
    const read = (): number => copy.rebuild();
    const key = (): void => { copy.splice("B451", "audioText", 5, 5, [{ text: "k", marks: {} }]); copy.changes(); };
    const splitAndUndo = (): void => { copy.split(`B${(next * 7) % 900}`, 60, `T${next++}`, {}); copy.changes(); copy.undoPress(); copy.changes(); };
    assert.equal(read(), 900);
    return { option, readMs: samples(51, 10, read), keyMs: samples(201, 20, key), splitAndUndoMs: samples(51, 10, splitAndUndo) };
  } finally { copy.destroy(); }
}

const bytes = fixture(900);
for (const kind of ["split", "insert"] as const) for (const option of ["K", "R", "U"] as const) console.log(JSON.stringify(creationUndo(bytes, option, 300, kind)));
for (let pass = 0; pass < 3; pass++) for (const option of ["K", "R", "U"] as const) console.log(JSON.stringify({ pass, ...time(bytes, option) }));
