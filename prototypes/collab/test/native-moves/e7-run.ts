import { isDeepStrictEqual } from "node:util";
import * as Y from "yjs";
import type { NativeHeadingReplica } from "../../src/native/headings.ts";
import { deleteIn, removeRow, restoreRow, splitAt, typeAt } from "../../src/native/rows.ts";
import type { NativeField } from "../../src/native/variant.ts";
import { moveBlocks, recordOf } from "../../src/native-moves/moves.ts";
import { randomFor } from "../native/e5-histories.ts";
import type { E5Delivery } from "../native/e5-histories.ts";
import { required } from "../native/e5-model.ts";
import type { E5Projection } from "../native/e5-model.ts";
import { loadReplica, readProjection, readStored as readE5Stored, seedReplica } from "../native/e5-run.ts";
import type { E7History } from "./e7-histories.ts";
import { E7Model, refOf } from "./e7-model.ts";
import type { E7Event, E7Move, E7Part, E7Place, E7Stored, E7Write } from "./e7-model.ts";

export type E7ControlPart = E7Part | "text" | "flag";
export interface E7Control { op: E7Write; part: E7ControlPart }
export const CONTROLS: readonly E7Control[] = [
  { op: "typeBeat", part: "text" }, { op: "deleteBeat", part: "text" }, { op: "renameType", part: "text" }, { op: "renameDelete", part: "text" },
  { op: "create", part: "record" }, { op: "create", part: "boundary" }, { op: "create", part: "name" }, { op: "create", part: "headingPlace" },
  { op: "removeHeading", part: "flag" }, { op: "restoreHeading", part: "flag" },
  { op: "split", part: "boundary" }, { op: "split", part: "record" }, { op: "split", part: "visualCell" }, { op: "split", part: "repoint" },
  { op: "join", part: "flag" }, { op: "unjoin", part: "flag" }, { op: "removeBeat", part: "flag" }, { op: "restoreBeat", part: "flag" },
  { op: "move", part: "member" }, { op: "move", part: "dependent" }
];

// why: a control part counts only where the model says the command wrote it; a plain command always writes its one part
export function effective(event: E7Event, control: E7Control): boolean {
  if (event.command.op !== control.op) return false;
  return control.part === "text" || control.part === "flag" || (event.parts[control.part]?.length ?? 0) > 0;
}

const fieldOf = (field: "audio" | "visual"): NativeField => field === "audio" ? "audioText" : "visualText";

export function readStored(replica: NativeHeadingReplica): E7Stored {
  const places: Record<string, E7Place | null> = {};
  for (const [id, record] of replica.beats) places[refOf("b", id)] = (record.get("place") as E7Place | undefined) ?? null;
  for (const [id, record] of replica.headings) places[refOf("h", id)] = (record.get("place") as E7Place | undefined) ?? null;
  return { ...readE5Stored(replica), places };
}

function write(replica: NativeHeadingReplica, { by, command, joinInto }: E7Event): void {
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
    case "join": replica.join(command.row, required(joinInto, "planned join target"), " "); break;
    case "removeBeat": removeRow(replica, command.row, `W${by + 1}`); break;
    case "restoreBeat": restoreRow(replica, command.id); break;
    case "move": moveBlocks(replica, command.first, command.last, command.after); break;
  }
}

type Patch = [object, string, (original: (...args: never[]) => unknown) => (...args: never[]) => unknown];

