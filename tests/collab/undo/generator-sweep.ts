import assert from "node:assert/strict";
import { generateUndoHistory, runUndoHistory } from "./generator.ts";
import type { UndoRun, UndoViolation } from "./generator.ts";
import { undoLimitFor } from "./limits.ts";
import { ADAPTER_WORLD, MODEL_WORLD } from "./scenario.ts";
import type { UndoWorldKind } from "./scenario.ts";

const SEEDS = 300;

export function undeclared(run: UndoRun): UndoViolation[] {
  return run.violations.filter(violation => !undoLimitFor(violation));
}

export function sweep(writers: 2 | 3, kind: UndoWorldKind = MODEL_WORLD): { counts: Record<string, number>; steps: Record<string, number>; limited: Record<string, number[]>; copies: number } {
  const counts: Record<string, number> = {}, steps: Record<string, number> = {}, limited: Record<string, number[]> = {};
  let copies = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const history = generateUndoHistory(seed, writers, 40, kind === ADAPTER_WORLD), run = runUndoHistory(history, kind);
    assert.deepEqual(undeclared(run), [], `writers ${writers} seed ${seed}: ${JSON.stringify(history)}`);
    assert.equal(run.copies.length, history.writers + 1, `writers ${writers} seed ${seed}`);
    for (const copy of run.copies) assert.deepEqual(copy, run.copies[0], `writers ${writers} seed ${seed}`);
    copies += run.copies.length;
    for (const step of history.steps) steps[step.op] = (steps[step.op] ?? 0) + 1;
    for (const [name, value] of Object.entries(run.counts)) counts[name] = (counts[name] ?? 0) + value;
    for (const id of new Set(run.violations.map(violation => undoLimitFor(violation)?.id ?? "undeclared"))) (limited[id] ??= []).push(seed);
  }
  return { counts, steps, limited, copies };
}
