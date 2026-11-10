import { runDoubleDelete, runJoinTargetRemoved, runLaterFormat, runRedoneMarkReversed, runRedoneRecovery, runRemovedAfterInsert, runRemovedSplit, runSequentialStatus } from "./cases.ts";
import type { CaseResult } from "./cases.ts";
import type { GeneratedHistory, Violation } from "./generator.ts";
import { minimalHistories } from "./limit-histories.ts";

function minimal(id: string): GeneratedHistory {
  const found = minimalHistories[id];
  if (!found) throw new Error(`Missing minimized history ${id}`);
  return found;
}

export type LimitOwner = "undo" | "reader" | "status rule" | "delivery" | "library formatting";

export interface DeclaredLimit {
  id: string;
  title: string;
  owner: LimitOwner;
  matches?: (violation: Violation) => boolean;
  minimal?: GeneratedHistory;
  actOnPending?: boolean;
  literal?: { file: string; run: () => CaseResult; failure: RegExp };
  library?: string;
}

export const declaredLimits: DeclaredLimit[] = [
  {
    id: "double-restore", owner: "undo",
    title: "Concurrent undos of one doubly deleted character restore it twice",
    matches: violation => violation.check === "restored twice",
    literal: { file: "UR-concurrent-double-restore.md", run: () => runDoubleDelete("D1", "Alice", true), failure: /both undone\/client\d+\.rows\[0\]\.characters\[3\]/ },
    library: "double restore"
  },
  {
    id: "later-format", owner: "undo",
    title: "A format undo overwrites the other writer's later formatting of the same characters",
    literal: { file: "UR-later-format.md", run: () => runLaterFormat("D1"), failure: /characters\[1\]\.marks\.b: expected true, got <missing>/ },
    library: "later format"
  },
  {
    id: "redone-recovery", owner: "reader",
    title: "Recovery lists a character undone and redone inside a removed beat as edited after the removal",
    literal: { file: "UR-redone-recovery.md", run: () => runRedoneRecovery("D1"), failure: /edited\[0\]: expected <missing>, got "a1\*"/ },
    library: "redone recovery"
  },
  {
    id: "sequential-status", owner: "status rule",
    title: "A writer's second status undo changes nothing under main's status rule",
    literal: { file: "UR-sequential-status.md", run: () => runSequentialStatus("D2"), failure: /second undo\/client\d+\.rows\[0\]\.status: expected "todo", got "ready"/ },
    library: "sequential status"
  },
  {
    id: "status-redo-conflict", owner: "status rule",
    title: "Redo of a status change that had not applied (a conflict) makes it apply",
    matches: violation => violation.check === "undo then redo changed the model" && /^(Alice|Bob|Carol) status:/.test(violation.detail),
    minimal: minimal("status-redo-conflict")
  },
  {
    id: "redone-mark-reversed", owner: "library formatting",
    title: "A redone tag or comment highlight is lost when the writer's undo and redo updates arrive in reverse",
    literal: { file: "UR-redone-mark-reversed.md", run: () => runRedoneMarkReversed("tag"), failure: /redone\/client\d+\.rows\[0\]\.characters\[0\]\.marks\.tag: expected "P", got <missing>/ },
    library: "redone mark, reversed delivery"
  },
  {
    id: "pending-update", owner: "delivery",
    title: "A replica holding one writer's later update before the earlier one cannot be read until the earlier one arrives",
    matches: violation => violation.check === "threw" && /Cannot read properties of undefined \(reading 'b'\)/.test(violation.detail),
    minimal: minimal("pending-update"), actOnPending: true
  }
];

export const fixedReaderLimits = [
  { id: "join-target", file: "UR-join-target.md", run: runJoinTargetRemoved, minimal: minimal("join-target") },
  { id: "recovery-attribution", file: "UR-recovery-edited.md", run: runRemovedAfterInsert, minimal: minimal("recovery-attribution") },
  { id: "recovery-split-by", file: "UR-recovery-split-by.md", run: runRemovedSplit }
] as const;

export const keptSeeds: readonly { seed: number; writers: 2 | 3; found: string; reaches: string | null }[] = [
  { seed: 2, writers: 2, found: "the reader's join-target error (fixed by #1421)", reaches: null },
  { seed: 3, writers: 3, found: "replicas name different removers (fixed by #1421)", reaches: null },
  { seed: 1685, writers: 3, found: "a status redo after a conflict", reaches: "status-redo-conflict" },
  { seed: 424, writers: 2, found: "an undo threw writing a key on a beat record another writer's undo had deleted (fixed)", reaches: null },
  { seed: 1095, writers: 2, found: "an undo threw retiring a removal on a deleted beat record (fixed)", reaches: null },
  { seed: 1888, writers: 2, found: "a heading-removal redo recreated the beat record without another writer's removal entry (fixed)", reaches: null },
  { seed: 60, writers: 3, found: "a removal redo restored only its own entry (fixed)", reaches: null }
];

export function limitFor(violation: Violation): DeclaredLimit | undefined {
  return declaredLimits.find(limit => limit.matches?.(violation));
}