// why: the control silences one write at the library call that makes it, so the writer above it runs unchanged
function mutes(replica: NativeHeadingReplica, event: E7Event, part: E7ControlPart): Patch[] {
  const { command } = event, text = Y.Text.prototype, map = Y.Map.prototype, array = Y.Array.prototype;
  const skipIf = (test: (self: unknown, args: unknown[]) => boolean) => (original: (...args: never[]) => unknown) =>
    function (this: unknown, ...args: never[]): unknown { return test(this, args) ? undefined : original.apply(this, args); };
  const key = (name: string) => skipIf((_, args) => args[0] === name);
  const records = (refs: readonly string[] | undefined): Set<unknown> => new Set((refs ?? []).map(ref => recordOf(replica, ref)));
  switch (command.op) {
    case "typeBeat": case "renameType": return [[text, "insert", skipIf(() => true)]];
    case "deleteBeat": case "renameDelete": return [[text, "delete", skipIf(() => true)]];
    case "removeHeading": case "removeBeat": return [[map, "set", key("removed")]];
    case "restoreHeading": case "restoreBeat": return [[map, "delete", key("removed")]];
    case "join": return [[map, "set", key("joined")]];
    case "unjoin": return [[map, "delete", key("joined")]];
    case "create": {
      if (part === "record") return [[map, "set", skipIf((self, args) => self === replica.headings && args[0] === command.id)]];
      if (part === "name") return [[text, "insert", skipIf(() => true)]];
      if (part === "headingPlace") return [[map, "set", key("place")]];
      const segment = `seg-h-${command.id}`;
      return [[text, "insertEmbed", skipIf((_, args) => (args[1] as { h?: string } | undefined)?.h === command.id)],
        [map, "set", skipIf((self, args) => self === replica.segments && args[0] === segment)],
        [array, "insert", skipIf((self, args) => self === replica.order && (args[1] as string[]).includes(segment))]];
    }
    case "split": {
      if (part === "boundary") return [[text, "insertEmbed", skipIf((_, args) => (args[1] as { b?: string } | undefined)?.b === command.id)]];
      if (part === "record") return [[map, "set", skipIf((self, args) => self === replica.beats && args[0] === command.id)]];
      if (part === "visualCell") return [[map, "set", skipIf((self, args) => self === replica.visuals && args[0] === command.id)]];
      return [[map, "set", key("place")]];
    }
    case "move": {
      const targets = records(event.parts[part === "member" ? "member" : "dependent"]);
      return [[map, "set", skipIf((self, args) => args[0] === "place" && targets.has(self))]];
    }
  }
}

function silenced<T>(patches: readonly Patch[], run: () => T): T {
  const saved = patches.map(([owner, name]) => [owner, name, (owner as Record<string, unknown>)[name]] as const);
  for (const [owner, name, wrap] of patches) {
    const original = (owner as Record<string, (...args: never[]) => unknown>)[name];
    if (!original) throw new Error(`No ${name} to silence`);
    (owner as Record<string, unknown>)[name] = wrap(original);
  }
  try { return run(); } finally { for (const [owner, name, original] of saved) (owner as Record<string, unknown>)[name] = original; }
}

type Snapshot = { stored: E7Stored; view: E5Projection; order: string[] };
export interface E7Silence { at: number; part: E7ControlPart }
export interface E7Run {
  mismatch?: { op: E7Write | "deliver" | "settle"; at: number; field: string; detail: string };
  crashes: number;
  final?: Snapshot;
  lost: number;
  duplicated: number;
  uneditable: number;
  disagreeing: number;
  notOnce: number;
  unmovedOutOfOrder: number;
  concurrent: {
    typing: number; typingFollowed: number; typingDeleted: number; typingInNewHeading: number;
    splits: number; splitsFollowed: number; splitsMovedSince: number; splitsUnderNewHeading: number; splitsBesideOtherSplit: number; sameBlockMoves: number;
  };
  lateJoinerOrder?: string[];
}

function actualOrder(replica: NativeHeadingReplica): string[] { return replica.blocks().map(block => refOf(block.kind, block.id)); }

function diff(replica: NativeHeadingReplica, model: E7Model): { field: string; detail: string } | undefined {
  const stored = model.stored(), actual = readStored(replica);
  for (const key of Object.keys(stored) as (keyof E7Stored)[]) {
    if (!isDeepStrictEqual(actual[key], stored[key])) return { field: key, detail: `expected ${JSON.stringify(stored[key])}, got ${JSON.stringify(actual[key])}` };
  }
  const order = model.arrangement(stored).order, shown = actualOrder(replica);
  if (!isDeepStrictEqual(shown, order)) return { field: "order", detail: `expected ${JSON.stringify(order)}, got ${JSON.stringify(shown)}` };
  const view = model.project(stored), projected = readProjection(replica);
  for (const key of Object.keys(view) as (keyof E5Projection)[]) {
    if (!isDeepStrictEqual(projected[key], view[key])) return { field: key, detail: `expected ${JSON.stringify(view[key])}, got ${JSON.stringify(projected[key])}` };
  }
  return undefined;
}

