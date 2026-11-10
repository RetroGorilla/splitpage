import * as Y from "yjs";
import { ReplicaHarness } from "../../src/delivery.ts";
import type { QueuedDelivery } from "../../src/delivery.ts";
import type { CollabIdentity, CollabMarks, CollabModel, IdentityBook } from "../../src/model.ts";
import { mapValue, SchemaReplica, textValue } from "../../src/schema.ts";
import type { SeedBeat } from "../../src/schema.ts";
import { readStructure } from "../../src/structure-reader.ts";
import { addComment, addReply, captureRange, changeStatus, createHeadingRecord, deleteRange, formatRange, insertText, join, moveBeat, removeBeat, removeHeadingRecord, replaceRange, setScalar, split, tagRange } from "../../src/undo-records/commands.ts";
import { CommandHistory } from "../../src/undo-records/history.ts";
import type { UndoOutcome } from "../../src/undo-records/history.ts";

export const commandOps = ["insert", "delete", "bold", "unbold", "tag", "comment", "reply", "split", "join", "remove", "move", "status", "scalar", "replace", "heading", "unheading"] as const;
export const historyOps = ["undo", "redo", "undo-redo"] as const;
export type GeneratedOp = typeof commandOps[number] | typeof historyOps[number] | "deliver" | "late";

export interface GeneratedStep {
  op: GeneratedOp;
  writer: number;
  r: readonly [number, number, number];
}

export interface GeneratedHistory {
  writers: 2 | 3;
  reorderWithinSender: boolean;
  steps: readonly GeneratedStep[];
}

export interface ExecuteOptions {
  actOnPending?: boolean;
}

export const violationChecks = ["replicas differ", "identity twice", "restored twice", "undo removed another writer's character", "undo then redo changed the model", "ineffective undo consumed other than one entry", "threw"] as const;
export type ViolationCheck = typeof violationChecks[number];

export interface Violation {
  check: ViolationCheck;
  detail: string;
}

export interface GeneratedRun {
  violations: Violation[];
  history: string[];
  executed: Record<string, number>;
}

export const generatorLength = 60;
export const defaultGeneratorRuns = 150;
export const generatorRuns = Number(process.env.UNDO_GENERATOR_RUNS ?? String(defaultGeneratorRuns));

export const generatorSeed: readonly SeedBeat[] = [
  { id: "R1", text: "# Ab" }, { id: "H1", kind: "heading", text: "In" }, { id: "R2", text: "cde" }, { id: "R3", text: "fg" }
];

const writerNames = ["Alice", "Bob", "Carol"] as const;
// why: Yjs clears an attribute formatted to null; the model's mark type has no null, so the removal is cast once here.
const unbold = { b: null } as unknown as CollabMarks;
const statuses = ["todo", "ready", "shot"] as const;

export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function generate(seed: number, writers: 2 | 3, length: number): GeneratedHistory {
  const next = random(seed * 3 + writers);
  const reorderWithinSender = next() < 0.25;
  const steps: GeneratedStep[] = [];
  for (let index = 0; index < length; index++) {
    const roll = next();
    const op: GeneratedOp = roll < 0.45 ? commandOps[Math.floor(next() * commandOps.length)] ?? "insert"
      : roll < 0.7 ? historyOps[Math.floor(next() * historyOps.length)] ?? "undo"
      : roll < 0.98 ? "deliver" : "late";
    steps.push({ op, writer: Math.floor(next() * writers), r: [next(), next(), next()] });
  }
  return { writers, reorderWithinSender, steps };
}

function holdsPending(replica: SchemaReplica): boolean {
  return replica.doc.store.pendingStructs !== null || replica.doc.store.pendingDs !== null;
}

interface BeatSlot {
  id: string;
  kind: "b" | "h";
  length: number;
  ownSegment: boolean;
  text: string;
}

