import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import { fromDocument, toDocument } from "../../proj/document.ts";
import { readDelta } from "../../proj/richtext.ts";
import type { ProjectionDelta } from "../../proj/richtext.ts";
import { serializeProjection } from "../../proj/reference.ts";
import { records } from "../../proj/value.ts";
import type { ProjectionBag } from "../../proj/value.ts";
import { mapValue, textValue } from "../../schema.ts";
import type { SchemaReplica } from "../../schema.ts";
import { PerfBlockIndex } from "../blocks.ts";
import { applyWritingCycle, retainedCounts } from "../history.ts";
import { scalePerfFixture } from "../fixtures.ts";
import { attributeLifetimeBytes } from "./attribution.ts";
import { countLifetimeRemote } from "./probe.ts";
import { LifetimeHistory, lifetimePlan } from "./workload.ts";
import type { LifetimeOperations } from "./workload.ts";

export function lifetimeCharacters(delta: readonly ProjectionDelta[]): number {
  return delta.reduce((sum, item) => sum + (typeof item.insert === "string" ? item.insert.length
    : "w" in item.insert ? 1 + String(item.insert.w).length : "k" in item.insert ? String(item.insert.label ?? "B-roll:").length : 0), 0);
}

export function lifetimeSize(replica: SchemaReplica) {
  const index = new PerfBlockIndex(replica.doc, "B"), active = new Set<string>();
  let finalCharacters = 0;
  for (const span of index.spans) {
    if (span.block.kind !== "b" || mapValue(mapValue(replica.doc.getMap("beats").get(span.block.id)).get("removals")).size) continue;
    active.add(span.block.id); finalCharacters += lifetimeCharacters(span.block.delta);
  }
  for (const value of replica.doc.getMap("visuals").values()) {
    const visual = mapValue(value); if (active.has(String(visual.get("beat")))) finalCharacters += lifetimeCharacters(readDelta(textValue(visual.get("text"))));
  }
  const plain = toDocument(replica.doc, "B"), projectedFileBytes = Buffer.byteLength(serializeProjection(plain));
  const exportedFileBytes = Buffer.byteLength(serializeProjection({ ...plain, rows: records(plain.rows).filter(row => active.has(String(row.id))) }));
  return { finalCharacters, activeBeats: active.size, projectedFileBytes, exportedFileBytes };
}

export function lifetimeTyped(operations: LifetimeOperations): number { return operations.typing + operations.correctionRetypes + operations.revisionTyping; }

function checkpoint(replica: SchemaReplica, snapshot: string, directory: string) {
  const state = Y.encodeStateAsUpdate(replica.doc);
  writeFileSync(join(directory, snapshot), state);
  const bytes = attributeLifetimeBytes(replica);
  assert.equal(bytes.encodedBytes, state.length);
  const legacy = countLifetimeRemote(state, "legacy"), indexed = countLifetimeRemote(state, "indexed");
  assert.ok(indexed.work.capture.relativeItems > 0, "Missing pinned identity-loop instrumentation");
  assert.equal(indexed.work.structure.records.statusEvents ?? 0, 0);
  return { snapshot, sha256: createHash("sha256").update(state).digest("hex"), ...lifetimeSize(replica), bytes, counts: retainedCounts(replica), legacy, indexed };
}

function realistic(writers: number, directory: string, base: ProjectionBag) {
  const history = new LifetimeHistory(writers, base), checkpoints = [];
  let previousStep: { encodedBytes: number; typedCharacters: number } | null = null;
  const cap: { first: { encodedBytes: number; typedCharacters: number; finalCharacters: number; operations: LifetimeOperations; completedBlocks: number; previousStep: { encodedBytes: number; typedCharacters: number } | null } | null } = { first: null };
  history.onStep = () => {
    const encodedBytes = Y.encodeStateAsUpdate(history.master.doc).length, typedCharacters = lifetimeTyped(history.operations);
    if (!cap.first && encodedBytes >= lifetimePlan.capBytes) cap.first = { encodedBytes, typedCharacters, finalCharacters: lifetimeSize(history.master).finalCharacters,
      operations: { ...history.operations }, completedBlocks: history.blocks, previousStep };
    previousStep = { encodedBytes, typedCharacters };
  };
  try {
    while (history.blocks < lifetimePlan.maxBlocks) {
      history.appendBlock();
      const bytes = Y.encodeStateAsUpdate(history.master.doc).length;
      if ([1, 5, 10, 20].includes(history.blocks) || cap.first) {
        const point = checkpoint(history.master, `realistic-${writers}-block-${history.blocks}.bin`, directory);
        checkpoints.push({ blocks: history.blocks, operations: { ...history.operations }, typedCharacters: lifetimeTyped(history.operations), ...point });
      }
      if (cap.first || bytes >= lifetimePlan.capBytes) break;
    }
    assert.ok(cap.first, "Increase the stated horizon: cap was not reached");
    return { writers, firstCap: cap.first, checkpoints };
  } finally { history.destroy(); }
}

function synthetic(directory: string, base: ProjectionBag) {
  const input = scalePerfFixture(base, 10), replica = fromDocument(input, "B", 10), checkpoints = [];
  const ids = records(input.rows).map(row => String(row.id)), comments = records(input.comments).map(comment => String(comment.id));
  let operations = 0;
  try {
    checkpoints.push({ operations, ...checkpoint(replica, "synthetic-0.bin", directory) });
    for (let cycle = 0; cycle < 500; cycle++) {
      operations += applyWritingCycle(replica, cycle, ids[cycle % ids.length] as string, comments[cycle % comments.length] as string);
      if ([99, 249, 499].includes(cycle)) checkpoints.push({ operations, ...checkpoint(replica, `synthetic-${operations}.bin`, directory) });
    }
    return { cycles: 500, checkpoints };
  } finally { replica.destroy(); }
}

function undoRetention(writers: number, base: ProjectionBag) {
  const history = new LifetimeHistory(writers, base, true);
  try {
    history.appendBlock(); history.synchronize();
    const masterBytes = Y.encodeStateAsUpdate(history.master.doc).length;
    return { writers, masterBytes, localWriters: history.writers.map((writer, index) => {
      const manager = history.undo[index]; assert.ok(manager); assert.ok(manager.undoStack.length <= 200);
      return { writer: index + 1, stackEntries: manager.undoStack.length, encodedBytesWhileUndoRetained: Y.encodeStateAsUpdate(writer.doc).length,
        deletionRanges: manager.undoStack.reduce((sum, item) => sum + [...item.deletions.clients.values()].reduce((count, ranges) => count + ranges.length, 0), 0),
        insertionRanges: manager.undoStack.reduce((sum, item) => sum + [...item.insertions.clients.values()].reduce((count, ranges) => count + ranges.length, 0), 0) };
    }) };
  } finally { history.destroy(); }
}

export function collectLifetimeCounts(directory: string, base: ProjectionBag) {
  return { plan: lifetimePlan, realistic: lifetimePlan.writers.map(writers => realistic(writers, directory, base)), synthetic: synthetic(directory, base), undo: lifetimePlan.writers.map(writers => undoRetention(writers, base)) };
}