// why: what each command must do to the shown order, derived from the command alone and not from the placement rule
function immediate(before: readonly string[], after: readonly string[], event: E7Event): string | undefined {
  const { command } = event;
  if (command.op === "move") {
    const expected = E7Model.expectedOrder(before, command as E7Move);
    return isDeepStrictEqual([...after], expected) ? undefined : `move: expected ${JSON.stringify(expected)}, got ${JSON.stringify(after)}`;
  }
  if (command.op === "split" && event.target) {
    const created = refOf("b", command.id), expected = [...before];
    expected.splice(expected.indexOf(event.target) + 1, 0, created);
    return isDeepStrictEqual([...after], expected) ? undefined : `split: expected ${JSON.stringify(expected)}, got ${JSON.stringify(after)}`;
  }
  if (command.op === "create") {
    const expected = [...before];
    expected.splice(expected.indexOf(refOf("b", command.beat)), 0, refOf("h", command.id));
    return isDeepStrictEqual([...after], expected) ? undefined : `create: expected ${JSON.stringify(expected)}, got ${JSON.stringify(after)}`;
  }
  return isDeepStrictEqual([...after], [...before]) ? undefined : `${command.op}: order changed to ${JSON.stringify(after)}`;
}

const storedLetters = (stored: E7Stored): string => Object.values(stored.visuals).join("") +
  Object.values(stored.segments).map(segment => segment.units.filter(unit => typeof unit === "string").join("")).join("");
const shownLetters = (view: E5Projection): string => [...view.outline, ...view.removedBeats, ...view.removedHeadings]
  .map(entry => entry.kind === "heading" ? entry.name : entry.audio + entry.visual).join("").replace(/[ \n]/g, "");

function metrics(report: E7Run, snapshots: Snapshot[], expected: E7Stored, history: E7History): void {
  const final = required(snapshots[0], "settled snapshot"), model = new E7Model(history.events, new Set(history.events.keys()));
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
  const blocks = model.blocks(final.stored), listed = [...final.view.outline.flatMap(entry => entry.kind === "heading" ? [refOf("h", entry.id)] : entry.members.map(id => refOf("b", id))),
    ...final.view.removedBeats.flatMap(entry => entry.members.map(id => refOf("b", id))), ...final.view.removedHeadings.map(entry => refOf("h", entry.id))];
  report.notOnce = blocks.filter(block => listed.filter(ref => ref === block.ref).length !== 1).length + Number(listed.length !== blocks.length);
  const arrangement = model.arrangement(final.stored), unmoved = new Set(blocks.filter(block =>
    !arrangement.placed.has(block.ref) && !arrangement.following.has(block.ref) && !(arrangement.parent.has(block.ref))).map(block => block.ref));
  report.unmovedOutOfOrder = Number(!isDeepStrictEqual(final.order.filter(ref => unmoved.has(ref)), blocks.map(block => block.ref).filter(ref => unmoved.has(ref))));
  const events = history.events, concurrent = (one: number, other: number): boolean =>
    !required(events[one], "event").seen.has(other) && !required(events[other], "event").seen.has(one);
  const splitFrom = new Map(events.flatMap(event => event.command.op === "split" && event.target ? [[refOf("b", event.command.id), event.target] as const] : []));
  // why: a beat and the beats split off it later are one family; text typed in the beat can end in any of them
  const family = (ref: string, member: string): boolean => {
    for (let current: string | undefined = member; current !== undefined; current = splitFrom.get(current)) if (current === ref) return true;
    return false;
  };
  const blockText = (ref: string): string => blocks.filter(block => family(ref, block.ref)).map(block => block.text).join("");
  const visualText = (ref: string): string => final.stored.visuals[ref.slice(2)] ?? "";
  const movedLater = (index: number, refs: readonly string[]): boolean => events.some(later => later.command.op === "move" &&
    later.seen.has(index) && refs.some(ref => later.members?.includes(ref)));
  events.forEach((event, index) => {
    const moved = events.flatMap((other, at) => other.command.op === "move" && concurrent(index, at) && event.target && other.members?.includes(event.target) ? [at] : []);
    if (event.command.op === "move") {
      report.concurrent.sameBlockMoves += events.filter((other, at) => at > index && other.command.op === "move" && concurrent(index, at) &&
        other.members?.some(ref => event.members?.includes(ref))).length;
    }
    if (!moved.length || !event.target) return;
    if (event.command.op === "typeBeat") {
      report.concurrent.typing++;
      const value = event.command.value, inside = (event.command.field === "audio" ? blockText(event.target) : visualText(event.target)).includes(value);
      if (inside) report.concurrent.typingFollowed++;
      else if (!storedLetters(final.stored).includes(value)) report.concurrent.typingDeleted++;
      else if (blocks.some(block => block.kind === "h" && block.text.includes(value))) report.concurrent.typingInNewHeading++;
    }
    if (event.command.op === "split") {
      report.concurrent.splits++;
      const created = refOf("b", event.command.id), target = event.target, order = arrangement.order;
      const hangs = (ref: string): boolean => {
        for (let current: string | null | undefined = ref; typeof current === "string"; current = arrangement.parent.get(current)) if (family(target, current)) return true;
        return false;
      };
      const between = order.slice(order.indexOf(target) + 1, order.indexOf(created));
      const following = order.indexOf(target) < order.indexOf(created) && between.every(hangs);
      if (following) report.concurrent.splitsFollowed++;
      else if (movedLater(index, [created, target])) report.concurrent.splitsMovedSince++;
      else {
        const natural = blocks.map(block => block.ref), gap = natural.slice(natural.indexOf(target) + 1, natural.indexOf(created));
        const madeBy = (ref: string, op: string): number => events.findIndex(other => other.command.op === op && "id" in other.command && refOf(op === "create" ? "h" : "b", other.command.id) === ref);
        const newHeading = (ref: string): boolean => ref.startsWith("h:") && madeBy(ref, "create") >= 0 &&
          [index, ...moved].some(at => concurrent(madeBy(ref, "create"), at));
        if (gap.some(newHeading)) report.concurrent.splitsUnderNewHeading++;
        else if (gap.some(ref => madeBy(ref, "split") >= 0 && concurrent(madeBy(ref, "split"), index))) report.concurrent.splitsBesideOtherSplit++;
      }
    }
  });
}