function beatSlots(replica: SchemaReplica): BeatSlot[] {
  const segments = replica.doc.getMap("segments");
  const slots: BeatSlot[] = [];
  for (const segmentId of new Set(replica.doc.getArray<string>("order").toArray())) {
    const segment = mapValue(segments.get(segmentId));
    const head = segment.get("head") as { b?: string; h?: string };
    const id = head.b ?? head.h ?? "";
    let current: BeatSlot = { id, kind: head.h ? "h" : "b", length: 0, ownSegment: segmentId === `seg-${id}`, text: "" };
    slots.push(current);
    for (const delta of textValue(segment.get("text")).toDelta() as { insert: unknown }[]) {
      if (typeof delta.insert === "string") {
        current.length += delta.insert.length;
        current.text += delta.insert;
      } else {
        const embed = delta.insert as { b?: string; h?: string };
        current = { id: embed.b ?? embed.h ?? "", kind: embed.h ? "h" : "b", length: 0, ownSegment: false, text: "" };
        slots.push(current);
      }
    }
  }
  return slots.filter(slot => replica.doc.getMap("beats").has(slot.id));
}

function pick<T>(items: readonly T[], r: number): T | undefined {
  return items[Math.floor(r * items.length)];
}

function key(id: CollabIdentity): string {
  return `${id.client}:${id.clock}`;
}

function originals(replica: SchemaReplica): Map<string, string> {
  const back = new Map<string, string>();
  for (const [original, restored] of replica.doc.getMap<CollabIdentity>("restoredIdentities")) back.set(key(restored), original);
  return back;
}

function rootOf(back: Map<string, string>, id: string): string {
  let current = id;
  const seen = new Set<string>();
  while (back.has(current) && !seen.has(current)) {
    seen.add(current);
    current = back.get(current) ?? current;
  }
  return current;
}

function identified(row: CollabModel["rows"][number], at: string): { id: string; at: string }[] {
  return row.characters.flatMap(character => character.identity ? [{ id: key(character.identity), at }] : []);
}

function characters(model: CollabModel): { id: string; at: string }[] {
  return [...model.rows.flatMap(row => identified(row, row.id)), ...model.recovery.flatMap(entry => identified(entry.row, `recovery ${entry.row.id}`))];
}

function normalized(model: CollabModel, back: Map<string, string>, identities: IdentityBook, blindAttribution = false): string {
  const root = (identity: CollabIdentity | null): string => identity ? rootOf(back, key(identity)) : "glue";
  const named = (notation: string): string => {
    try {
      return root(identities.identity(notation));
    } catch {
      return notation;
    }
  };
  const marks = (value: Record<string, unknown>): unknown => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  const row = (entry: CollabModel["rows"][number]): unknown => ({ ...entry, characters: entry.characters.map(character => [root(character.identity), character.value, marks(character.marks)]) });
  const recovery = model.recovery.map(entry => blindAttribution ? { row: row(entry.row) } : { ...entry, row: row(entry.row), edited: entry.edited.map(named) });
  return JSON.stringify({ rows: model.rows.map(row), recovery, notices: model.notices ?? [] });
}

function comparable(model: CollabModel, blindAttribution = false): string {
  const recovery = blindAttribution ? model.recovery.map(entry => entry.row) : model.recovery;
  return JSON.stringify({ rows: model.rows, recovery, notices: model.notices ?? [], records: model.records ?? {} });
}

function summary(model: CollabModel): string {
  const rows = model.rows.map(row => `${row.id}${row.status ? `(${row.status})` : ""}[${row.characters.map(character => `${character.notation}${Object.keys(character.marks).length ? `{${Object.entries(character.marks).map(([name, value]) => `${name}=${String(value)}`).sort().join(",")}}` : ""}`).join(" ")}]`).join(" ");
  const recovery = model.recovery.map(entry => `${entry.row.id} by ${entry.by} edited=${JSON.stringify(entry.edited)}${entry.splitBy ? ` splitBy=${entry.splitBy}` : ""}`).join(", ");
  return `${rows}; recovery ${recovery || "none"}${model.notices?.length ? `; notices ${model.notices.join(", ")}` : ""}`;
}

