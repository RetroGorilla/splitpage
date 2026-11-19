import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import * as Y from "yjs";
import { UndoLayer } from "../native-undo/layer.ts";
import type { NativeReplica } from "../native/variant.ts";
import { loadSizeReplica, readSizeScript, sizeSignature } from "./fixture.ts";
import type { SizeFixture } from "./fixture.ts";

const AUDIO = "audioText";
const SESSION_BURSTS = 2_000;
const KEY_SAMPLES = 11;

function time<T>(run: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
}

function heap(): number {
  assert(global.gc, "Run with --expose-gc");
  global.gc();
  global.gc();
  return process.memoryUsage().heapUsed;
}

function visible(replica: NativeReplica): void { readSizeScript(replica); }

function verify(replica: NativeReplica, fixture: SizeFixture): void {
  assert.deepEqual(sizeSignature(readSizeScript(replica)), fixture.expected);
}

function remoteKeys(state: Uint8Array, beat: string): Uint8Array[] {
  const sender = loadSizeReplica(state, true);
  try {
    sender.doc.clientID = 4;
    visible(sender);
    const at = Math.floor(sender.block(beat).end / 2);
    const updates: Uint8Array[] = [];
    sender.doc.on("update", update => updates.push(update));
    for (let i = 0; i < KEY_SAMPLES; i++) {
      sender.splice(beat, AUDIO, at + i, at + i, [{ text: "R", marks: {} }]);
      sender.changes();
    }
    assert.equal(updates.length, KEY_SAMPLES);
    return updates;
  } finally {
    sender.destroy();
  }
}

function pristineTrial(fixture: SizeFixture, baseline: number) {
  const loaded = time(() => loadSizeReplica(fixture.state));
  const replica = loaded.value;
  try {
    const read = time(() => visible(replica)).ms;
    const retained = heap() - baseline;
    return { apply: loaded.ms, read, load: loaded.ms + read, heap: retained, reencoded: replica.encode().length };
  } finally {
    replica.destroy();
  }
}

function editingTrial(fixture: SizeFixture, updates: Uint8Array[]) {
  const replica = loadSizeReplica(fixture.state, true);
  try {
    let now = 0;
    const layer = new UndoLayer(replica, { now: () => now });
    visible(replica);
    const beat = fixture.middle, offset = Math.floor(replica.block(beat).end / 2);
    const local: number[] = [], remote: number[] = [];
    for (const [index, update] of updates.entries()) {
      now += 120;
      remote.push(time(() => {
        Y.applyUpdate(replica.doc, update, "remote");
        return replica.changes();
      }).ms);
      local.push(time(() => {
        layer.type(beat, AUDIO, offset + index * 2 + 1, "L");
        return replica.changes();
      }).ms);
    }
    const text = replica.block(beat).delta.map(part => part.insert).join("");
    assert.match(text.slice(offset, offset + KEY_SAMPLES * 2), /^(?:RL|LR)+$/);
    const format = time(() => {
      layer.command(() => replica.format(beat, AUDIO, offset, offset + 3, { u: true }));
      return replica.changes();
    });
    assert(format.value.rows.some(row => row.id === beat && row.audio.some(part => part.attributes?.u === true)));
    const split = time(() => {
      layer.command(() => replica.split(beat, offset, "split-sample"));
      return replica.changes();
    });
    assert(split.value.order);
    assert(split.value.rows.some(row => row.id === "split-sample"));
    return { local, remote, split: split.ms, format: format.ms };
  } finally {
    replica.destroy();
  }
}

function longSession(fixture: SizeFixture, baseline: number) {
  const replica = loadSizeReplica(fixture.state, true);
  const started = performance.now();
  try {
    let now = 0;
    const layer = new UndoLayer(replica, { now: () => now });
    const beats = replica.rows().map(row => row.id);
    for (let i = 0; i < SESSION_BURSTS; i++) {
      const beat = beats[i % beats.length];
      assert(beat);
      const block = replica.block(beat);
      const at = Math.floor((block.end - block.start) / 2);
      now += 1_100;
      for (const [offset, char] of [..."take a "].entries()) {
        now += 120;
        layer.type(beat, AUDIO, at + offset, char);
      }
      layer.erase(beat, AUDIO, at + 5, at + 7);
      layer.erase(beat, AUDIO, at - 4, at);
      layer.command(() => replica.format(beat, AUDIO, at - 4, at + 1, { i: i % 2 ? null : true }));
      replica.changes();
    }
    return { heap: heap() - baseline, entries: layer.manager.undoStack.length, seconds: (performance.now() - started) / 1_000 };
  } finally {
    replica.destroy();
  }
}

function reconnect(sender: Y.Doc, prior: Uint8Array, fixture: SizeFixture, check: boolean) {
  const replica = loadSizeReplica(prior);
  try {
    visible(replica);
    const vector = time(() => Y.encodeStateVector(replica.doc));
    const diff = time(() => Y.encodeStateAsUpdate(sender, vector.value));
    const apply = time(() => Y.applyUpdate(replica.doc, diff.value, "remote"));
    if (check) verify(replica, fixture);
    return { vector: vector.ms, vectorBytes: vector.value.length, diff: diff.ms, diffBytes: diff.value.length, apply: apply.ms };
  } finally {
    replica.destroy();
  }
}

function reconnectTrial(fixture: SizeFixture, check: boolean) {
  const sender = new Y.Doc();
  try {
    Y.applyUpdate(sender, fixture.state);
    return {
      day: reconnect(sender, fixture.behind.day, fixture, check),
      month: reconnect(sender, fixture.behind.month, fixture, check),
      history: reconnect(sender, fixture.behind.history, fixture, check)
    };
  } finally {
    sender.destroy();
  }
}

export async function measureSize(fixture: SizeFixture, repeats: number) {
  const start = performance.now();
  await setImmediate();
  const baseline = heap();
  verifyStoredScript(fixture);
  const remote = remoteKeys(fixture.state, fixture.middle);
  const load = [], edits = [], sessions = [], sync = [];
  for (let run = 0; run < repeats; run++) {
    await setImmediate();
    load.push(pristineTrial(fixture, baseline));
    edits.push(editingTrial(fixture, remote));
    await setImmediate();
    sessions.push(longSession(fixture, baseline));
    sync.push(reconnectTrial(fixture, run === 0));
    if (run + 1 < repeats && performance.now() - start > 480_000) {
      throw new Error(`Measurement time limit after ${run + 1} rounds`);
    }
  }
  return { load, edits, sessions, sync, baseline, seconds: (performance.now() - start) / 1_000 };
}

export function verifyStoredScript(fixture: SizeFixture, gc = true): void {
  const replica = loadSizeReplica(fixture.state, false, gc);
  try { verify(replica, fixture); } finally { replica.destroy(); }
}