export function runHistory(history: E7History, delivery: E5Delivery, seed: number, silence?: E7Silence): E7Run {
  const first = seedReplica("flag"), initial = first.encode();
  first.destroy();
  const copies = Array.from({ length: history.writers }, (_, by) => loadReplica("flag", by + 1, initial));
  const knowledge = copies.map(() => new Set<number>()), updates: Uint8Array[][] = [];
  const random = randomFor(seed), report: E7Run = {
    crashes: 0, lost: 0, duplicated: 0, uneditable: 0, disagreeing: 0, notOnce: 0, unmovedOutOfOrder: 0,
    concurrent: { typing: 0, typingFollowed: 0, typingDeleted: 0, typingInNewHeading: 0, splits: 0, splitsFollowed: 0, splitsMovedSince: 0, splitsUnderNewHeading: 0, splitsBesideOtherSplit: 0, sameBlockMoves: 0 }
  };
  let at = -1, op: E7Write | "deliver" | "settle" = "deliver", capturing: Uint8Array[] | null = null;
  for (const replica of copies) replica.doc.on("update", (update: Uint8Array, origin: unknown) => { if (origin === replica.origin) capturing?.push(update); });
  const replicaAt = (index: number): NativeHeadingReplica => required(copies[index], `replica ${index}`);
  const knownAt = (index: number): Set<number> => required(knowledge[index], `knowledge of replica ${index}`);
  const deliver = (from: number, to: number): void => {
    const source = replicaAt(from), target = replicaAt(to), sender = knownAt(from), receiver = knownAt(to);
    if (delivery === "state") Y.applyUpdate(target.doc, Y.encodeStateAsUpdate(source.doc, Y.encodeStateVector(target.doc)), "remote");
    else {
      const batch = [...sender].filter(index => !receiver.has(index)).sort((a, b) => a - b).flatMap(index => required(updates[index], `updates from command ${index}`));
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
    const mismatch = diff(replica, new E7Model(history.events, seen));
    if (mismatch && !report.mismatch) report.mismatch = { at, op, ...mismatch };
  };
  try {
    for (const step of history.steps) {
      at++;
      if ("command" in step) {
        op = step.command.op;
        const event = required(history.events[updates.length], "recorded command"), known = knownAt(step.by), replica = replicaAt(step.by);
        const before = new E7Model(history.events, known).arrangement().order;
        capturing = [];
        if (silence?.at === at) silenced(mutes(replica, event, silence.part), () => { write(replica, event); });
        else write(replica, event);
        known.add(updates.length);
        updates.push(capturing);
        capturing = null;
        check(replica, known);
        const wrong = immediate(before, new E7Model(history.events, known).arrangement().order, event);
        if (wrong && !report.mismatch) report.mismatch = { at, op, field: "immediate", detail: wrong };
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
    const all = new Set(history.events.keys()), late = loadReplica("flag", 800, replicaAt(0).encode());
    try {
      const settled = [...copies, late];
      const snapshots = settled.map(replica => ({ stored: readStored(replica), view: readProjection(replica), order: actualOrder(replica) }));
      metrics(report, snapshots, new E7Model(history.events, all).stored(), history);
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
