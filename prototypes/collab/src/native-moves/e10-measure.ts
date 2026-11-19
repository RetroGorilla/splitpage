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

function time(samples: number, job: (index: number) => void): string {
  const warmup = 12, values: number[] = [];
  for (let i = 0; i < warmup + samples; i++) {
    const before = performance.now();
    job(i);
    if (i >= warmup) values.push(performance.now() - before);
  }
  values.sort((a, b) => a - b);
  const median = values[Math.floor(samples / 2)], p95 = values[Math.floor(samples * 0.95)];
  assert.ok(median !== undefined && p95 !== undefined);
  return `${median.toFixed(3)} / ${p95.toFixed(3)}`;
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

function lifetime(bytes: Uint8Array, design: MoveDesign): { initial: number; keptPerMove: number; extraBytesPerCharacter: number } {
  const { replica, layer } = start(bytes, design), initial = storage(replica);
  const { moves, order } = schedule(300, 1000, 17);
  for (const drop of moves) go(replica, layer, drop);
  assert.deepEqual(replica.rows().map(row => row.id), order);
  const stored = storage(replica);
  close(replica, layer);
  return { initial, keptPerMove: Number(((stored - initial) / 1000).toFixed(2)),
    extraBytesPerCharacter: Number(((stored - bytes.length) / (300 * 84)).toFixed(3)) };
}

function scale(beats: number, bytes: Uint8Array, design: MoveDesign, samples: number) {
  const { replica, layer } = start(bytes, design), { moves, order } = schedule(beats, Math.floor(beats / 3) + samples + 12, 57);
  const warm = Math.floor(beats / 3);
  try {
    for (const drop of moves.slice(0, warm)) go(replica, layer, drop);
    const read = time(samples, () => {
      replica.blocks();
    });
    const moved = new Set(moves.map(drop => drop.first));
    const move = time(samples, index => {
      const drop = moves[warm + index];
      assert.ok(drop);
      go(replica, layer, drop);
    });
    assert.deepEqual(replica.rows().map(row => row.id), order);
    const movedId = moves[0]?.first, still = `B${beats - 1}`;
    assert.ok(movedId);
    assert.ok(!moved.has(still));
    const char = (id: string) => time(samples * 2, () => {
      layer.type(id, "audioText", 1, "x");
      replica.changes();
    });
    return { beats, read, move, moved: char(movedId), unmoved: char(still) };
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
