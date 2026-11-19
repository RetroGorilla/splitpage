import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { build } from "./measure.ts";
import type { Layout } from "./measure.ts";
import { MOVE_DESIGNS, MoveReplica } from "./ranks.ts";
import type { MoveDesign, RankDrop } from "./ranks.ts";
import { UndoLayer } from "../native-undo/layer.ts";

function load(bytes: Uint8Array, design: MoveDesign, client: number): MoveReplica {
  const replica = new MoveReplica(client, design);
  Y.applyUpdate(replica.doc, bytes, "remote");
  return replica;
}

function start(bytes: Uint8Array, design: MoveDesign): { replica: MoveReplica; layer: UndoLayer } {
  const replica = load(bytes, design, 10);
  replica.initializeRanks();
  replica.changes();
  const layer = new UndoLayer(replica);
  layer.manager.addToScope(replica.headings);
  return { replica, layer };
}

function storage(replica: MoveReplica): number {
  const fresh = load(replica.encode(), replica.design, 11);
  const length = fresh.encode().length;
  fresh.destroy();
  return length;
}

const WARMUP = 12;

function percentile(values: number[], fraction: number): number {
  const result = values.toSorted((a, b) => a - b)[Math.floor(values.length * fraction)];
  assert.ok(result !== undefined);
  return result;
}

function time(samples: number, job: (index: number) => void): string {
  const values: number[] = [];
  for (let i = 0; i < WARMUP + samples; i++) {
    const before = performance.now();
    job(i);
    if (i >= WARMUP) values.push(performance.now() - before);
  }
  return `${percentile(values, 0.5).toFixed(3)} / ${percentile(values, 0.95).toFixed(3)}`;
}

function schedule(beats: number, count: number, seed: number): { moves: RankDrop[]; order: string[] } {
  const order = Array.from({ length: beats }, (_, i) => `B${i}`);
  const choose = (limit: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor(seed * limit / 0x100000000);
  };
  const moves: RankDrop[] = [];
  while (moves.length < count) {
    const from = choose(beats - 1), to = choose(beats - 1);
    if (from === to || from === to + 1) continue;
    const first = order[from], target = order[to];
    assert.ok(first && target);
    moves.push({ unit: "row", first, target, after: true });
    order.splice(from, 1);
    order.splice(order.indexOf(target) + 1, 0, first);
  }
  return { moves, order };
}

function go(replica: MoveReplica, layer: UndoLayer, drop: RankDrop): void {
  layer.command(() => { assert.ok(replica.drop(drop), JSON.stringify(drop)); });
  replica.changes();
}

function close(replica: MoveReplica, layer: UndoLayer): void {
  layer.manager.destroy();
  replica.destroy();
}

function transmission(bytes: Uint8Array, design: MoveDesign, drop: RankDrop): number {
  const { replica, layer } = start(bytes, design);
  let written = 0;
  replica.doc.on("update", (update: Uint8Array) => { written += update.length; });
  go(replica, layer, drop);
  close(replica, layer);
  return written;
}

function lifetime(bytes: Uint8Array, design: MoveDesign) {
  const { replica, layer } = start(bytes, design), initial = storage(replica);
  const { moves, order } = schedule(300, 1000, 17);
  let written = 0;
  replica.doc.on("update", (update: Uint8Array) => { written += update.length; });
  for (const drop of moves) go(replica, layer, drop);
  assert.deepEqual(replica.rows().map(row => row.id), order);
  const stored = storage(replica);
  close(replica, layer);
  return { initial, avgUpdate: Number((written / moves.length).toFixed(2)), keptPerMove: Number(((stored - initial) / 1000).toFixed(2)),
    extraBytesPerCharacter: Number(((stored - bytes.length) / (300 * 84)).toFixed(3)) };
}

function timedMove(replica: MoveReplica, layer: UndoLayer, drop: RankDrop) {
  const original = replica.transact;
  let depth = 0, transaction = 0;
  replica.transact = function (change): void {
    const start = performance.now(), outer = depth++ === 0;
    let callbackTime = 0;
    try {
      original.call(replica, () => {
        const entered = performance.now();
        change();
        callbackTime = performance.now() - entered;
      });
    } finally {
      depth--;
      // why: the outer undo transaction encloses planning, so only its overhead belongs with the inner writes.
      transaction += performance.now() - start - (outer ? callbackTime : 0);
    }
  };
  const start = performance.now();
  try {
    layer.command(() => { assert.ok(replica.drop(drop)); });
  } finally {
    replica.transact = original;
  }
  const rebuildStart = performance.now(), planning = rebuildStart - start - transaction;
  replica.changes();
  const rebuild = performance.now() - rebuildStart;
  return { transaction, planning, rebuild, share: 100 * rebuild / (rebuild + planning + transaction) };
}

function scale(beats: number, bytes: Uint8Array, design: MoveDesign, samples: number) {
  const { replica, layer } = start(bytes, design), { moves, order } = schedule(beats, Math.floor(beats / 3) + samples + WARMUP, 57);
  const warm = Math.floor(beats / 3);
  try {
    for (const drop of moves.slice(0, warm)) go(replica, layer, drop);
    const read = time(samples, () => {
      replica.blocks();
    });
    const moved = new Set(moves.map(drop => drop.first));
    const parts: ReturnType<typeof timedMove>[] = [];
    const move = time(samples, index => {
      const drop = moves[warm + index];
      assert.ok(drop);
      if (beats !== 900) go(replica, layer, drop);
      else {
        const sample = timedMove(replica, layer, drop);
        if (index >= WARMUP) parts.push(sample);
      }
    });
    assert.deepEqual(replica.rows().map(row => row.id), order);
    const movedId = moves[0]?.first, still = `B${beats - 1}`;
    assert.ok(movedId);
    assert.ok(!moved.has(still));
    const char = (id: string) => time(samples * 2, () => {
      layer.type(id, "audioText", 1, "x");
      replica.changes();
    });
    const moveParts = beats === 900 ? {
      transaction: percentile(parts.map(part => part.transaction), 0.5).toFixed(3),
      planning: percentile(parts.map(part => part.planning), 0.5).toFixed(3),
      rebuild: percentile(parts.map(part => part.rebuild), 0.5).toFixed(3),
      rebuildShare: percentile(parts.map(part => part.share), 0.5).toFixed(1)
    } : undefined;
    return { beats, read, move, moveParts, moved: char(movedId), unmoved: char(still) };
  } finally { close(replica, layer); }
}

export function measureE10(samples = 60): void {
  for (const layout of ["scene", "own"] as Layout[]) {
    const bytes = build(300, layout);
    for (const design of MOVE_DESIGNS) {
      const update = [
        { unit: "row", first: "B153", target: "B23", after: true },
        { unit: "rows", first: "B153", last: "B157", target: "B23", after: true },
        { unit: "scene", first: "H15", target: "H2", after: false }
      ] as const;
      process.stdout.write(JSON.stringify({ layout, design, update: update.map(drop => transmission(bytes, design, drop)),
        ...lifetime(bytes, design), scale: [30, 300, 900].map(beats => scale(beats, build(beats, layout), design, samples)) }) + "\n");
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) measureE10();
