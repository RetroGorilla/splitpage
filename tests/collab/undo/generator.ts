import type { SharedContentRef, SharedMarkValue, SharedRecordCollection } from "../../../src/core/collab/operations.ts";
import type { ReplicaName } from "../delivery.ts";
import type { ModelSnapshot } from "./model-world.ts";
import { MODEL_WORLD } from "./scenario.ts";
import type { UndoReplica, UndoWorldKind } from "./scenario.ts";

export const UNDO_COMMANDS = ["insert", "type", "delete", "replace", "bold", "unbold", "tag", "untag", "status", "scalar"] as const;
export const UNDO_REVERSALS = ["undo", "redo", "undo-redo"] as const;
export const UNDO_DELIVERIES = ["deliver", "deliver-dup", "deliver-rev"] as const;
export const UNDO_RECORD_COMMANDS = ["record-create", "record-set", "record-delete"] as const;
export const UNDO_RECORD_KEYS: readonly (readonly [SharedRecordCollection, readonly string[]])[] = [
  ["comments", ["C1"]], ["replies", ['["C1","r1"]']], ["people", ["P1"]], ["tags", ["t_1"]], ["shots", ["S1"]]
];
export type UndoStepKind = typeof UNDO_COMMANDS[number] | typeof UNDO_RECORD_COMMANDS[number] | typeof UNDO_REVERSALS[number] | typeof UNDO_DELIVERIES[number] | "join";

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

const RECORD_WEIGHTED: readonly UndoStepKind[] = [
  ...WEIGHTED, "record-create", "record-create", "record-create", "record-create", "record-set", "record-set", "record-set", "record-delete", "record-delete"
];

export function generateUndoHistory(seed: number, writers: 2 | 3, length = 40, records = false): UndoHistory {
  const next = random(seed * 2 + writers), three = (): [number, number, number] => [next(), next(), next()];
  const steps: UndoStep[] = [], weighted = records ? RECORD_WEIGHTED : WEIGHTED;
  const commands: readonly string[] = records ? [...UNDO_COMMANDS, ...UNDO_RECORD_COMMANDS] : UNDO_COMMANDS;
  for (let index = 0; index < length; index++) {
    const previous = steps.at(-1);
    // why: identical changes by two writers are rare by chance, and they are what an undo that is used up comes from.
    if (previous && commands.includes(previous.op) && next() < 0.15) steps.push({ ...previous, writer: (previous.writer + 1) % writers });
    else steps.push({ op: pick(weighted, next()), writer: Math.floor(next() * writers), r: three() });
  }
  if (writers === 3 && next() < 0.5) steps.splice(Math.floor(next() * length), 0, { op: "join", writer: 2, r: three() });
  return { writers, steps };
}

interface Ledger { characters: Set<string>; marks: { mark: string; ends: string[] }[]; statuses: Set<string>; scalars: Set<string>; records: Set<string> }
interface Format {
  writer: ReplicaName; adds: boolean; mark: string; from: string; to: string; written: string[]; generation: number;
  state: "applied" | "undone" | "gone"; fresh: boolean; undone: boolean;
}
interface Entry { format: Format | null }

