import { isDeepStrictEqual } from "node:util";
import * as Y from "yjs";
import { NativeHeadingReplica } from "../../src/native/headings.ts";
import { deleteIn, joinUp, removeRow, restoreRow, splitAt, typeAt } from "../../src/native/rows.ts";
import type { NativeDeltaItem, NativeField } from "../../src/native/variant.ts";
import { randomFor } from "./e5-histories.ts";
import type { E5Delivery, E5History } from "./e5-histories.ts";
import { E5Model, INITIAL, required } from "./e5-model.ts";
import type { E5Boundary, E5Command, E5Projection, E5Removal, E5Stored, E5Unit, E5Write } from "./e5-model.ts";

export const WRITES: readonly E5Write[] = ["create", "renameType", "renameDelete", "removeHeading", "restoreHeading",
  "typeBeat", "deleteBeat", "split", "join", "unjoin", "removeBeat", "restoreBeat"];

const embed = (boundary: E5Boundary): Record<string, string> => ({ [boundary.kind]: boundary.id });
const fieldOf = (field: "audio" | "visual"): NativeField => field === "audio" ? "audioText" : "visualText";
const plain = (delta: readonly NativeDeltaItem[]): string => delta.map(item => {
  if (typeof item.insert !== "string") throw new Error("Unexpected projected embed");
  return item.insert;
}).join("");

export function seedReplica(removal: E5Removal): NativeHeadingReplica {
  const seed = new NativeHeadingReplica(900, removal);
  seed.doc.transact(() => {
    for (const [id, { head, units }] of Object.entries(INITIAL.segments)) {
      const segment = new Y.Map<unknown>(), text = new Y.Text();
      seed.segments.set(id, segment);
      if (head) segment.set("head", embed(head));
      segment.set("text", text);
      units.forEach((unit, index) => {
        if (typeof unit === "string") text.insert(index, unit, {});
        else text.insertEmbed(index, embed(unit));
      });
    }
    seed.order.push(INITIAL.order);
    for (const id of Object.keys(INITIAL.headings)) seed.headings.set(id, new Y.Map());
    for (const [id, text] of Object.entries(INITIAL.visuals)) {
      seed.beats.set(id, new Y.Map());
      seed.visuals.set(id, new Y.Text(text));
    }
  }, "hydration");
  return seed;
}

export function loadReplica(removal: E5Removal, client: number, bytes: Uint8Array): NativeHeadingReplica {
  const replica = new NativeHeadingReplica(client, removal);
  Y.applyUpdate(replica.doc, bytes, "remote");
  return replica;
}

function boundary(value: unknown): E5Boundary {
  if (value && typeof value === "object") {
    if ("b" in value && typeof value.b === "string") return { kind: "b", id: value.b };
    if ("h" in value && typeof value.h === "string") return { kind: "h", id: value.h };
  }
  throw new Error("Unexpected stored boundary");
}

export function readStored(replica: NativeHeadingReplica): E5Stored {
  return {
    order: replica.order.toArray(),
    segments: Object.fromEntries([...replica.segments].map(([id, record]) => {
      const head = record.get("head"), text = record.get("text") as Y.Text;
      const units = (text.toDelta() as NativeDeltaItem[]).flatMap<E5Unit>(item => typeof item.insert === "string" ? [...item.insert] : [boundary(item.insert)]);
      return [id, { head: head === undefined ? null : boundary(head), units }];
    })),
    headings: Object.fromEntries([...replica.headings].map(([id, record]) => [id, record.get("removed") === true])),
    beats: Object.fromEntries([...replica.beats].map(([id, record]) => {
      const joined = record.get("joined") as { into: string } | undefined;
      return [id, { removed: record.has("removed"), into: joined?.into ?? null }];
    })),
    visuals: Object.fromEntries([...replica.visuals].map(([id, text]) => [id, plain(text.toDelta() as NativeDeltaItem[])]))
  };
}

export function readProjection(replica: NativeHeadingReplica): E5Projection {
  return {
    outline: replica.outline().map(entry => {
      if (entry.kind === "heading") return { kind: "heading", id: entry.id, name: plain(entry.name) };
      const { id, members, audio, visual, parts } = entry.row;
      return { kind: "row", id, members, audio: plain(audio), visual: plain(visual), parts };
    }),
    removedBeats: replica.recovery().map(entry => {
      if (entry.reason !== "removed") throw new Error(`Unexpected beat recovery: ${entry.reason}`);
      return { kind: "row", id: entry.beat, members: entry.members, audio: plain(entry.audio), visual: plain(entry.visualItems) };
    }),
    removedHeadings: replica.headingRecovery().map(entry => ({ kind: "heading", id: entry.id, name: plain(entry.name) }))
  };
}

