import type { DeliveryOrder } from "../delivery.ts";
import { runBufferTrace } from "./buffer-cases.ts";
import type { UndoBufferTrace } from "./buffer-cases.ts";
import { runDoubleDelete } from "./cases.ts";
import { ADAPTER_WORLD } from "./scenario.ts";
import type { UndoViolation } from "./generator.ts";

export interface UndoLimit {
  readonly id: string;
  readonly title: string;
  readonly state: "carried" | "resolved" | "waits";
  readonly history: string;
  readonly shown: string;
  readonly matches?: (violation: UndoViolation) => boolean;
  readonly literal?: { readonly run: () => unknown; readonly failure: RegExp };
}

export const undoLimits: readonly UndoLimit[] = [
  {
    id: "double-restore", state: "carried",
    title: "Two restorations of one deleted character made without seeing each other both appear",
    history: "R1 abcd. Alice deletes bc and Bob deletes c, both delivered. Alice undoes and Bob undoes before either undo arrives: c is there twice.",
    shown: "carried limit double-restore: the literal history fails in the declared way",
    matches: violation => violation.check === "restored twice",
    literal: { run: () => runDoubleDelete("D1", "Alice", true), failure: /^both undone\/A\.rows\[0\]\.characters\[3\]/ }
  },
  {
    id: "later-format", state: "resolved",
    title: "A format undo overwrote the other writer's later formatting of the same characters",
    history: "R1 abcd. Alice bolds ab. Bob unbolds bc, then bolds bc. Alice undoes: only a loses bold.",
    shown: "Stage 1 record fixture, former limit later-format: a format undo leaves the other writer's later formatting"
  },
  {
    id: "sequential-status", state: "resolved",
    title: "A writer's second status undo changed nothing",
    history: "R1 todo. Alice sets ready, then shot. Alice undoes twice: ready, then todo.",
    shown: "Stage 1 record fixture, former limit sequential-status: a writer's second status undo reaches the first value"
  },
  {
    id: "status-redo-conflict", state: "resolved",
    title: "Redo of a status change that had lost a conflict made it apply",
    history: "R1 todo. Alice sets ready while Bob sets shot: todo. Alice undoes: used up, nothing written. Alice redoes: nothing to redo.",
    shown: "Stage 1 record fixture, former limit status-redo-conflict: the undo of a status that lost a conflict is used up, so nothing is left to redo"
  },
  {
    id: "redone-recovery", state: "waits",
    title: "Recovery lists a character undone and redone inside a removed beat as edited after the removal",
    history: "R2 cd. Alice inserts x. Bob removes R2. Alice undoes and redoes. Needs removal, which the owner refuses by name until its executor lands.",
    shown: "not yet: undo of remove is refused by name, asks the executor nothing and keeps the stack"
  },
  {
    id: "redone-mark-reversed", state: "resolved",
    title: "A redone tag was lost when the writer's undo and redo updates arrived in reverse",
    history: "R1 ab. Alice tags ab while Bob bolds a. Alice undoes and redoes; her two updates arrive in reverse. Marks are records of the adapter, not formatting of the library: the tag stays.",
    shown: "former limit redone-mark-reversed: a redone tag stays when the writer's undo and redo arrive in reverse"
  },
  {
    id: "pending-update", state: "resolved",
    title: "A copy holding a writer's later update before the earlier one could not be read until the earlier one arrived",
    history: "Three writers; one writer's second update is delivered to a copy before the first. The copy reads as it was, takes commands, and reads both once the earlier one arrives.",
    shown: "former limit pending-update: a copy given a writer's later update first reads as it was, and reads both once the earlier one arrives"
  },
  {
    id: "insert-after-deleted-run", state: "carried",
    title: "Text typed at a place inside a run the other writer already deleted sits after the whole run once the deletion is undone",
    history: "R1 abcd, shared document only. Alice deletes bc, delivered. Bob types X where the gap between b and c was. Alice undoes: a b c X d, not a b X c d.",
    shown: "carried limit insert-after-deleted-run: the literal histories fail in the declared way",
    literal: { run: () => runBufferTrace("T01", "late-C", ADAPTER_WORLD), failure: /^T01 late-C undone\/A\.rows\[0\]\.characters\[2\]\.identity\.client: expected 2, got 1$/ }
  }
];

export const ADAPTER_BUFFER_LIMIT_RUNS: readonly { readonly trace: UndoBufferTrace; readonly order: DeliveryOrder }[] = [
  { trace: "T01", order: "late-C" },
  { trace: "T01 composition", order: "late-C" }
];

export function undoLimitFor(violation: UndoViolation): UndoLimit | undefined {
  return undoLimits.find(limit => limit.state === "carried" && limit.matches?.(violation));
}

export const keptUndoSeeds: readonly { readonly seed: number; readonly writers: 2 | 3; readonly reaches: string }[] = [
  { seed: 23, writers: 2, reaches: "double-restore" },
  { seed: 57, writers: 2, reaches: "double-restore" },
  { seed: 22, writers: 3, reaches: "double-restore" },
  { seed: 28, writers: 3, reaches: "double-restore" }
];
