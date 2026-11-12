import type { DeliveryOrder } from "../delivery.ts";
import { runBufferTrace } from "./buffer-cases.ts";
import type { UndoBufferTrace } from "./buffer-cases.ts";
import { runDoubleDelete } from "./cases.ts";
import { ADAPTER_WORLD } from "./scenario.ts";
import type { UndoReplica, UndoWorldKind } from "./scenario.ts";
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

function shownText(replica: UndoReplica): string {
  return replica.snapshot().rows.map(row => row.characters.map(character => character.value).join("")).join("|");
}

export function runPendingUpdate(checked = true): string[] {
  const world = ADAPTER_WORLD.make([{ id: "R1", text: "ab" }], ["A", "B", "C"]), b = world.replica("B"), c = world.replica("C"), held = [shownText(b)];
  b.edit({ at: b.observe("R1", 2, 2), text: "X", command: "paste" });
  held.push(shownText(b));
  b.edit({ at: b.observe("R1", 0, 1), text: "Y", command: "paste" });
  held.push(shownText(b));
  const waiting = world.queue.pending.filter(message => message.to === "C").map(message => message.id);
  world.queue.deliver(waiting[1] ?? "");
  const early = shownText(c);
  world.queue.deliver(waiting[0] ?? "");
  const read = [early, shownText(c)];
  world.queue.flush("D1");
  read.push(...[world.replica("A"), b, c, world.fresh("A")].map(shownText));
  if (checked && !held.includes(early)) throw new Error(`pending-update/C before the earlier update: read ${JSON.stringify(early)}, which no copy ever held`);
  return read;
}

export function runTypedBesideRestored(kind: UndoWorldKind = ADAPTER_WORLD, checked = true): string[] {
  const world = kind.make([{ id: "R1", text: "ab" }]), a = world.replica("A"), b = world.replica("B");
  b.edit({ at: b.observe("R1", 1, 2), command: "cut" });
  b.undo.undo();
  a.edit({ at: a.observe("R1", 2, 2), text: "X", command: "paste" });
  const typed = shownText(a);
  world.queue.flush("D1");
  const read = [typed, ...[a, b, world.fresh("A")].map(shownText)];
  if (checked && read[1] !== typed) throw new Error(`typed-beside-restored/A after delivery: read ${JSON.stringify(read[1])}, having typed X after b`);
  return read;
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
    id: "pending-update", state: "carried",
    title: "A copy given a writer's later update before the earlier one shows the later one's deletions without its insertions",
    history: "R1 ab, three writers. Bob types X at the end, then pastes Y over a. Carol receives the second update first and reads b, a text no copy ever had; when the first arrives she reads YbX.",
    shown: "carried limit pending-update: the literal history fails in the declared way",
    literal: { run: () => runPendingUpdate(), failure: /^pending-update\/C before the earlier update: read "b", which no copy ever held$/ }
  },
  {
    id: "insert-after-deleted-run", state: "carried",
    title: "Text typed at a place inside a run the other writer already deleted sits after the whole run once the deletion is undone",
    history: "R1 abcd, shared document only. Alice deletes bc, delivered. Bob types X where the gap between b and c was. Alice undoes: a b c X d, not a b X c d.",
    shown: "carried limit insert-after-deleted-run: the literal histories fail in the declared way",
    literal: { run: () => runBufferTrace("T01", "late-C", ADAPTER_WORLD), failure: /^T01 late-C undone\/A\.rows\[0\]\.characters\[2\]\.identity\.client: expected 2, got 1$/ }
  },
  {
    id: "typed-beside-restored", state: "carried",
    title: "Text typed directly after a character, while another writer deletes that character and undoes it unseen, can end before the character",
    history: "R1 ab, shared document only. Bob deletes b and undoes, neither delivered. Alice types X after b. Delivered: a X b on every copy, not a b X.",
    shown: "carried limit typed-beside-restored: the literal history fails in the declared way",
    matches: violation => violation.check === "characters arrived in another order than this writer had seen",
    literal: { run: () => runTypedBesideRestored(), failure: /^typed-beside-restored\/A after delivery: read "aXb", having typed X after b$/ }
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