function write(replica: NativeHeadingReplica, by: number, command: E5Command): void {
  switch (command.op) {
    case "create": replica.createHeading(command.beat, command.id, command.name); break;
    case "renameType": replica.typeHeading(command.id, command.at, command.value); break;
    case "renameDelete": replica.deleteHeadingText(command.id, command.at, command.at + 1); break;
    case "removeHeading": replica.removeHeading(command.id); break;
    case "restoreHeading": replica.restoreHeading(command.id); break;
    case "typeBeat": typeAt(replica, command.row, fieldOf(command.field), command.at, command.value); break;
    case "deleteBeat": deleteIn(replica, command.row, fieldOf(command.field), command.at, command.at + 1); break;
    case "split": splitAt(replica, command.row, command.at, command.id); break;
    case "unjoin": splitAt(replica, command.row, command.at, "unused"); break;
    case "join": joinUp(replica, command.row); break;
    case "removeBeat": removeRow(replica, command.row, `W${by + 1}`); break;
    case "restoreBeat": restoreRow(replica, command.id); break;
  }
}

function silence(replica: NativeHeadingReplica, op: E5Write): void {
  const noop = (): void => {};
  switch (op) {
    case "create": replica.createHeading = noop; break;
    case "renameType": replica.typeHeading = noop; break;
    case "renameDelete": replica.deleteHeadingText = noop; break;
    case "removeHeading": replica.removeHeading = noop; break;
    case "restoreHeading": replica.restoreHeading = noop; break;
    case "typeBeat":
    case "deleteBeat": {
      const splice = replica.splice.bind(replica);
      replica.splice = (beat, field, from, to, insert) => {
        if ((from === to) !== (op === "typeBeat")) splice(beat, field, from, to, insert);
      };
      break;
    }
    case "split": replica.split = noop; break;
    case "unjoin": replica.unjoin = noop; break;
    case "join": replica.join = noop; break;
    case "removeBeat": replica.remove = noop; break;
    case "restoreBeat": replica.restore = noop; break;
  }
}

type Snapshot = { stored: E5Stored; view: E5Projection };
export interface E5Run {
  mismatch?: { op: E5Write | "deliver" | "settle"; at: number; field: string; detail: string };
  crashes: number;
  final?: Snapshot;
  lost: number;
  duplicated: number;
  uneditable: number;
  disagreeing: number;
  outOfOrder: number;
  renameLocations: Record<string, number>;
}

function diff(replica: NativeHeadingReplica, model: E5Model): { field: string; detail: string } | undefined {
  const stored = model.stored(), actual = readStored(replica);
  for (const key of Object.keys(stored) as (keyof E5Stored)[]) {
    if (!isDeepStrictEqual(actual[key], stored[key])) {
      return { field: key, detail: `expected ${JSON.stringify(stored[key])}, got ${JSON.stringify(actual[key])}` };
    }
  }
  const view = model.project(stored), projected = readProjection(replica);
  for (const key of Object.keys(view) as (keyof E5Projection)[]) {
    if (!isDeepStrictEqual(projected[key], view[key])) {
      return { field: key, detail: `expected ${JSON.stringify(view[key])}, got ${JSON.stringify(projected[key])}` };
    }
  }
  return undefined;
}

const storedLetters = (stored: E5Stored): string => Object.values(stored.visuals).join("") +
  Object.values(stored.segments).map(segment => segment.units.filter(unit => typeof unit === "string").join("")).join("");
const shownLetters = (view: E5Projection): string => [...view.outline, ...view.removedBeats, ...view.removedHeadings]
  .map(entry => entry.kind === "heading" ? entry.name : entry.audio + entry.visual).join("").replace(/[ \n]/g, "");

function renameLocation(final: Snapshot, id: string, value: string): string {
  if (!storedLetters(final.stored).includes(value)) return "deleted by a later edit";
  for (const entry of final.view.outline) {
    if (entry.kind === "heading" && entry.name.includes(value)) return entry.id === id ? "restored heading" : "another visible heading";
    if (entry.kind === "row" && entry.audio.includes(value)) return "visible narration";
  }
  if (final.view.removedBeats.some(entry => entry.audio.includes(value))) return "removed beat narration";
  for (const entry of final.view.removedHeadings) {
    if (entry.name.includes(value)) return entry.id === id ? "removed heading name" : "another removed heading";
  }
  return "uneditable";
}

