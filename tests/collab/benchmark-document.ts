import assert from "node:assert/strict";
import { flowBaseReference } from "../../src/core/collab/base-reference.ts";
import { readOperation } from "../../src/core/collab/read-operation.ts";
import { applySharedUpdate, createSharedDocument, destroySharedDocument, encodeSharedState, encodeSharedStateVector, encodeSharedUpdate, readSharedRevision } from "../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../src/adapters/collab/execute.ts";
import { hydrateSharedDocument } from "../../src/adapters/collab/hydrate.ts";
import { registerSharedRecordHandlers } from "../../src/adapters/collab/record-executor.ts";
import { registerSharedSplitHandlers } from "../../src/adapters/collab/split-executor.ts";
import { collabState } from "../../src/adapters/collab/state.ts";
import { registerSharedTextOperationHandlers } from "../../src/adapters/collab/text-executor.ts";
import type { SharedDocumentHandle } from "../../src/adapters/collab/types.ts";
import { migrateRows } from "../../src/core/migrate.ts";
import { fakeMigration } from "../core/migrate-ports.ts";

export interface BenchmarkDocumentOptions {
  readonly beats: number;
  readonly editedBeats?: number;
  readonly rounds?: number;
  readonly seed?: number;
}

const words = ["the", "camera", "holds", "on", "a", "quiet", "street", "while", "rain", "starts", "and", "nobody", "moves", "until", "morning"];

export function benchmarkRowId(index: number): string { return "R" + index; }

export function registerBenchmarkHandlers(handle: SharedDocumentHandle): void {
  registerSharedTextOperationHandlers(handle); registerSharedSplitHandlers(handle); registerSharedRecordHandlers(handle);
}

export function submitBenchmarkOperations(handle: SharedDocumentHandle, commands: readonly unknown[]): void {
  const operations = commands.map(command => { const operation = readOperation(command); assert.ok(operation); return operation; });
  assert.deepEqual(executeSharedOperations(handle, operations, { base: readSharedRevision(handle) }), { ok: true });
}

export function typeBenchmarkCharacter(handle: SharedDocumentHandle, row: string, offset: number, value: string, id: string): void {
  submitBenchmarkOperations(handle, [{ kind: "text-insert", id, by: "Writer", target: { owner: row, segment: "b:" + row, field: "audioText" },
    at: { left: null, right: flowBaseReference(row, "audioText", offset), affinity: "before" }, content: [{ value, marks: [] }] }]);
}

// why: one deterministic edited script serves the read counters and the coordinator's timing runs; nothing in it reads a clock.
export function buildBenchmarkDocument(options: BenchmarkDocumentOptions) {
  const rounds = options.rounds ?? 8, edited = Math.min(options.editedBeats ?? options.beats, options.beats);
  let state = options.seed ?? 0x5eed6c;
  const pick = (limit: number): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return limit > 0 ? state % limit : 0; };
  const lengths: number[] = [];
  const rows = Array.from({ length: options.beats }, (_, index) => {
    const plain = Array.from({ length: 12 + index % 9 }, (__, word) => words[(index * 7 + word * 3) % words.length]).join(" ");
    const cut = 4 + index % 11;
    lengths.push(plain.length + 1);
    return { id: benchmarkRowId(index), status: "todo", lengthSeconds: 3 + index % 5, visualText: index % 4 ? "" : "Wide shot " + index,
      audioText: plain.slice(0, cut) + "<strong>" + plain.slice(cut, cut + 6) + "</strong>" + plain.slice(cut + 6) + "." };
  });
  const sections = rows.filter((_, index) => index % 10 === 0).map((row, index) => ({ id: "H" + index, name: "Scene " + (index + 1), firstSceneId: row.id }));
  const a = createSharedDocument(), b = createSharedDocument();
  collabState(a).doc.clientID = 1; collabState(b).doc.clientID = 2;
  hydrateSharedDocument(a, migrateRows({ schema: 2, docId: "d00000000000000000000000000000000", title: "Benchmark", rows, sections,
    people: [{ id: "P1", name: "Ada" }, { id: "P2", name: "Bo" }], productionTags: [{ id: "t_1", cat: "prop", name: "Umbrella", status: "needed" }],
    brollShots: [{ id: "S1", name: "Street", status: "unshot", origin: "list" }] }, fakeMigration().ports));
  assert.ok(applySharedUpdate(b, encodeSharedState(a)).ok);
  for (const handle of [a, b]) registerBenchmarkHandlers(handle);
  const exchange = (): void => {
    const toB = encodeSharedUpdate(a, encodeSharedStateVector(b)), toA = encodeSharedUpdate(b, encodeSharedStateVector(a));
    assert.ok(applySharedUpdate(b, toB).ok); assert.ok(applySharedUpdate(a, toA).ok);
  };
  let commands = 0;
  for (let round = 0; round < rounds; round++) {
    for (let index = 0; index < edited; index++) {
      const handle = (index + round) % 2 ? b : a, row = benchmarkRowId(index), length = lengths[index] ?? 0, id = `r${round}-${index}`;
      const from = pick(length), to = Math.min(length, from + 1 + pick(12));
      typeBenchmarkCharacter(handle, row, pick(length + 1), String.fromCharCode(97 + pick(26)), "type-" + id);
      submitBenchmarkOperations(handle, [{ kind: "mark", id: "mark-" + id, by: "Writer", target: { owner: row, segment: "b:" + row, field: "audioText" },
        observed: [flowBaseReference(row, "audioText", from, to)], mark: { kind: round % 2 ? "i" : "b", value: true } }]);
      commands += 2;
    }
    exchange();
    for (let index = round; round < 5 && index < edited; index += 5) {
      const handle = (index + round) % 2 ? b : a, row = benchmarkRowId(index);
      submitBenchmarkOperations(handle, [{ kind: "status", id: `status-${round}-${index}`, by: "Writer", target: { scope: "beat", record: row },
        value: round % 2 ? "ready" : "shot", parents: [] }]);
      commands++;
    }
    for (let index = 0; index < lengths.length && index < edited; index++) lengths[index] = (lengths[index] ?? 0) + 1;
    exchange();
  }
  return { a, b, commands, rowLength: (index: number): number => lengths[index] ?? 0, exchange, close: (): void => { destroySharedDocument(a); destroySharedDocument(b); } };
}