function multiset(items: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

function comparable(snapshot: ModelSnapshot): unknown {
  return [snapshot.records ?? {}, snapshot.rows.map(row => ({ ...row, characters: row.characters.map(({ root, value, marks }) => ({ root, value, marks })) }))];
}

function recordValue(stored: string | undefined): string | null {
  const fields = new Map(stored === undefined ? [] : JSON.parse(stored) as [string, unknown][]), value = fields.get("text") ?? fields.get("name");
  return typeof value === "string" ? value : null;
}

export function runUndoHistory(history: UndoHistory, kind: UndoWorldKind = MODEL_WORLD): UndoRun {
  const late = history.steps.some(step => step.op === "join");
  const world = kind.make(SEED, late ? ["A", "B"] : NAMES.slice(0, history.writers));
  const violations: UndoViolation[] = [], counts: Record<string, number> = {};
  const ledgers = new Map(NAMES.map((name): [ReplicaName, Ledger] => [name, { characters: new Set(), marks: [], statuses: new Set(), scalars: new Set(), records: new Set() }]));
  const count = (name: string): void => { counts[name] = (counts[name] ?? 0) + 1; };
  const stacks = new Map(NAMES.map((name): [ReplicaName, { undo: Entry[]; redo: Entry[] }] => [name, { undo: [], redo: [] }]));
  const formats: Format[] = [];
  let at = 0;
  const violate = (check: string, detail: string): void => { violations.push({ check, detail, step: at }); };
  const stack = (name: ReplicaName): { undo: Entry[]; redo: Entry[] } => {
    const found = stacks.get(name);
    if (!found) throw new Error("No stack for " + name);
    return found;
  };

  const foreign = (name: ReplicaName, replica: UndoReplica, before: ModelSnapshot, after: ModelSnapshot, undoing: boolean): void => {
    const ledger = ledgers.get(name);
    if (!ledger) throw new Error("No ledger for " + name);
    // why: a mark reaches every character inside the range it was given, also one typed there at the same moment.
    const inside = (character: { id: string; root: string }, mark: string): boolean => ledger.marks.some(range => {
      const ends = range.ends.flatMap(id => replica.spot(id) ?? []), from = Math.min(...ends), to = Math.max(...ends);
      return range.mark === mark && [character.id, character.root].some(id => { const spot = replica.spot(id); return spot !== undefined && from <= spot && spot <= to; });
    });
    const had = before.records ?? {}, has = after.records ?? {};
    for (const key of new Set([...Object.keys(had), ...Object.keys(has)])) {
      if (had[key] === has[key]) continue;
      if (!ledger.records.has(key)) violate("changed another writer's record", `${name} ${key}`);
      const held = recordValue(had[key]);
      // why: every writer writes values carrying its own letter, so the value an undo replaces or removes shows whose it was.
      if (undoing && held !== null && held[1] !== name) violate("an undo replaced another writer's current record value", `${name} ${key} ${held}`);
    }
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
        const held = row.scalars[field];
        if (held === next.scalars[field]) continue;
        if (!ledger.scalars.has(row.id + "|" + field)) violate("changed another writer's field", `${name} ${row.id} ${field}`);
        // why: every writer sets values of its own ten, so the value an undo replaces shows whose it was.
        if (undoing && held !== undefined && Math.floor(Number(held) / 10) !== NAMES.indexOf(name)) violate("overwrote another writer's current value", `${name} ${row.id} ${field} ${held}`);
      }
    });
  };

  const reverse = (name: ReplicaName, replica: UndoReplica, direction: "undo" | "redo"): boolean => {
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
    const entry = stack(name)[direction].pop(), format = entry?.format;
    if (entry && outcome.effective) stack(name)[other].push(entry);
    if (format) {
      if (outcome.effective) { format.state = direction === "undo" ? "undone" : "applied"; format.fresh = false; format.undone ||= direction === "undo" && format.adds; }
      else if (direction === "undo" && format.adds) format.state = "gone";
    }
    if (!outcome.effective) {
      count("used up " + direction);
      if (now[other] !== sizes[other] || replica.written.length !== written) violate("a used-up reversal wrote or kept something", `${name} ${direction}`);
      if (JSON.stringify(comparable(before)) !== JSON.stringify(comparable(replica.snapshot()))) violate("a used-up reversal changed the model", `${name} ${direction}`);
      return false;
    }
    count("effective " + direction);
    if (now[other] !== sizes[other] + 1) violate("an effective reversal left no way back", `${name} ${direction}`);
    if (replica.written.length !== written + 1) violate("an effective reversal did not write exactly one update", `${name} ${direction}`);
    foreign(name, replica, before, replica.snapshot(), direction === "undo");
    return true;
  };

  const command = (name: ReplicaName, replica: UndoReplica, step: UndoStep): void => {
    const ledger = ledgers.get(name);
    if (!ledger) throw new Error("No ledger for " + name);
    const [r0, r1, r2] = step.r, beat = pick(world.beats, r0), length = replica.length(beat);
    const from = Math.floor(r1 * (length + 1)), start = Math.min(Math.max(0, length - 1), Math.floor(r1 * length));
    const range = replica.observe(beat, start, Math.min(length, start + 1 + Math.floor(r2 * 3)));
    const sizes = replica.undo.sizes(), serial = replica.undo.serial();
    let format: Format | null = null;
    const roots = (): void => { for (const id of range.ids) ledger.characters.add(replica.rootOf(id)); };
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
      case "bold": case "unbold": case "tag": case "untag": {
        if (range.ids.length) ledger.marks.push({ mark: MARK_KEYS[step.op], ends: [range.ids[0] ?? "", range.ids.at(-1) ?? ""].flatMap(id => [id, replica.rootOf(id)]) });
        // why: which earlier formatting had arrived here is a fact of delivery, not of what the undo model made of it.
        const mark = MARK_KEYS[step.op], from = range.ids[0] ?? "", to = range.ids.at(-1) ?? "", adds = step.op === "bold" || step.op === "tag";
        const saw = formats.filter(other => other.adds && other.mark === mark && other.from === from && other.to === to && other.written.some(id => replica.knows(id)));
        const updates = replica.written.length, written = replica.mark(range, MARKS[step.op]);
        if (replica.written.length > updates) {
          // why: assumed rule 32: a mark made after seeing the same mark over the same range carries the next number.
          format = { writer: name, adds, mark, from, to, written: [...written], generation: 1 + Math.max(0, ...saw.map(other => other.generation)),
            state: "applied", fresh: true, undone: false };
          formats.push(format);
        }
        break;
      }
      case "status": ledger.statuses.add(beat); replica.status(beat, pick(STATUSES, r1)); break;
      case "scalar": {
        const value = pick([1, 2, null], r1);
        ledger.scalars.add(beat + "|lengthSeconds");
        replica.scalar(beat, "lengthSeconds", value === null ? undefined : value + 10 * NAMES.indexOf(name));
        break;
      }
      case "record-create": case "record-set": case "record-delete": {
        if (!replica.record) throw new Error("This world has no records");
        const action = step.op === "record-create" ? "create" : step.op === "record-set" ? "set" : "delete", held = replica.snapshot().records ?? {};
        const all = UNDO_RECORD_KEYS.flatMap(([collection, keys]) => keys.map(key => ({ collection, key })));
        // why: one draw in four is left as drawn, so a command the document refuses is reached too.
        const fitting = r1 < 0.25 ? [] : all.filter(item => (held[item.collection + "|" + item.key] === undefined) === (action === "create"));
        const { collection, key } = pick(fitting.length ? fitting : all, r0);
        const reason = replica.record(action, collection, key, "v" + name + pick(["a", "b"], r2));
        if (reason === null) { ledger.records.add(collection + "|" + key); count(step.op + " " + collection); }
        else count("record command refused: " + reason);
        break;
      }
      default: throw new Error("Not a command: " + step.op);
    }
    count(replica.undo.serial() === serial ? "command changed nothing" : "command");
    if (replica.undo.serial() !== serial && replica.undo.sizes().redo !== 0) violate("a command kept the redo stack", name);
    if (replica.undo.serial() !== serial) {
      stack(name).redo.length = 0;
      if (replica.undo.sizes().undo > sizes.undo) stack(name).undo.push({ format });
    }
    if (stack(name).undo.length !== replica.undo.sizes().undo) violate("the entries are not one per command", name);
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
  world.sync();
  const present = [...world.replicas.values()];
  const copies = [...present, world.fresh("A")].map(replica => replica.snapshot());
  const first = JSON.stringify(copies[0]);
  copies.forEach((copy, index) => { if (JSON.stringify(copy) !== first) violate("copies differ", `copy ${index}`); });
  for (const row of copies[0]?.rows ?? []) {
    for (const [root, held] of multiset(row.characters.map(character => character.root))) if (held > 1) violate("restored twice", `${row.id} ${root} x${held}`);
    if (new Set(row.characters.map(character => character.id)).size !== row.characters.length) violate("one identity twice", row.id);
  }
  const place = world.replica("A");
  const covers = (format: Format, id: string): boolean => {
    const from = place.spot(format.from), to = place.spot(format.to), spot = place.spot(id);
    return from !== undefined && to !== undefined && spot !== undefined && from <= spot && spot <= to;
  };
  // why: decided row: the same change by two people who had not seen each other's is one; undoing either undoes it.
  const cancelled = (format: Format): boolean => format.fresh && formats.some(other => other !== format && other.undone && other.adds && other.mark === format.mark
    && other.from === format.from && other.to === format.to && other.generation === format.generation);
  for (const format of formats) if (format.adds && format.state === "applied" && cancelled(format)) count("identical change cancelled");
  for (const row of copies[0]?.rows ?? []) for (const character of row.characters) {
    // why: a character from before the run that was never deleted has no formatting but what a command of the run gave it.
    if (character.id !== character.root || !character.id.startsWith("10:")) continue;
    for (const mark of character.marks) {
      const source = formats.some(format => format.mark === mark && covers(format, character.id)
        && (format.adds ? format.state === "applied" && !cancelled(format) : format.state === "undone"));
      if (!source) violate("kept formatting whose every command was undone", `${row.id} ${character.id} ${mark}`);
    }
  }
  return { violations, counts, copies };
}
