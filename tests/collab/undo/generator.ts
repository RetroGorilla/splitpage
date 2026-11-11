import type { SharedContentRef, SharedMarkValue } from "../../../src/core/collab/operations.ts";
import type { ReplicaName } from "../delivery.ts";
import { ModelWorld } from "./model-world.ts";
import type { ModelReplica, ModelSnapshot } from "./model-world.ts";

export const UNDO_COMMANDS = ["insert", "type", "delete", "replace", "bold", "unbold", "tag", "untag", "status", "scalar"] as const;
export const UNDO_REVERSALS = ["undo", "redo", "undo-redo"] as const;
export const UNDO_DELIVERIES = ["deliver", "deliver-dup", "deliver-rev"] as const;
export type UndoStepKind = typeof UNDO_COMMANDS[number] | typeof UNDO_REVERSALS[number] | typeof UNDO_DELIVERIES[number] | "join";

export interface UndoStep { op: UndoStepKind; writer: number; r: readonly [number, number, number] }
export interface UndoHistory { writers: 2 | 3; steps: UndoStep[] }
export interface UndoViolation { check: string; detail: string; step: number }
export interface UndoRun { violations: UndoViolation[]; counts: Record<string, number>; copies: ModelSnapshot[] }

const NAMES: readonly ReplicaName[] = ["A", "B", "C"];
const SEED = [{ id: "R1", text: "abcdef" }, { id: "R2", text: "ghij" }];
const MARKS: Record<"bold" | "unbold" | "tag" | "untag", SharedMarkValue> = {
  bold: { kind: "b", value: true }, unbold: { kind: "b", value: null },
  tag: { kind: "tag", id: "P" as SharedContentRef, value: "P" as SharedContentRef }, untag: { kind: "tag", id: "P" as SharedContentRef, value: null }
};
const MARK_KEYS = { bold: "b:true", unbold: "b:true", tag: "tag:P", untag: "tag:P" } as const;
const STATUSES = ["todo", "ready", "shot"] as const;
const WEIGHTED: readonly UndoStepKind[] = [
  ...UNDO_COMMANDS, "insert", "delete", "type", "bold", "status", "undo", "undo", "undo", "undo", "redo", "redo", "undo-redo", "undo-redo",
  "deliver", "deliver", "deliver", "deliver", "deliver-dup", "deliver-rev"
];

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = state + 0x6D2B79F5 >>> 0;
    let mixed = Math.imul(state ^ state >>> 15, 1 | state);
    mixed = mixed + Math.imul(mixed ^ mixed >>> 7, 61 | mixed) ^ mixed;
    return ((mixed ^ mixed >>> 14) >>> 0) / 4294967296;
  };
}

function pick<T>(items: readonly T[], r: number): T {
  if (!items.length) throw new Error("Nothing to pick from");
  return items[Math.min(items.length - 1, Math.floor(r * items.length))] as T;
}

export function generateUndoHistory(seed: number, writers: 2 | 3, length = 40): UndoHistory {
  const next = random(seed * 2 + writers), three = (): [number, number, number] => [next(), next(), next()].map(value => Math.floor(value * 1000) / 1000) as [number, number, number];
  const steps: UndoStep[] = [];
  for (let index = 0; index < length; index++) {
    const previous = steps.at(-1);
    // why: identical changes by two writers are rare by chance, and they are what an undo that is used up comes from.
    if (previous && (UNDO_COMMANDS as readonly string[]).includes(previous.op) && next() < 0.15) steps.push({ ...previous, writer: (previous.writer + 1) % writers });
    else steps.push({ op: pick(WEIGHTED, next()), writer: Math.floor(next() * writers), r: three() });
  }
  if (writers === 3 && next() < 0.5) steps.splice(Math.floor(next() * length), 0, { op: "join", writer: 2, r: three() });
  return { writers, steps };
}

interface Ledger { characters: Set<string>; marks: { mark: string; ends: string[] }[]; statuses: Set<string>; scalars: Set<string> }