export function execute(generated: GeneratedHistory, options: ExecuteOptions = {}): GeneratedRun {
  const harness = new ReplicaHarness("B", generatorSeed);
  const violations: Violation[] = [];
  const executed: Record<string, number> = {};
  const history = harness.queue.history;
  let serial = 0;
  let fresh: SchemaReplica | null = null;
  const fresher = (): string => String(++serial);
  const read = (replica: SchemaReplica): CollabModel => readStructure(replica.doc, "B", harness.identities);
  try {
    harness.alice.doc.transact(() => harness.alice.doc.getMap("tags").set("P", { kind: "Prop" }), "fixture");
    harness.queue.flush("D2");
    const replicas: SchemaReplica[] = [harness.alice, harness.bob];
    if (generated.writers === 3) replicas.push(harness.lateJoin(harness.alice));
    const histories = replicas.map(replica => new CommandHistory(replica));
    history.push(`generated: ${generated.writers} writers, ${generated.reorderWithinSender ? "one sender's updates may arrive out of order" : "each sender's updates arrive in order"}, fixture ${JSON.stringify(generatorSeed)}`);
    let joined = generated.writers === 3;
    const note = (line: string): void => { history.push(line); };
    const flag = (check: ViolationCheck, detail: string): void => {
      violations.push({ check, detail });
      note(`VIOLATION ${check}: ${detail}`);
    };
    const undoChecked = (writer: number, then: (outcome: UndoOutcome, before: CollabModel) => void): void => {
      const history = histories[writer];
      const replica = replicas[writer];
      if (!history || !replica) return;
      const name = writerNames[writer] ?? "?";
      let before: CollabModel;
      try {
        before = read(replica);
      } catch (error) {
        flag("threw", `reader on client ${replica.doc.clientID}: ${error instanceof Error ? error.message : String(error)}`);
        const outcome = history.undo();
        bindRestores(harness, outcome);
        note(`${name} undo ${outcome.label ?? "none"} effective=${String(outcome.effective)} consumed=${outcome.consumed}, unchecked`);
        return;
      }
      const depth = history.undoStack.length;
      let updates = 0;
      const count = (): void => { updates++; };
      replica.doc.on("update", count);
      let outcome: UndoOutcome;
      try {
        outcome = history.undo();
      } finally {
        replica.doc.off("update", count);
      }
      bindRestores(harness, outcome);
      note(`${name} undo ${outcome.label ?? "none"} effective=${String(outcome.effective)} consumed=${outcome.consumed}`);
      if (outcome.label === null) return;
      const checked = outcome.effective ? "effective undos checked" : "ineffective undos checked";
      executed[checked] = (executed[checked] ?? 0) + 1;
      if (!outcome.effective && (outcome.consumed !== 1 || history.undoStack.length !== depth - 1 || updates !== 0)) {
        flag("ineffective undo consumed other than one entry", `${name}: consumed ${outcome.consumed}, stack ${depth} -> ${history.undoStack.length}, ${updates} update(s)`);
      }
      if (outcome.effective) {
        const back = originals(replica);
        let model: CollabModel;
        try {
          model = read(replica);
        } catch (error) {
          flag("threw", `reader on client ${replica.doc.clientID}: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        const after = new Set(characters(model).map(character => character.id));
        for (const character of characters(before)) {
          if (after.has(character.id)) continue;
          const root = rootOf(back, character.id);
          if (Number(root.split(":")[0]) !== replica.doc.clientID) flag("undo removed another writer's character", `${name}'s undo of ${outcome.label} removed ${harness.identities.notation(identityOf(character.id))} (created by client ${root.split(":")[0]}) from ${character.at}`);
        }
      }
      then(outcome, before);
    };
    for (const step of generated.steps) {
      const writer = step.writer % generated.writers;
      const history = histories[writer];
      const replica = replicas[writer];
      if (!history || !replica) continue;
      const name = writerNames[writer] ?? "?";
      const [r0, r1, r2] = step.r;
      let ran = true;
      if (step.op !== "deliver" && step.op !== "late" && holdsPending(replica) && !options.actOnPending) {
        executed["waited on an out-of-order update"] = (executed["waited on an out-of-order update"] ?? 0) + 1;
        continue;
      }
      try {
        if (step.op === "deliver") {
          const eligible = generated.reorderWithinSender ? harness.queue.pending
            : harness.queue.pending.filter((message, index) => !harness.queue.pending.slice(0, index).some(earlier => earlier.from === message.from && earlier.to === message.to));
          const message = pick(eligible, r0);
          if (!message) ran = false;
          else harness.queue.deliver(message.id, r1 < 0.2 ? 2 : 1);
        } else if (step.op === "late") {
          if (joined) ran = false;
          else {
            const source = pick([harness.alice, harness.bob], r0) ?? harness.alice;
            const sourceName = source === harness.alice ? "A" : "B";
            harness.lateJoin(source);
            const owed: QueuedDelivery[] = harness.queue.pending.filter(message => message.to === sourceName).map(message => ({ ...message, id: `${message.id}c`, to: "C" }));
            harness.queue.pending.push(...owed);
            note(`C also owed ${owed.length} update(s) queued for ${sourceName}`);
            joined = true;
          }
        } else if (step.op === "undo") {
          undoChecked(writer, () => undefined);
        } else if (step.op === "redo") {
          const outcome = history.redo();
          bindRestores(harness, outcome);
          note(`${name} redo ${outcome.label ?? "none"} effective=${String(outcome.effective)}`);
          if (outcome.label === null) ran = false;
        } else if (step.op === "undo-redo") {
          undoChecked(writer, (outcome, before) => {
            if (!outcome.effective) return;
            const redone = history.redo();
            bindRestores(harness, redone);
            note(`${name} redo ${redone.label ?? "none"} effective=${String(redone.effective)}`);
            const back = originals(replica);
            let after: CollabModel;
            try {
              after = read(replica);
            } catch (error) {
              flag("threw", `reader on client ${replica.doc.clientID}: ${error instanceof Error ? error.message : String(error)}`);
              return;
            }
            executed["undo-then-redo round trips checked"] = (executed["undo-then-redo round trips checked"] ?? 0) + 1;
            const ids = harness.identities;
            if (normalized(before, back, ids) !== normalized(after, back, ids)) {
              const scope = normalized(before, back, ids, true) === normalized(after, back, ids, true) ? "only in recovery attribution: " : "";
              flag("undo then redo changed the model", `${scope}${name} ${outcome.label}: before ${summary(before)} || after ${summary(after)}`);
            }
          });
        } else {
          ran = command(step.op, history, replica, name, [r0, r1, r2], fresher, note);
        }
      } catch (error) {
        flag("threw", `${name} ${step.op}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (ran) executed[step.op] = (executed[step.op] ?? 0) + 1;
    }
    for (let round = 0; harness.queue.pending.length > 0 && round < 50; round++) {
      for (const message of [...harness.queue.pending]) harness.queue.deliver(message.id, 1);
    }
    fresh = new SchemaReplica("B", 7, harness.identities);
    Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(harness.alice.doc), "reload");
    note("drained; fresh replica client 7 from Alice's encoded state");
    const models: { client: number; model: CollabModel }[] = [];
    for (const replica of [...harness.replicas, fresh]) {
      try {
        models.push({ client: replica.doc.clientID, model: read(replica) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        violations.push({ check: "threw", detail: `reader on client ${replica.doc.clientID}: ${message}` });
        note(`VIOLATION threw: reader on client ${replica.doc.clientID}: ${message}`);
      }
    }
    if (new Set(models.map(entry => comparable(entry.model))).size > 1) {
      const scope = new Set(models.map(entry => comparable(entry.model, true))).size === 1 ? "only in recovery attribution: " : "";
      const detail = scope + models.map(entry => `client${entry.client}: ${summary(entry.model)}`).join(" | ");
      violations.push({ check: "replicas differ", detail });
      note(`VIOLATION replicas differ: ${detail}`);
    }
    const back = originals(harness.alice);
    for (const { client, model } of models) {
      const seen = new Map<string, number>();
      const roots = new Map<string, number>();
      for (const character of characters(model)) {
        seen.set(character.id, (seen.get(character.id) ?? 0) + 1);
        const root = rootOf(back, character.id);
        roots.set(root, (roots.get(root) ?? 0) + 1);
      }
      for (const [id, count] of seen) if (count > 1) violations.push({ check: "identity twice", detail: `client${client}: ${harness.identities.notation(identityOf(id))} x${count}` });
      for (const [root, count] of roots) if (count > 1 && (seen.get(root) ?? 0) < 2) violations.push({ check: "restored twice", detail: `client${client}: ${harness.identities.notation(identityOf(root))} x${count}` });
    }
    return { violations, history: [...history], executed };
  } catch (error) {
    violations.push({ check: "threw", detail: `harness: ${error instanceof Error ? error.message : String(error)}` });
    return { violations, history: [...history], executed };
  } finally {
    fresh?.destroy();
    harness.destroy();
  }
}

export function shrink(generated: GeneratedHistory, keeps: (violation: Violation) => boolean, options: ExecuteOptions = {}): GeneratedHistory {
  let steps = [...generated.steps];
  const holds = (candidate: GeneratedStep[]): boolean => execute({ ...generated, steps: candidate }, options).violations.some(keeps);
  for (let chunk = Math.max(1, Math.floor(steps.length / 2)); chunk >= 1; chunk = Math.floor(chunk / 2)) {
    for (let start = 0; start < steps.length;) {
      const candidate = [...steps.slice(0, start), ...steps.slice(start + chunk)];
      if (candidate.length < steps.length && holds(candidate)) steps = candidate;
      else start += chunk;
    }
  }
  if (generated.writers === 3) {
    const two = steps.filter(step => step.writer % 3 !== 2);
    if (execute({ ...generated, writers: 2, steps: two }, options).violations.some(keeps)) return { ...generated, writers: 2, steps: two };
  }
  return { ...generated, steps };
}

function identityOf(id: string): CollabIdentity {
  const [client, clock] = id.split(":").map(Number);
  return { client: client ?? 0, clock: clock ?? 0 };
}

function bindRestores(harness: ReplicaHarness, outcome: UndoOutcome): void {
  for (const [original, restored] of outcome.restored) {
    let notation = harness.identities.notation(original);
    if (notation.startsWith("?")) continue;
    for (;;) {
      notation = `${notation}*`;
      try {
        harness.identities.identity(notation);
      } catch {
        break;
      }
    }
    harness.identities.bind(notation, restored);
  }
}

function command(op: GeneratedOp, history: CommandHistory, replica: SchemaReplica, name: string, r: readonly [number, number, number], fresh: () => string, note: (line: string) => void): boolean {
  const [r0, r1, r2] = r;
  const slots = beatSlots(replica);
  const beats = slots.filter(slot => slot.kind === "b");
  const filled = slots.filter(slot => slot.length > 0);
  const tag = name.charAt(0).toLowerCase();
  const span = (slot: BeatSlot): [number, number] => {
    const from = Math.floor(r1 * slot.length);
    return [from, Math.min(slot.length, from + 1 + Math.floor(r2 * 2))];
  };
  switch (op) {
    case "insert": {
      const slot = pick(slots, r0);
      if (!slot) return false;
      const offset = Math.floor(r1 * (slot.length + 1));
      const id = fresh();
      insertText(history, slot.id, offset, "k", [`${tag}${id}`]);
      note(`${name} insert k as ${tag}${id} at ${slot.id}:${offset}`);
      return true;
    }
    case "delete": case "bold": case "unbold": case "tag": case "comment": {
      const slot = pick(filled, r0);
      if (!slot) return false;
      const [from, to] = span(slot);
      if (op === "delete") deleteRange(history, slot.id, from, to);
      else if (op === "bold" || op === "unbold") formatRange(history, slot.id, from, to, op === "bold" ? { b: true } : unbold);
      else if (op === "tag") tagRange(history, slot.id, from, to, "P");
      else addComment(history, `C${fresh()}`, slot.id, from, to - from, name);
      note(`${name} ${op} ${slot.id}:${from}-${to}`);
      return true;
    }
    case "reply": {
      const comment = pick([...replica.doc.getMap("comments").keys()].sort(), r0);
      if (!comment) return false;
      const id = `p${fresh()}`;
      addReply(history, id, comment, name);
      note(`${name} reply ${id} to ${comment}`);
      return true;
    }
    case "split": {
      const slot = pick(beats, r0);
      if (!slot) return false;
      const offset = Math.floor(r1 * (slot.length + 1));
      const id = fresh();
      split(history, slot.id, offset, `S${id}`, `${tag}s${id}`, name);
      note(`${name} split ${slot.id}:${offset} into S${id}`);
      return true;
    }
    case "join": {
      const index = 1 + Math.floor(r0 * (slots.length - 1));
      const from = slots[index];
      const into = slots[index - 1];
      if (!from || !into || from.kind !== "b" || into.kind !== "b") return false;
      const id = `j${fresh()}`;
      join(history, from.id, into.id, id);
      note(`${name} join ${from.id} into ${into.id} (${id})`);
      return true;
    }
    case "remove": {
      const slot = pick(beats, r0);
      if (!slot) return false;
      const id = `x${fresh()}`;
      removeBeat(history, slot.id, id, name);
      note(`${name} remove ${slot.id} (${id})`);
      return true;
    }
    case "move": {
      const slot = pick(slots.filter(entry => entry.ownSegment && entry.kind === "b"), r0);
      if (!slot) return false;
      const target = r1 < 0.2 ? null : pick(slots.filter(entry => entry.ownSegment && entry.id !== slot.id), r2)?.id ?? null;
      const moved = moveBeat(history, slot.id, target);
      note(`${name} move ${slot.id} before ${target ?? "the end"}: ${moved ? "moved" : "refused"}`);
      return moved;
    }
    case "status": {
      const slot = pick(beats, r0);
      if (!slot) return false;
      const value = pick(statuses, r1) ?? "todo";
      const id = `e${fresh()}`;
      changeStatus(history, slot.id, id, value, name);
      note(`${name} status ${slot.id} ${value} (${id})`);
      return true;
    }
    case "scalar": {
      const slot = pick(beats, r0);
      if (!slot) return false;
      const value = 1 + Math.floor(r1 * 9);
      setScalar(history, slot.id, "lengthSeconds", value);
      note(`${name} lengthSeconds ${slot.id} = ${value}`);
      return true;
    }
    case "replace": {
      const first = Math.floor(r0 * filled.length);
      const last = Math.min(filled.length - 1, first + Math.floor(r1 * 2));
      const fromSlot = filled[first];
      const toSlot = filled[last];
      if (!fromSlot || !toSlot) return false;
      const from = Math.floor(r2 * fromSlot.length);
      const to = first === last ? Math.min(toSlot.length, from + 1) : Math.floor(r2 * (toSlot.length + 1));
      if (first === last && to <= from) return false;
      const capture = captureRange(history, fromSlot.id, from, toSlot.id, to);
      const id = fresh();
      const value = r1 < 0.5 ? "" : "z";
      replaceRange(history, capture, value, value ? [`${tag}r${id}`] : [], name);
      note(`${name} replace ${fromSlot.id}:${from}-${toSlot.id}:${to} with "${value}"`);
      return true;
    }
    case "heading": {
      const slot = pick(beats.filter(entry => entry.text.startsWith("# ") && entry.length >= 3), r0);
      if (!slot) return false;
      const id = fresh();
      createHeadingRecord(history, slot.id, `G${id}`, 1, false, [`${tag}g${id}`]);
      note(`${name} heading ${slot.id} becomes G${id}`);
      return true;
    }
    case "unheading": {
      const index = slots.findIndex((entry, at) => entry.kind === "h" && slots[at + 1]?.kind === "b");
      const heading = slots[index];
      const next = slots[index + 1];
      if (!heading || !next) return false;
      const id = fresh();
      removeHeadingRecord(history, heading.id, `U${id}`, next.id);
      note(`${name} remove heading ${heading.id} as U${id} before ${next.id}`);
      return true;
    }
    default:
      return false;
  }
}