function metrics(report: E5Run, snapshots: Snapshot[], expected: E5Stored, events: E5History["events"]): void {
  const final = required(snapshots[0], "settled snapshot");
  report.final = final;
  report.disagreeing = snapshots.slice(1).filter(other => !isDeepStrictEqual(other, final)).length;
  const have = storedLetters(final.stored), want = storedLetters(expected), shown = shownLetters(final.view);
  const count = (value: string, char: string): number => value.split(char).length - 1;
  for (const char of new Set(want + have + shown)) {
    const stored = count(have, char), expectedCount = count(want, char), reachable = count(shown, char);
    report.lost += Math.max(0, expectedCount - stored);
    report.duplicated += Math.max(0, Math.max(stored, reachable) - expectedCount);
    report.uneditable += Math.max(0, stored - reachable);
  }
  const ordered = final.stored.order.flatMap(id => {
    const { head, units } = required(final.stored.segments[id], id);
    return [head, ...units].flatMap(unit => {
      if (!unit || typeof unit === "string") return [];
      const shown = unit.kind === "h" ? !final.stored.headings[unit.id] : !required(final.stored.beats[unit.id], unit.id).removed;
      return shown ? [unit.id] : [];
    });
  });
  const displayed = final.view.outline.flatMap(entry => entry.kind === "heading" ? [entry.id] : entry.members);
  report.outOfOrder = Number(!isDeepStrictEqual(ordered, displayed));
  events.forEach(({ command, seen }, index) => {
    if (command.op !== "renameType") return;
    const raced = events.some((other, pos) => other.command.op === "removeHeading" && other.command.id === command.id &&
      !seen.has(pos) && !other.seen.has(index));
    if (raced) {
      const location = renameLocation(final, command.id, command.value);
      report.renameLocations[location] = (report.renameLocations[location] ?? 0) + 1;
    }
  });
}

export function runHistory(history: E5History, removal: E5Removal, delivery: E5Delivery, seed: number, silent?: E5Write): E5Run {
  const first = seedReplica(removal), initial = first.encode();
  first.destroy();
  const copies = Array.from({ length: history.writers }, (_, by) => loadReplica(removal, by + 1, initial));
  const knowledge = copies.map(() => new Set<number>()), updates: Uint8Array[][] = [];
  const random = randomFor(seed), report: E5Run = {
    crashes: 0, lost: 0, duplicated: 0, uneditable: 0, disagreeing: 0, outOfOrder: 0, renameLocations: {}
  };
  let at = -1, op: E5Write | "deliver" | "settle" = "deliver", capturing: Uint8Array[] | null = null;
  for (const replica of copies) {
    if (silent) silence(replica, silent);
    replica.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === replica.origin) capturing?.push(update);
    });
  }
  const replicaAt = (index: number): NativeHeadingReplica => required(copies[index], `replica ${index}`);
  const knownAt = (index: number): Set<number> => required(knowledge[index], `knowledge of replica ${index}`);
  const deliver = (from: number, to: number): void => {
    const source = replicaAt(from), target = replicaAt(to), sender = knownAt(from), receiver = knownAt(to);
    if (delivery === "state") Y.applyUpdate(target.doc, Y.encodeStateAsUpdate(source.doc, Y.encodeStateVector(target.doc)), "remote");
    else {
      const batch = [...sender].filter(index => !receiver.has(index)).sort((a, b) => a - b)
        .flatMap(index => required(updates[index], `updates from command ${index}`));
      let queue = batch;
      if (delivery === "reverse") queue = [...batch].reverse();
      if (delivery === "twice") queue = batch.flatMap(update => [update, update]);
      if (delivery === "shuffled") {
        queue = [...batch];
        for (let index = queue.length - 1; index > 0; index--) {
          const swap = Math.floor(random() * (index + 1));
          [queue[index], queue[swap]] = [required(queue[swap], "shuffled packet"), required(queue[index], "packet to shuffle")];
        }
        for (const update of batch) if (random() < 0.3) queue.splice(Math.floor(random() * (queue.length + 1)), 0, update);
      }
      for (const update of queue) Y.applyUpdate(target.doc, update, "remote");
    }
    for (const event of sender) receiver.add(event);
  };
  const check = (replica: NativeHeadingReplica, seen: ReadonlySet<number>): void => {
    const mismatch = diff(replica, new E5Model(history.events, seen));
    if (mismatch && !report.mismatch) report.mismatch = { at, op, ...mismatch };
  };
  try {
    for (const step of history.steps) {
      at++;
      if ("command" in step) {
        op = step.command.op;
        capturing = [];
        write(replicaAt(step.by), step.by, step.command);
        knownAt(step.by).add(updates.length);
        updates.push(capturing);
        capturing = null;
        check(replicaAt(step.by), knownAt(step.by));
      } else {
        op = "deliver";
        deliver(step.from, step.to);
        check(replicaAt(step.to), knownAt(step.to));
      }
      if (report.mismatch) return report;
    }
    at++;
    op = "settle";
    copies.forEach((_, from) => copies.forEach((_, to) => { if (from !== to) deliver(from, to); }));
    const all = new Set(history.events.keys()), late = loadReplica(removal, 800, replicaAt(0).encode());
    try {
      const settled = [...copies, late];
      const snapshots = settled.map(replica => ({ stored: readStored(replica), view: readProjection(replica) }));
      metrics(report, snapshots, new E5Model(history.events, all).stored(), history.events);
      for (const replica of settled) check(replica, all);
    } finally { late.destroy(); }
    return report;
  } catch (error) {
    report.crashes++;
    report.mismatch = { at, op, field: "threw", detail: error instanceof Error ? error.stack ?? error.message : String(error) };
    return report;
  } finally {
    copies.forEach(copy => { copy.destroy(); });
  }
}