function multiset(items: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

function comparable(snapshot: ModelSnapshot): unknown {
  return snapshot.rows.map(row => ({ ...row, characters: row.characters.map(({ root, value, marks }) => ({ root, value, marks })) }));
}

export function runUndoHistory(history: UndoHistory): UndoRun {
  const late = history.steps.some(step => step.op === "join");
  const world = new ModelWorld(SEED, late ? ["A", "B"] : NAMES.slice(0, history.writers));
  const violations: UndoViolation[] = [], counts: Record<string, number> = {};
  const ledgers = new Map(NAMES.map((name): [ReplicaName, Ledger] => [name, { characters: new Set(), marks: [], statuses: new Set(), scalars: new Set() }]));
  const count = (name: string): void => { counts[name] = (counts[name] ?? 0) + 1; };
  let at = 0;
  const violate = (check: string, detail: string): void => { violations.push({ check, detail, step: at }); };

  const foreign = (name: ReplicaName, replica: ModelReplica, before: ModelSnapshot, after: ModelSnapshot): void => {
    const ledger = ledgers.get(name), place = replica.view.position;
    if (!ledger) throw new Error("No ledger for " + name);
    // why: a mark reaches every character inside the range it was given, also one typed there at the same moment.
    const inside = (character: { id: string; root: string }, mark: string): boolean => ledger.marks.some(range => {
      const ends = range.ends.flatMap(id => place.get(id) ?? []), from = Math.min(...ends), to = Math.max(...ends);
      return range.mark === mark && [character.id, character.root].some(id => { const spot = place.get(id); return spot !== undefined && from <= spot && spot <= to; });
    });
    before.rows.forEach((row, index) => {
      const next = after.rows[index];
      if (!next) throw new Error("A row disappeared");
      const was = multiset(row.characters.map(character => character.root)), is = multiset(next.characters.map(character => character.root));
      for (const [root, held] of was) if ((is.get(root) ?? 0) < held && !ledger.characters.has(root)) violate("removed another writer's character", `${name} ${row.id} ${root}`);
      for (const [root, held] of is) if ((was.get(root) ?? 0) < held && !ledger.characters.has(root)) violate("resurrected another writer's character", `${name} ${row.id} ${root}`);
      // why: the declared limit is two restorations unseen by each other; one made beside a visible copy is a defect.
      for (const [root, held] of is) if (held > 1 && (was.get(root) ?? 0) < held) violate("restored a character that was already back", `${name} ${row.id} ${root}`);
      for (const character of row.characters) {
        const other = next.characters.find(candidate => candidate.root === character.root);
        // why: a character restored twice is the declared limit double-restore; its two copies cannot be told apart by origin.
        if (!other || was.get(character.root) !== 1 || is.get(character.root) !== 1) continue;
        for (const mark of new Set([...character.marks, ...other.marks])) {
          if (character.marks.includes(mark) !== other.marks.includes(mark) && !inside(other, mark)) violate("changed another writer's formatting", `${name} ${row.id} ${character.root} ${mark}`);
        }
      }
      if (row.status !== next.status && !ledger.statuses.has(row.id)) violate("changed another writer's status", `${name} ${row.id}`);
      for (const field of new Set([...Object.keys(row.scalars), ...Object.keys(next.scalars)])) {
        if (row.scalars[field] !== next.scalars[field] && !ledger.scalars.has(row.id + "|" + field)) violate("changed another writer's field", `${name} ${row.id} ${field}`);
      }
    });
  };

  const reverse = (name: ReplicaName, replica: ModelReplica, direction: "undo" | "redo"): boolean => {
    const before = replica.snapshot(), sizes = replica.undo.sizes(), written = replica.written.length, other = direction === "undo" ? "redo" : "undo";
    const outcome = replica.undo[direction]();
    const now = replica.undo.sizes();
    if (!outcome.ok) {
      if ("reason" in outcome) violate("refused", `${name} ${direction}: ${outcome.reason}`);
      else count("empty " + direction);
      if (now.undo !== sizes.undo || now.redo !== sizes.redo || replica.written.length !== written) violate("a refused or empty reversal changed something", `${name} ${direction}`);
      return false;
    }
    if (now[direction] !== sizes[direction] - 1) violate("a reversal did not use up exactly its entry", `${name} ${direction}`);
    if (!outcome.effective) {
      count("used up " + direction);
      if (now[other] !== sizes[other] || replica.written.length !== written) violate("a used-up reversal wrote or kept something", `${name} ${direction}`);
      if (JSON.stringify(comparable(before)) !== JSON.stringify(comparable(replica.snapshot()))) violate("a used-up reversal changed the model", `${name} ${direction}`);
      return false;
    }
    count("effective " + direction);
    if (now[other] !== sizes[other] + 1) violate("an effective reversal left no way back", `${name} ${direction}`);
    if (replica.written.length !== written + 1) violate("an effective reversal did not write exactly one update", `${name} ${direction}`);
    foreign(name, replica, before, replica.snapshot());
    return true;
  };

  const command = (name: ReplicaName, replica: ModelReplica, step: UndoStep): void => {
    const ledger = ledgers.get(name);
    if (!ledger) throw new Error("No ledger for " + name);
    const [r0, r1, r2] = step.r, beat = pick(world.beats, r0), length = replica.view.visible(beat).length;
    const from = Math.floor(r1 * (length + 1)), start = Math.min(Math.max(0, length - 1), Math.floor(r1 * length));
    const range = replica.observe(beat, start, Math.min(length, start + 1 + Math.floor(r2 * 3)));
    const sizes = replica.undo.sizes(), serial = replica.undo.serial();
    const roots = (): void => { for (const id of range.ids) ledger.characters.add(replica.view.root(id)); };
    const typed = (text: string, removing: boolean): void => {
      if (removing) roots();
      for (const id of replica.edit({ at: removing ? range : replica.observe(beat, from, from), text, ...(removing ? { command: "paste" } : {}) })) ledger.characters.add(id);
    };
    switch (step.op) {
      case "insert": typed(pick(["x", "yz", "w"], r2), false); break;
      case "replace": typed(pick(["q", "uv"], r2), true); break;
      case "delete": roots(); replica.edit({ at: range }); break;
      case "type": {
        for (const [index, value] of ["k", "l", "m"].entries()) {
          replica.typing = index > 0;
          for (const id of replica.edit({ at: replica.observe(beat, from + index, from + index), text: value })) ledger.characters.add(id);
        }
        replica.typing = false;
        if (replica.undo.sizes().undo !== Math.min(200, sizes.undo + 1)) violate("typing did not form one entry", `${name} ${beat}`);
        break;
      }
      case "bold": case "unbold": case "tag": case "untag":
        if (range.ids.length) ledger.marks.push({ mark: MARK_KEYS[step.op], ends: [range.ids[0] ?? "", range.ids.at(-1) ?? ""].flatMap(id => [id, replica.view.root(id)]) });
        replica.mark(range, MARKS[step.op]);
        break;
      case "status": ledger.statuses.add(beat); replica.status(beat, pick(STATUSES, r1)); break;
      case "scalar": ledger.scalars.add(beat + "|lengthSeconds"); replica.scalar(beat, "lengthSeconds", pick([1, 2, null], r1) ?? undefined); break;
      default: throw new Error("Not a command: " + step.op);
    }
    count(replica.undo.serial() === serial ? "command changed nothing" : "command");
    if (replica.undo.serial() !== serial && replica.undo.sizes().redo !== 0) violate("a command kept the redo stack", name);
  };

  const deliver = (step: UndoStep): void => {
    const pending = world.queue.pending;
    if (!pending.length) { count("nothing to deliver"); return; }
    const chosen = pick(pending, step.r[0]), receiver = world.replica(chosen.to), sizes = JSON.stringify([receiver.undo.sizes(), receiver.undo.serial()]);
    if (step.op === "deliver-rev") for (const message of pending.filter(candidate => candidate.to === chosen.to).reverse()) world.queue.deliver(message.id);
    else world.queue.deliver(chosen.id, step.op === "deliver-dup" ? 2 : 1);
    count(step.op);
    if (JSON.stringify([receiver.undo.sizes(), receiver.undo.serial()]) !== sizes) violate("a delivery changed the receiver's stacks", chosen.to);
  };

  for (const [index, step] of history.steps.entries()) {
    at = index;
    const name = NAMES[step.writer] ?? "A", replica = world.replicas.get(name);
    try {
      if (step.op === "join") { world.join("C", pick(["A", "B"] as const, step.r[0])); count("join"); }
      else if ((UNDO_DELIVERIES as readonly string[]).includes(step.op)) deliver(step);
      else if (!replica) count("skipped before joining");
      else if (step.op === "undo" || step.op === "redo") reverse(name, replica, step.op);
      else if (step.op === "undo-redo") {
        const before = JSON.stringify(comparable(replica.snapshot()));
        if (reverse(name, replica, "undo")) {
          reverse(name, replica, "redo");
          if (JSON.stringify(comparable(replica.snapshot())) !== before) violate("undo then redo changed the model", name);
          count("undo then redo");
        }
      } else command(name, replica, step);
    } catch (error) {
      violate("threw", `${name} ${step.op}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  at = history.steps.length;
  world.queue.flush("D1");
  const present = [...world.replicas.values()];
  for (const source of present) for (const target of present) if (source !== target) target.apply(source.state());
  const copies = [...present, world.fresh("A")].map(replica => replica.snapshot());
  const first = JSON.stringify(copies[0]);
  copies.forEach((copy, index) => { if (JSON.stringify(copy) !== first) violate("copies differ", `copy ${index}`); });
  for (const row of copies[0]?.rows ?? []) {
    for (const [root, held] of multiset(row.characters.map(character => character.root))) if (held > 1) violate("restored twice", `${row.id} ${root} x${held}`);
    if (new Set(row.characters.map(character => character.id)).size !== row.characters.length) violate("one identity twice", row.id);
  }
  return { violations, counts, copies };
}
