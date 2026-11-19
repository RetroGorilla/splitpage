import { isDeepStrictEqual as equal } from "node:util";
import * as Y from "yjs";
import type { RankDrop } from "../../src/native-moves/ranks.ts";
import type { ChosenNames, ChosenReplica } from "../../src/native-chosen/replica.ts";
import { joinUp } from "../../src/native/rows.ts";
import { ALL_RULES, STRAY_ROW, nativeMarkName } from "../../src/native/variant.ts";
import type { NativeDeltaItem, NativeField, NativeRules } from "../../src/native/variant.ts";
import { neverAcceptable, reachability } from "./check.ts";
import { deliver, readStyles, watch } from "./engine.ts";
import type { Mode } from "./engine.ts";
import { load as loadCopy, outline, seed } from "./kit.ts";
import type { MakeReplica, Spec } from "./kit.ts";
import { settle } from "./ledger.ts";
import type { LedgerEvent, LetterField } from "./ledger.ts";

export type Cmd =
  | { op: "type"; id: string; field: LetterField; at: number; text: string }
  | { op: "erase"; id: string; field: LetterField; from: number; to: number }
  | { op: "format"; id: string; field: "audio" | "visual"; from: number; to: number; key: string; on: boolean }
  | { op: "field"; id: string; key: string; value: string }
  | { op: "split"; id: string; at: number; created: string }
  | { op: "insert"; before: string; id: string; text: string }
  | { op: "join" | "unjoin"; id: string }
  | { op: "delete"; rows: string[] }
  | { op: "heading"; above: string; id: string; text: string }
  | { op: "removeHeading" | "restoreHeading"; id: string }
  | { op: "move"; drop: RankDrop }
  | { op: "undo" | "redo" };
export type Step = { by: number; cmd: Cmd } | { from: number; to: number } | { open: number; from: number };

const FIELD: Record<"audio" | "visual", NativeField> = { audio: "audioText", visual: "visualText" };
const plain = (delta: readonly NativeDeltaItem[]): string => delta.map(item => typeof item.insert === "string" ? item.insert : "").join("");

export interface Shown { audio: Map<string, string>; visual: Map<string, string>; names: Map<string, string>; hidden: Map<string, string>; rows: Map<string, string[]>; order: string[] }

export function shown(replica: ChosenReplica): Shown {
  const result: Shown = { audio: new Map(), visual: new Map(), names: new Map(), hidden: new Map(), rows: new Map(), order: [] };
  for (const entry of replica.outline()) {
    if (entry.kind === "heading") { result.names.set(entry.id, plain(entry.name)); result.order.push(`#${entry.id}`); continue; }
    result.rows.set(entry.row.id, entry.row.members);
    result.order.push(entry.row.id);
    let at = 0;
    const audio = plain(entry.row.audio);
    for (const part of entry.row.parts.audio) { if (part.beat !== null) result.audio.set(part.beat, audio.slice(at, at + part.length)); at += part.length; }
    for (const member of entry.row.members) if (member !== STRAY_ROW) result.visual.set(member, replica.visuals.get(member)?.toString() ?? "");
  }
  for (const heading of replica.headingRecovery()) result.hidden.set(heading.id, plain(heading.name));
  return result;
}

export const rowOf = (view: Shown, beat: string): string | undefined => [...view.rows].find(([, members]) => members.includes(beat))?.[0];
export function sceneMap(view: Shown): Map<string, string | null> {
  const scenes = new Map<string, string | null>();
  let scene: string | null = null;
  for (const id of view.order) {
    if (id.startsWith("#")) scene = id.slice(1);
    else for (const member of view.rows.get(id) ?? []) scenes.set(member, scene);
  }
  return scenes;
}
const textOf = (view: Shown, field: LetterField, id: string): string => (field === "name" ? view.names.get(id) : field === "audio" ? view.audio.get(id) : view.visual.get(id)) ?? "";
export const everything = (view: Shown): string => [...view.audio.values(), ...view.visual.values(), ...view.names.values(), ...view.hidden.values()].join("");

export function perform(replica: ChosenReplica, cmd: Cmd): boolean | undefined {
  let pressed: boolean | undefined;
  switch (cmd.op) {
    case "type":
      if (cmd.field === "name") replica.typeHeading(cmd.id, cmd.at, cmd.text);
      else replica.splice(cmd.id, FIELD[cmd.field], cmd.at, cmd.at, [{ text: cmd.text, marks: {} }]);
      break;
    case "erase":
      if (cmd.field === "name") replica.deleteHeadingText(cmd.id, cmd.from, cmd.to);
      else replica.splice(cmd.id, FIELD[cmd.field], cmd.from, cmd.to, []);
      break;
    case "format": replica.format(cmd.id, FIELD[cmd.field], cmd.from, cmd.to, { [cmd.key]: cmd.on ? true : null }); break;
    case "field": replica.setField(cmd.id, cmd.key, cmd.value); break;
    case "split": replica.split(cmd.id, cmd.at, cmd.created, {}); break;
    case "insert": replica.insertBeat(cmd.before, cmd.id, cmd.text); break;
    case "join": if (!joinUp(replica, cmd.id)) throw new Error(`Nothing above ${cmd.id}`); break;
    case "unjoin": replica.unjoin(cmd.id); break;
    case "delete": {
      const rows = replica.rows();
      replica.deleteRows([...new Set(cmd.rows.map(id => rows.find(row => row.members.includes(id))?.id ?? id))]);
      break;
    }
    case "heading": replica.createHeading(cmd.above, cmd.id, cmd.text); break;
    case "removeHeading": replica.removeHeading(cmd.id); break;
    case "restoreHeading": replica.restoreHeading(cmd.id); break;
    case "move": replica.drop(cmd.drop); break;
    case "undo": pressed = replica.undoPress(); break;
    case "redo": pressed = replica.redoPress(); break;
  }
  replica.changes();
  return pressed;
}

function marksOf(replica: ChosenReplica, id: string, field: "audio" | "visual"): Record<string, unknown>[] {
  const units = (items: NativeDeltaItem[]): Record<string, unknown>[] => items.flatMap(item => Array.from({ length: typeof item.insert === "string" ? item.insert.length : 1 }, () => item.attributes ?? {}));
  if (field === "visual") return units(replica.visuals.get(id)?.toDelta() as NativeDeltaItem[] ?? []);
  return replica.spansOf(id, FIELD[field]).flatMap(span => units(span.text.toDelta() as NativeDeltaItem[]).slice(span.start, span.end));
}

export function keysIn(replica: ChosenReplica, id: string, field: "audio" | "visual"): Set<string> {
  return new Set(marksOf(replica, id, field).flatMap(attributes => Object.keys(attributes)));
}

// why: the order a single person's drop asks for, computed from the order they saw; removed headings are not in it
export function droppedOrder(before: readonly string[], drop: RankDrop): string[] {
  const at = (id: string): number => before.indexOf(id);
  let selection: string[];
  if (drop.unit === "scene") {
    const start = at(`#${drop.first}`), rest = before.slice(start + 1), end = rest.findIndex(id => id.startsWith("#"));
    selection = [`#${drop.first}`, ...end < 0 ? rest : rest.slice(0, end)];
  } else selection = before.slice(at(drop.first), at(drop.last ?? drop.first) + 1);
  const remaining = before.filter(id => !selection.includes(id));
  let place: number;
  if (drop.intoScene !== undefined) place = remaining.indexOf(`#${drop.intoScene}`) + 1;
  else if (drop.target === null) place = 0;
  else {
    const target = drop.unit === "scene" ? `#${drop.target}` : drop.target;
    place = remaining.indexOf(target) + (drop.after ? 1 : 0);
    if (drop.unit === "scene" && drop.after) { const rest = remaining.slice(place), end = rest.findIndex(id => id.startsWith("#")); place += end < 0 ? rest.length : end; }
  }
  remaining.splice(place, 0, ...selection);
  return remaining;
}

// why: what a command promises on the copy that ran it, written from the command and that copy's rows before it
// why: a write to the narration-only row first gives it a record, so the row the person typed in now has that id
const claimed = (before: Shown, after: Shown, id: string, created?: string): string =>
  id === STRAY_ROW && !after.rows.has(STRAY_ROW) ? [...after.rows.keys()].find(row => !before.rows.has(row) && row !== created) ?? id : id;

export function promises(cmd: Cmd, before: Shown, after: Shown, replica: ChosenReplica, record: LedgerEvent, storedChanged: boolean,
  keysBefore?: Set<string>, docChanged = storedChanged, keepCutVisuals = false): string[] {
  const problems: string[] = [];
  switch (cmd.op) {
    case "type": {
      const was = textOf(before, cmd.field, cmd.id), now = textOf(after, cmd.field, claimed(before, after, cmd.id));
      if (now !== was.slice(0, cmd.at) + cmd.text + was.slice(cmd.at)) problems.push(`typing ${cmd.text} in ${cmd.field} of ${cmd.id} shows ${now}`);
      break;
    }
    case "erase": {
      const was = textOf(before, cmd.field, cmd.id), now = textOf(after, cmd.field, claimed(before, after, cmd.id));
      if (now !== was.slice(0, cmd.from) + was.slice(cmd.to)) problems.push(`erasing in ${cmd.id} shows ${now}`);
      break;
    }
    case "format": {
      const has = marksOf(replica, cmd.id, cmd.field).slice(cmd.from, cmd.to).map(attributes => Object.entries(attributes).some(([key, value]) => value === true && nativeMarkName(key) === cmd.key));
      if (has.some(value => value !== cmd.on)) problems.push(`format ${cmd.key} ${cmd.on} on ${cmd.id} not applied`);
      if (cmd.on && cmd.key.startsWith("t:") && keysBefore && cmd.to > cmd.from) {
        const fresh = marksOf(replica, cmd.id, cmd.field).slice(cmd.from, cmd.to).map(attributes => Object.keys(attributes).filter(key => attributes[key] === true && !keysBefore.has(key) && nativeMarkName(key) === cmd.key));
        if (!fresh.every(keys => keys.length > 0)) problems.push(`tag ${cmd.key} on ${cmd.id} did not get a key of its own`);
      }
      break;
    }
    case "field": if (replica.beats.get(cmd.id)?.get(cmd.key) !== cmd.value) problems.push(`field ${cmd.key} on ${cmd.id} not set`); break;
    case "split": {
      const was = textOf(before, "audio", cmd.id), first = claimed(before, after, cmd.id, cmd.created);
      const kept = textOf(after, "audio", first), given = textOf(after, "audio", cmd.created);
      const exact = kept === was.slice(0, cmd.at) && given === was.slice(cmd.at);
      // why: a split never copies narration, so inside text a rule shows it can only put the boundary where one fits
      const placed = replica.splitPlacement !== "exact" && kept + given === was;
      const rows = after.order.filter(id => !id.startsWith("#")), firstRow = rowOf(after, first), createdRow = rowOf(after, cmd.created);
      if (createdRow && firstRow && createdRow !== firstRow && rows.indexOf(createdRow) !== rows.indexOf(firstRow) + 1) problems.push(`split-off ${cmd.created} is not shown below ${first}`);
      if (!createdRow || (!exact && !placed)) problems.push(`split of ${cmd.id} at ${cmd.at} shows ${kept} | ${given}`);
      else if (!exact) problems.push(`kind: a split inside rule-read text was placed ${replica.splitPlacement}`);
      if (after.visual.get(cmd.created) !== "") problems.push(`split-off ${cmd.created} has no empty visual cell`);
      // why: rule (e) reads a missing rank only after an undo; a writer always writes one
      if (typeof replica.storedRank("b", cmd.created) !== "string") problems.push(`split-off ${cmd.created} has no rank`);
      break;
    }
    case "insert": if (textOf(after, "audio", cmd.id) !== cmd.text || after.visual.get(cmd.id) !== "") problems.push(`inserted ${cmd.id} not shown`); break;
    case "join": { const row = rowOf(after, cmd.id); if (!row || row === cmd.id) problems.push(`join of ${cmd.id} not shown`); break; }
    case "unjoin": if (rowOf(after, cmd.id) !== cmd.id) problems.push(`unjoin of ${cmd.id} not shown`); break;
    case "delete": {
      for (const beat of record.deletedBeats) if (rowOf(after, beat)) problems.push(`deleted ${beat} still shown`);
      for (const beat of record.deletedBeats) {
        if (beat === STRAY_ROW) continue;
        const record = replica.beats.has(beat), visual = replica.visuals.has(beat);
        if (keepCutVisuals && (!record || !visual)) problems.push(`deleted ${beat} loses its record or visual cell`);
        if (!keepCutVisuals && (record || visual)) problems.push(`deleted ${beat} keeps its record or visual cell`);
      }
      for (const beat of record.deletedBeats) if (boundaries(replica).has(beat)) problems.push(`deleted ${beat} keeps a boundary`);
      const left = everything(after);
      for (const char of [...record.erased, ...record.seenVisual]) if (left.includes(char)) problems.push(`deleted letter ${char} still shown`);
      break;
    }
    case "heading": {
      if (after.names.get(cmd.id) !== cmd.text) problems.push(`heading ${cmd.id} not shown`);
      if (typeof replica.storedRank("h", cmd.id) !== "string") problems.push(`heading ${cmd.id} has no rank`);
      const expected = [...before.order], row = rowOf(before, cmd.above) ?? cmd.above;
      expected.splice(expected.indexOf(row), 0, `#${cmd.id}`);
      if (!equal(after.order, expected)) problems.push(`heading ${cmd.id} not directly above ${row}: ${after.order.join(" ")}`);
      break;
    }
    case "removeHeading": if (after.names.has(cmd.id) || !after.hidden.has(cmd.id)) problems.push(`heading ${cmd.id} not removed`); break;
    case "restoreHeading": if (!after.names.has(cmd.id)) problems.push(`heading ${cmd.id} not restored`); break;
    case "move": {
      const expected = droppedOrder(before.order.filter(id => id !== STRAY_ROW), cmd.drop), actual = after.order.filter(id => id !== STRAY_ROW);
      if (equal(actual, expected)) break;
      const merged = expected.filter(id => !actual.includes(id));
      if (merged.length && merged.every(id => rowOf(after, id)) && equal(expected.filter(id => actual.includes(id)), actual)) problems.push(`kind: a move made a join count again`);
      else problems.push(`move expected ${expected.join(" ")}, got ${actual.join(" ")}`);
      break;
    }
    case "undo": case "redo":
      // why: an undo may take back formatting on letters someone else has since erased; Yjs counts that as a change
      if ((record.reverts !== null || record.redoes !== null) && !storedChanged) problems.push(docChanged ? `kind: ${cmd.op} press changed only formatting no one can see` : `${cmd.op} popped an item but changed nothing stored`);
      break;
  }
  return problems;
}

// why: the stored narration letters by identity; a split must leave every one where it was
export function letterItems(replica: ChosenReplica): string[] {
  const found: string[] = [];
  for (const record of replica.segments.values()) {
    const text = record.get("text");
    if (text instanceof Y.Text) for (let item = text._start; item; item = item.right) {
      if (!item.deleted && item.content instanceof Y.ContentString) for (let at = 0; at < item.length; at++) found.push(`${item.id.client}:${item.id.clock + at}`);
    }
  }
  return found.sort();
}

function boundaries(replica: ChosenReplica): Set<string> {
  const found = new Set<string>();
  for (const record of replica.segments.values()) {
    const head = record.get("head"), text = record.get("text");
    if (head && typeof head === "object" && "b" in head) found.add(String(head.b));
    if (text instanceof Y.Text) for (const item of text.toDelta() as NativeDeltaItem[]) if (typeof item.insert === "object" && "b" in item.insert) found.add(String(item.insert.b));
  }
  return found;
}

export type Kinds = Record<string, number>;
export interface TagAsk { index: number; by: number; name: string; on: boolean; ids: string[]; seen: ReadonlySet<number>; beat: string }
export interface TagLoss { index: number; name: string; letters: number; missing: number; concurrent: string[]; cause: string }
export interface TagOutcome { requested: number; kept: number; lost: TagLoss[] }
export interface PlayResult {
  never: string[]; local: string[]; kinds: Kinds; timing: Record<string, { sameMoment: number; offline: number }>; lines: string[]; uses: Record<string, number>; events: number; tags: TagOutcome;
  drift: { place: number; scene: number }; cells: Record<string, string>;
  press?: PressCount; calls?: Record<number, string[]>; stored?: string; threw?: string[]; presses?: PressRecord[];
}
// why: what one undo or redo press returned, how it changed the presser's two stacks, and whether the document changed
export interface PressRecord { step: number; op: "undo" | "redo"; returned: boolean | undefined; undo: [number, number]; redo: [number, number]; same: boolean }
// why: E15's checks on undo and redo presses, kept apart so E11's recorded counts stay as they were
export interface PressCount { presses: number; scene: number; drift: number; seenLater: number; problems: string[] }
export interface ControlCount { used: number; effective: number; failed: number; throws: number; coverage: number; storageOnly: number; checkThrows?: number }
export type Controls = Map<string, ControlCount>;

interface Copy { replica: ChosenReplica; seen: Set<number>; client: number; known: Set<number>; initial: Uint8Array; journal: ({ update: Uint8Array } | { cmd: Cmd })[] }

// why: E15 adds checks one command's rows cannot make, such as a rank's storage shape; it reads before and after
export interface StorageCheck { snap: (replica: ChosenReplica) => unknown; check: (before: unknown, replica: ChosenReplica, cmd: Cmd) => string[] }

export interface PlayOptions {
  spec: Spec; steps: readonly Step[]; writers: number; mode: Mode; seed: number; rules?: NativeRules; names?: ChosenNames; controls?: Controls; window?: number;
  checkLetters?: boolean; make?: MakeReplica; storage?: StorageCheck; ownCalls?: boolean;
  pressChecks?: boolean; mute?: { step: number; call: number }; listCalls?: boolean;
  // why: E15 records a command that throws after it wrote, then keeps playing; by default a throw ends the play
  continueOnThrow?: boolean; logPresses?: boolean;
  keepCutVisuals?: boolean;
  skip?: (replica: ChosenReplica, cmd: Cmd, index: number) => boolean;
  inspect?: (replica: ChosenReplica, step: number) => void;
  settled?: (replica: ChosenReplica, events: readonly LedgerEvent[], ledger: ReturnType<typeof settle>) => void;
}

export function play(options: PlayOptions): PlayResult {
  const { spec, steps, writers, mode, rules = ALL_RULES, window = 3, names = "inline", make } = options, bytes = seed(spec, rules, names, make);
  const load = (encoded: Uint8Array, client: number, ...rest: [NativeRules, ChosenNames]): ChosenReplica => loadCopy(encoded, client, ...rest, make);
  const result: PlayResult = {
    never: [], local: [], kinds: {}, timing: {}, lines: [], uses: {}, events: 0, tags: { requested: 0, kept: 0, lost: [] }, drift: { place: 0, scene: 0 }, cells: {}
  };
  const copies: (Copy | null)[] = [], log: Uint8Array[] = [], events: LedgerEvent[] = [], syncs: number[] = [], asks: TagAsk[] = [], made = new Map<number, Cmd>();
  const carried = new Map<number, Set<string>>();
  const undoStacks = new Map<number, number[]>(), redoStacks = new Map<number, number[]>();
  // why: like a provider, every update a copy makes is relayed, including the formatting clean-up Yjs writes on receipt
  const open = (client: number, encoded: Uint8Array, known: Iterable<number> = []): Copy => {
    const copy: Copy = { replica: load(encoded, client, rules, names), seen: new Set(), client, known: new Set(known), initial: encoded, journal: [] };
    copy.replica.doc.on("update", (update: Uint8Array, origin: unknown) => { if (origin !== "remote") copy.known.add(log.push(update) - 1); });
    return copy;
  };
  for (let index = 0; index < writers; index++) copies.push(steps.some(step => "open" in step && step.open === index) ? null : open(index + 1, bytes));
  const waiting = open(801, bytes);
  const initial = shown(waiting.replica), letters: { char: string; field: LetterField; owner: string }[] = [];
  for (const [beat, value] of initial.audio) for (const char of value) letters.push({ char, field: "audio", owner: beat });
  for (const [beat, value] of initial.visual) for (const char of value) letters.push({ char, field: "visual", owner: beat });
  for (const [heading, value] of [...initial.names, ...initial.hidden]) for (const char of value) letters.push({ char, field: "name", owner: heading });
  const send = (from: Copy, to: Copy, index: number): void => {
    const missing = [...from.known].filter(id => !to.known.has(id)).sort((a, b) => a - b);
    for (const id of missing) to.known.add(id);
    if (mode === "state") {
      const update = Y.encodeStateAsUpdate(from.replica.doc, Y.encodeStateVector(to.replica.doc));
      to.journal.push({ update });
      Y.applyUpdate(to.replica.doc, update, "remote");
    } else {
      const updates = missing.flatMap(id => log[id] ?? []);
      if (options.controls) for (const update of updates) to.journal.push({ update });
      deliver(to.replica, updates, mode, options.seed + index);
    }
    for (const event of from.seen) to.seen.add(event);
    to.replica.changes();
    options.inspect?.(to.replica, index);
    syncs.push(index);
  };
  const need = (index: number): Copy => { const copy = copies[index]; if (!copy) throw new Error(`Copy ${index} not open`); return copy; };
  let stepIndex = -1;
  try {
    for (const [index, step] of steps.entries()) {
      stepIndex = index;
      if ("open" in step) {
        const source = need(step.from), copy = open(step.open + 1, source.replica.encode(), source.known);
        for (const event of source.seen) copy.seen.add(event);
        copies[step.open] = copy;
        continue;
      }
      if ("from" in step) { send(need(step.from), need(step.to), index); continue; }
      const copy = need(step.by), { replica } = copy, cmd = step.cmd, before = shown(replica), stylesBefore = readStyles(replica);
      if (options.skip?.(replica, cmd, index)) continue;
      const record: LedgerEvent = { index, by: step.by, op: cmd.op, seen: new Set(copy.seen), typed: [], erased: [], deletedBeats: [], seenVisual: [], createdBeats: [], createdSegment: false, createdHeading: null, fieldSet: null, reverts: null, redoes: null, skipped: [] };
      if (cmd.op === "type") for (const char of cmd.text) record.typed.push({ char, field: cmd.field, owner: cmd.id });
      if (cmd.op === "erase") record.erased = [...textOf(before, cmd.field, cmd.id).slice(cmd.from, cmd.to)];
      if (cmd.op === "delete") for (const row of new Set(cmd.rows.map(id => rowOf(before, id) ?? id))) for (const member of before.rows.get(row) ?? []) {
        record.deletedBeats.push(member);
        record.erased.push(...before.audio.get(member) ?? "");
        record.seenVisual.push(...before.visual.get(member) ?? "");
      }
      if (cmd.op === "split") record.createdBeats = [cmd.created];
      if (cmd.op === "insert") {
        record.createdBeats = [cmd.id]; record.createdSegment = true;
        for (const char of cmd.text) record.typed.push({ char, field: "audio", owner: cmd.id });
      }
      if (cmd.op === "field") record.fieldSet = { beat: cmd.id, key: cmd.key };
      if (cmd.op === "heading") record.createdHeading = { id: cmd.id, standalone: names === "cells" || replica.block(cmd.above).start === 0 };
      made.set(index, cmd);
      if (cmd.op === "move") carried.set(index, carriedBy(cmd.drop, before));
      if (cmd.op === "format" && cmd.field === "audio" && cmd.key.startsWith("t:")) {
        asks.push({ index, by: step.by, name: cmd.key, on: cmd.on, ids: [...textOf(before, "audio", cmd.id).slice(cmd.from, cmd.to)], seen: new Set(copy.seen), beat: cmd.id });
      }
      const stack = undoStacks.get(step.by) ?? [], redo = redoStacks.get(step.by) ?? [];
      undoStacks.set(step.by, stack); redoStacks.set(step.by, redo);
      const depth = replica.undo.undoStack.length, redoDepth = replica.undo.redoStack.length, saved = options.controls ? replica.encode() : null;
      const keysBefore = cmd.op === "format" ? keysIn(replica, cmd.id, cmd.field) : undefined, snapshot = Y.snapshot(replica.doc);
      const itemsBefore = cmd.op === "split" ? letterItems(replica) : null;
      const rankless = [...replica.beats.keys()].filter(id => typeof replica.storedRank("b", id) !== "string"), held = options.storage?.snap(replica);
      const muted = options.mute?.step === index ? options.mute.call : -1;
      let returned: boolean | undefined;
      const run = (): void => {
        try { returned = perform(replica, cmd); } catch (error) {
          if (!options.continueOnThrow) throw error;
          replica.changes();
          (result.threw ??= []).push(`step ${index} ${cmd.op}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      const calls = options.controls || options.listCalls || muted >= 0 ? watch(replica, run, muted, options.ownCalls || muted >= 0 || options.listCalls) : (run(), []);
      if (options.listCalls) (result.calls ??= {})[index] = calls;
      if (options.logPresses && (cmd.op === "undo" || cmd.op === "redo")) (result.presses ??= []).push({
        step: index, op: cmd.op, returned, undo: [depth, replica.undo.undoStack.length], redo: [redoDepth, replica.undo.redoStack.length], same: Y.equalSnapshots(snapshot, Y.snapshot(replica.doc))
      });
      for (const problem of options.storage?.check(held, replica, cmd) ?? []) result.local.push(`step ${index} ${cmd.op}: ${problem}`);
      const after = shown(replica), stylesAfter = readStyles(replica), storedChanged = !equal(stylesBefore, stylesAfter);
      options.inspect?.(replica, index);
      if (itemsBefore && !equal(itemsBefore, letterItems(replica))) result.local.push(`step ${index} split: narration letters were deleted and written again`);
      if (cmd.op === "undo") {
        const popped = depth - replica.undo.undoStack.length, performed = replica.undo.redoStack.length > redoDepth;
        if (popped > 0) {
          const taken = stack.splice(stack.length - popped, popped).reverse();
          record.reverts = performed ? taken[taken.length - 1] ?? null : null;
          record.skipped = performed ? taken.slice(0, -1) : taken;
          if (performed) redo.push(index);
          if (record.skipped.length) bump(result, "undo press passed over an item that no longer changed anything", 1);
          const moves = [record.reverts, ...record.skipped].some(item => events.find(event => event.index === item)?.op === "move");
          if (moves && equal(before.order, after.order)) bump(result, "undo of a move did nothing visible", 1);
        }
      } else if (cmd.op === "redo") {
        if (redoDepth > replica.undo.redoStack.length) { record.redoes = redo.pop() ?? null; stack.push(index); }
      } else if (replica.undo.undoStack.length > depth) { stack.push(index); redo.length = 0; }
      events.push(record);
      copy.seen.add(index);
      if (events.length === 1) send(copy, waiting, index);
      const problems = neverAcceptable(reachability(replica));
      if (problems.length) result.never.push(`step ${index} ${cmd.op}: ${problems.join("; ")}`);
      const broken = promises(cmd, before, after, replica, record, storedChanged, keysBefore,
        !Y.equalSnapshots(snapshot, Y.snapshot(replica.doc)), options.keepCutVisuals);
      for (const kind of broken.filter(problem => problem.startsWith("kind: "))) bump(result, kind.slice(6), 1);
      const real = broken.filter(problem => !problem.startsWith("kind: "));
      if (real.length) result.local.push(`step ${index} ${cmd.op}: ${real.join("; ")}`);
      drift(result, cmd, before, after, rankless);
      if (options.pressChecks) pressCheck(result.press ??= { presses: 0, scene: 0, drift: 0, seenLater: 0, problems: [] }, index, cmd, record, events, made, carried, before, after);
      if (["type", "erase", "format", "field", "split", "join", "unjoin", "delete"].includes(cmd.op)) {
        const was = sceneMap(before), changed = [...sceneMap(after)].filter(([beat, scene]) => was.has(beat) && was.get(beat) !== scene).map(([beat]) => beat);
        if (changed.length) result.never.push(`step ${index} ${cmd.op}: beats ${changed.join(",")} changed scene with one person working`);
      }
      if (options.controls && saved) {
        const journal = [...copy.journal];
        const rebuild = cmd.op === "undo" || cmd.op === "redo" ? (): ChosenReplica => {
          const replica = load(copy.initial, copy.client, rules, names);
          for (const entry of journal) { if ("cmd" in entry) perform(replica, entry.cmd); else Y.applyUpdate(replica.doc, entry.update, "remote"); }
          replica.changes();
          return replica;
        } : (): ChosenReplica => load(saved, copy.client + 9000, rules, names);
        control(options.controls, rebuild, cmd, calls, before, record, stylesBefore, options.storage, options.ownCalls);
      }
      if (options.controls) copy.journal.push({ cmd });
    }
    stepIndex = -1;
    const live = copies.filter((copy): copy is Copy => copy !== null), hub = live[0];
    if (!hub) throw new Error("No copy");
    // why: a provider keeps relaying until nothing is new, which includes the clean-up a copy writes on receipt
    const everyone = [...live, waiting];
    for (let round = 0; round < 10 && everyone.some(copy => everyone.some(other => [...other.known].some(id => !copy.known.has(id)))); round++) {
      for (const copy of everyone.slice(1)) send(copy, hub, steps.length);
      for (const copy of everyone.slice(1)) send(hub, copy, steps.length);
    }
    const late = open(802, hub.replica.encode(), hub.known);
    try {
      const styles = readStyles(hub.replica), lines = outline(hub.replica, true);
      for (const copy of [...live.slice(1), waiting, late]) {
        options.inspect?.(copy.replica, steps.length);
        if (!equal(readStyles(copy.replica), styles) || !equal(outline(copy.replica, true), lines)) result.never.push(`copy ${copy.client} disagrees after everything is delivered`);
        result.never.push(...neverAcceptable(reachability(copy.replica)).map(problem => `settled on ${copy.client}: ${problem}`));
      }
      result.lines = lines;
      if (options.listCalls) result.stored = JSON.stringify(styles);
      result.never.push(...neverAcceptable(reachability(hub.replica)).map(problem => `settled: ${problem}`));
      result.uses = { ...hub.replica.ruleUse(), rank: everyone.reduce((sum, copy) => sum + copy.replica.ruleUse().rank, 0) };
      result.events = events.length;
      const settledView = shown(hub.replica);
      result.cells = Object.fromEntries([...settledView.audio, ...[...settledView.names].map(([id, name]) => [`#${id}`, name] as const)]);
      crossings(result, settledView, events, made, syncs, window);
      const keys = shownKeys(hub.replica);
      result.tags = lostTags(asks, events, char => keys.get(char)?.held, chars => chars.some(char => (keys.get(char)?.count ?? 0) > 1));
      if (options.checkLetters !== false || options.settled) {
        const ledger = settle(events, letters, [...initial.rows.values()].flat(), options.keepCutVisuals);
        if (options.checkLetters !== false) judge(result, hub.replica, ledger, events, syncs, window, options.keepCutVisuals);
        options.settled?.(hub.replica, events, ledger);
      }
    } finally { late.replica.destroy(); }
  } catch (error) {
    result.never.push(`${stepIndex >= 0 ? `step ${stepIndex}` : "settling"} threw: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    for (const copy of [...copies, waiting]) copy?.replica.destroy();
  }
  return result;
}

// why: a beat read by rule (e) has no place of its own; count each time a command that did not ask for it moves that
// beat among the rows that stay, and when that crosses a scene line
function drift(result: PlayResult, cmd: Cmd, before: Shown, after: Shown, rankless: readonly string[]): void {
  if (!rankless.length || cmd.op === "undo" || cmd.op === "redo" || cmd.op === "restoreHeading") return;
  let expected = before.order.filter(id => id !== STRAY_ROW);
  if (cmd.op === "move") expected = droppedOrder(expected, cmd.drop);
  if (cmd.op === "heading") {
    const at = expected.indexOf(rowOf(before, cmd.above) ?? cmd.above);
    if (at < 0) return;
    expected = [...expected.slice(0, at), `#${cmd.id}`, ...expected.slice(at)];
  }
  const actual = after.order.filter(id => id !== STRAY_ROW), wanted = expected.filter(id => actual.includes(id)), got = actual.filter(id => wanted.includes(id));
  if (equal(wanted, got)) return;
  const scene = (list: readonly string[], row: string): string | null => list.slice(0, list.indexOf(row)).findLast(id => id.startsWith("#")) ?? null;
  for (const beat of rankless) {
    const row = rowOf(before, beat);
    if (!row || row !== rowOf(after, beat) || !got.includes(row) || !equal(wanted.filter(id => id !== row), got.filter(id => id !== row))) continue;
    result.drift.place++;
    if (scene(wanted, row) !== scene(got, row)) result.drift.scene++;
  }
}

// why: E15: a press takes back or puts back one command; rows that command did not place keep their scene and their
// order among themselves, and a press that moves a row or heading someone else moved later, seen, is counted
// why: every beat and heading a move carried, read on the mover's screen: a range's rows and the headings inside it,
// or a scene's heading and its rows
function carriedBy(drop: RankDrop, view: Shown): Set<string> {
  if (drop.unit === "scene") return new Set([`#${drop.first}`, ...[...sceneMap(view)].filter(([, scene]) => scene === drop.first).map(([beat]) => beat)]);
  const from = view.order.indexOf(rowOf(view, drop.first) ?? ""), to = view.order.indexOf(rowOf(view, drop.last ?? drop.first) ?? "");
  return new Set(from < 0 ? [drop.first] : view.order.slice(from, Math.max(from, to) + 1).flatMap(id => id.startsWith("#") ? [id] : view.rows.get(id) ?? [id]));
}

function pressCheck(count: PressCount, index: number, cmd: Cmd, record: LedgerEvent, events: readonly LedgerEvent[], made: ReadonlyMap<number, Cmd>,
  carried: ReadonlyMap<number, ReadonlySet<string>>, before: Shown, after: Shown): void {
  if (cmd.op !== "undo" && cmd.op !== "redo") return;
  const originOf = (at: number | null): number | null => {
    const event = at === null ? undefined : events.find(item => item.index === at), source = at === null ? undefined : made.get(at);
    if (!event || !source) return null;
    return source.op === "undo" ? originOf(event.reverts) : source.op === "redo" ? originOf(event.redoes) : event.index;
  };
  const origin = originOf(cmd.op === "undo" ? record.reverts : record.redoes), source = origin === null ? undefined : made.get(origin);
  if (origin === null || !source) return;
  count.presses++;
  const scenes = [sceneMap(before), sceneMap(after)] as const, beats = new Set<string>(), headings = new Set<string>();
  const rowMembers = (id: string): string[] => [before, after].flatMap(view => view.rows.get(rowOf(view, id) ?? "") ?? [id]);
  // why: a range of rows carries the headings inside it, and with them their scenes
  const span = (first: string, last: string | undefined): string[] => [before, after].flatMap(view => {
    const from = view.order.indexOf(rowOf(view, first) ?? ""), to = view.order.indexOf(rowOf(view, last ?? first) ?? "");
    return from < 0 ? [] : view.order.slice(from, Math.max(from, to) + 1).flatMap(id => id.startsWith("#") ? [id] : view.rows.get(id) ?? []);
  });
  const underHeading = (id: string): void => { headings.add(id); for (const map of scenes) for (const [beat, scene] of map) if (scene === id) beats.add(beat); };
  switch (source.op) {
    case "move":
      if (source.drop.unit === "scene") underHeading(source.drop.first);
      else for (const id of span(source.drop.first, source.drop.last ?? undefined)) if (id.startsWith("#")) underHeading(id.slice(1)); else beats.add(id);
      break;
    case "delete": for (const id of source.rows) for (const beat of rowMembers(id)) beats.add(beat); break;
    case "split": for (const beat of [...rowMembers(source.id), source.created]) beats.add(beat); break;
    case "join": case "unjoin": for (const beat of rowMembers(source.id)) beats.add(beat); break;
    case "insert": beats.add(source.id); break;
    case "heading": case "removeHeading": case "restoreHeading": underHeading(source.id); break;
    default: break;
  }
  const changed = [...scenes[1]].filter(([beat, scene]) => scenes[0].has(beat) && scenes[0].get(beat) !== scene && !beats.has(beat)
    && !headings.has(scene ?? "") && !headings.has(scenes[0].get(beat) ?? "")).map(([beat]) => beat);
  if (changed.length) { count.scene++; count.problems.push(`step ${index} ${cmd.op}: beats ${changed.join(",")} changed scene with one person working`); }
  const placed = (view: Shown, id: string): boolean => id.startsWith("#") ? headings.has(id.slice(1)) : (view.rows.get(id) ?? []).some(beat => beats.has(beat));
  const kept = (view: Shown, other: Shown): string[] => view.order.filter(id => other.order.includes(id) && !placed(before, id) && !placed(after, id));
  const was = kept(before, after), now = kept(after, before);
  if (!equal(was, now)) { count.drift++; count.problems.push(`step ${index} ${cmd.op}: rows the pressed command did not place changed order: ${was.join(",")} became ${now.join(",")}`); }
  if (source.op !== "move") return;
  const item = source.drop.unit === "scene" ? `#${source.drop.first}` : source.drop.first;
  const place = (view: Shown): string | null => { const id = item.startsWith("#") ? item : rowOf(view, item) ?? ""; const at = view.order.indexOf(id); return at < 0 ? null : view.order[at - 1] ?? "top"; };
  if (place(before) === null || place(before) === place(after)) return;
  // why: a later placement is a move that carried the same row or heading (alone, in a range or in its scene), or a
  // redo of one; an undo goes back to an earlier one
  const sameItem = (at: number | null): boolean => at !== null && made.get(at)?.op === "move" && (carried.get(at)?.has(item) ?? false);
  const later = events.find(event => event.index > origin && event.by !== record.by && record.seen.has(event.index) && (made.get(event.index)?.op === "move"
    ? sameItem(event.index) && standing(event.index, events) : event.redoes !== null && sameItem(originOf(event.redoes))));
  if (later) { count.seenLater++; count.problems.push(`step ${index} ${cmd.op}: moved ${item}, which step ${later.index} by another person moved later and the presser had seen`); }
}

// why: two accepted outcomes of moves made at the same moment as another command, read from the settled rows
function crossings(result: PlayResult, view: Shown, events: readonly LedgerEvent[], made: ReadonlyMap<number, Cmd>, syncs: readonly number[], window: number): void {
  const apart = (one: LedgerEvent, other: LedgerEvent): boolean => one.by !== other.by && !one.seen.has(other.index) && !other.seen.has(one.index);
  const row = (id: string): string => rowOf(view, id) ?? id;
  const moves = events.filter(event => { const cmd = made.get(event.index); return cmd?.op === "move" && cmd.drop.unit !== "scene" && standing(event.index, events); });
  // why: the settled rows answer for the pair only when no other command moved, split, joined or headed those rows
  const touches = (cmd: Cmd | undefined, ids: ReadonlySet<string>): boolean => {
    if (!cmd) return false;
    if (cmd.op === "move") return cmd.drop.unit === "scene" || [cmd.drop.first, cmd.drop.last, cmd.drop.target].some(id => id !== undefined && id !== null && ids.has(id));
    return (cmd.op === "split" || cmd.op === "join" || cmd.op === "unjoin") && ids.has(cmd.id);
  };
  const order = view.order.filter(id => !id.startsWith("#"));
  const quiet = (pair: readonly number[], ids: ReadonlySet<string>): boolean => events.every(event => pair.includes(event.index) || !touches(made.get(event.index), ids));
  for (const event of events) {
    const cmd = made.get(event.index);
    if (cmd?.op !== "split" || !standing(event.index, events) || !rowOf(view, cmd.id) || !rowOf(view, cmd.created)) continue;
    const first = order.indexOf(row(cmd.id)), second = order.indexOf(row(cmd.created));
    if (first < 0 || second < 0 || row(cmd.id) === row(cmd.created) || second === first + 1) continue;
    const mover = moves.find(move => { const drop = made.get(move.index); return drop?.op === "move" && apart(move, event) && (drop.drop.first === cmd.id || drop.drop.last === cmd.id); });
    if (mover && quiet([event.index, mover.index], new Set([cmd.id, cmd.created]))) bump(result, "a split at the same moment as a move left the second half at the old place", 1, timingOf([event.index, mover.index], syncs, window));
  }
  for (const [at, one] of moves.entries()) for (const other of moves.slice(at + 1)) {
    const a = made.get(one.index), b = made.get(other.index);
    if (a?.op !== "move" || b?.op !== "move" || !apart(one, other) || !a.drop.target || !b.drop.target) continue;
    if (a.drop.target !== b.drop.first && b.drop.target !== a.drop.first) continue;
    const ids = new Set([a.drop.first, a.drop.target, b.drop.first, b.drop.target, a.drop.last, b.drop.last].filter((id): id is string => typeof id === "string"));
    if (!quiet([one.index, other.index], ids)) continue;
    const met = (drop: RankDrop): boolean => {
      const place = order.indexOf(row(drop.first)), target = drop.target ? order.indexOf(row(drop.target)) : -1;
      return place >= 0 && target >= 0 && place === target + (drop.after ? 1 : -1);
    };
    if (!met(a.drop) && !met(b.drop)) bump(result, "two drops onto each other's rows at the same moment; neither request met", 1, timingOf([one.index, other.index], syncs, window));
  }
}

// why: every letter in these histories is unique, so a requested tag is judged on the narration letters the rows
// show, whichever stored item now carries each one
function shownKeys(replica: ChosenReplica): Map<string, { held: Set<string>; count: number }> {
  const keys = new Map<string, { held: Set<string>; count: number }>();
  for (const entry of replica.outline()) {
    if (entry.kind !== "row") continue;
    for (const item of entry.row.audio) {
      if (typeof item.insert !== "string") continue;
      const held = new Set(Object.entries(item.attributes ?? {}).filter(([, value]) => value === true).map(([key]) => key));
      for (const char of item.insert) {
        const known = keys.get(char);
        // why: a letter shown twice keeps a tag only if both places carry it
        keys.set(char, known ? { held: new Set([...known.held].filter(key => held.has(key))), count: known.count + 1 } : { held, count: 1 });
      }
    }
  }
  return keys;
}

// why: whether a command's effect stands at the end: an undo that reverted it takes it back, a redo of that undo
// puts it back
export function standing(index: number, events: readonly LedgerEvent[]): boolean {
  let on = true;
  const forms = new Set([index]), undos = new Set<number>();
  for (const event of events) {
    if (event.reverts !== null && forms.has(event.reverts)) { on = false; undos.add(event.index); }
    else if (event.redoes !== null && undos.has(event.redoes)) { on = true; forms.add(event.index); }
  }
  return on;
}

// why: a requested tag is lost when a letter it was put on is still shown without it, and no standing untag of that
// tag name, made after seeing the request, covered that letter
export function lostTags(asks: readonly TagAsk[], events: readonly LedgerEvent[], keysOf: (id: string) => ReadonlySet<string> | undefined,
  copies?: (chars: readonly string[]) => boolean): TagOutcome {
  const outcome: TagOutcome = { requested: 0, kept: 0, lost: [] };
  for (const ask of asks) {
    if (!ask.on || !ask.ids.length) continue;
    outcome.requested++;
    if (!standing(ask.index, events)) continue;
    const alive = ask.ids.filter(id => keysOf(id) !== undefined);
    const removed = (id: string): boolean => asks.some(other => !other.on && other.name === ask.name && other.seen.has(ask.index)
      && other.ids.includes(id) && standing(other.index, events));
    const missing = alive.filter(id => ![...keysOf(id) ?? []].some(key => nativeMarkName(key) === ask.name) && !removed(id));
    if (!missing.length) { outcome.kept++; continue; }
    const concurrent = events.filter(event => event.by !== ask.by && !ask.seen.has(event.index) && !event.seen.has(ask.index)).map(event => `${event.op} by ${event.by}`);
    const restored = events.some(removal => !ask.seen.has(removal.index) && removal.by !== ask.by
      && (removal.deletedBeats.includes(ask.beat) || missing.some(char => removal.erased.includes(char)))
      && events.some(undo => undo.reverts === removal.index && standing(undo.index, events)));
    const cause = (copies?.(missing) ?? false) ? "a letter shown twice after a double delete and double undo"
      : restored ? "letters deleted and brought back by an undo the tagger had not seen" : "other";
    outcome.lost.push({ index: ask.index, name: ask.name, letters: alive.length, missing: missing.length, concurrent, cause });
  }
  return outcome;
}

export function bump(result: PlayResult, kind: string, by: number, timing?: "sameMoment" | "offline"): void {
  result.kinds[kind] = (result.kinds[kind] ?? 0) + by;
  if (timing) { const slot = result.timing[kind] ??= { sameMoment: 0, offline: 0 }; slot[timing] += by; }
}

// why: two commands count as made at the same moment when they are at most `window` steps apart and no copy synced
// in between; otherwise at least one was made during an offline stretch
function timingOf(indices: readonly number[], syncs: readonly number[], window: number): "sameMoment" | "offline" {
  const real = indices.filter(index => index >= 0), low = Math.min(...real), high = Math.max(...real);
  return high - low <= window && !syncs.some(at => at > low && at < high) ? "sameMoment" : "offline";
}

function judge(result: PlayResult, replica: ChosenReplica, ledger: ReturnType<typeof settle>, events: readonly LedgerEvent[], syncs: readonly number[],
  window: number, keepCutVisuals = false): void {
  const view = shown(replica), places: [string, string][] = [];
  for (const value of view.audio.values()) for (const char of value) places.push([char, "audio"]);
  for (const value of view.visual.values()) for (const char of value) places.push([char, "visual"]);
  if (keepCutVisuals) for (const [id, text] of replica.visuals) if (!view.visual.has(id)) {
    for (const char of text.toString()) places.push([char, "visual"]);
  }
  for (const value of view.names.values()) for (const char of value) places.push([char, "name"]);
  for (const value of view.hidden.values()) for (const char of value) places.push([char, "hidden"]);
  for (const [char, alive] of ledger.alive) {
    const where = places.filter(([item]) => item === char).map(([, place]) => place), n = where.length;
    if (n === 0) result.never.push(`letter ${char} (${alive.field}) is alive by the commands but shown nowhere`);
    else if (alive.field === "audio" && where.every(place => place === "hidden")) result.never.push(`narration ${char} is shown only in a removed heading`);
    else if (n > alive.count || (n < alive.count && alive.revivals < 2)) result.local.push(`letter ${char} shown ${n} times, the commands leave ${alive.count}`);
    if (n > 1 && alive.revivals >= 2) bump(result, "a double delete then a double undo doubles the narration", 1);
    if (n > 0 && alive.field === "audio" && where.includes("name")) bump(result, "unseen narration shown in the heading name above", 1);
    if (n > 0 && alive.field === "name" && where.includes("audio")) bump(result, "a heading name shown as narration after its creation was undone", 1);
  }
  for (const [char, why] of ledger.dead) if (places.some(([item]) => item === char)) result.local.push(`letter ${char} was ${why} but is shown`);
  for (const char of ledger.uncertain) bump(result, places.some(([item]) => item === char) ? "library-decided letter kept" : "library-decided letter gone", 1);
  for (const loss of ledger.losses) bump(result, loss.kind, 1, timingOf(loss.events, syncs, window));
  const rows = new Set([...view.rows.values()].flat());
  for (const beat of rows) if (beat !== STRAY_ROW && typeof replica.storedRank("b", beat) !== "string") bump(result, "a row brought back by an undo after an unseen move is read at its stored place", 1);
  for (const beat of ledger.beatsAlive) if (!rows.has(beat)) result.local.push(`beat ${beat} is alive by the commands but not shown`);
  for (const beat of ledger.beatsDead) if (rows.has(beat)) result.local.push(`beat ${beat} was deleted but is shown`);
  for (const event of events) {
    const set = event.fieldSet;
    if (!set || replica.beats.get(set.beat)?.get(set.key) !== undefined || !standing(event.index, events)) continue;
    const deleter = events.find(other => other.deletedBeats.includes(set.beat) && !other.seen.has(event.index));
    if (deleter) { bump(result, "unseen record change discarded with a deleted beat", 1, timingOf([event.index, deleter.index], syncs, window)); continue; }
    const undo = events.find(other => other.reverts !== null && events.find(item => item.index === other.reverts)?.createdBeats.includes(set.beat));
    if (undo && undo.by !== event.by) {
      const kind = undo.seen.has(event.index) ? "record change removed by a creation undo the creator saw" : "record change in a new beat lost when its creator undoes the creation unseen";
      bump(result, kind, 1, timingOf([event.index, undo.index], syncs, window));
    }
  }
}

function control(counts: Controls, rebuild: () => ChosenReplica, cmd: Cmd, calls: readonly string[], before: Shown, record: LedgerEvent, stylesBefore: unknown, storage?: StorageCheck, ownCalls = false): void {
  const reference = rebuild();
  let normalStyles: unknown, normal: Shown;
  try { perform(reference, cmd); normalStyles = readStyles(reference); normal = shown(reference); } finally { reference.destroy(); }
  for (const [omit, key] of [[-2, `${cmd.op} / whole command`] as const, ...calls.map((name, index) => [index, `${cmd.op} / ${name}`] as const)]) {
    const replica = rebuild(), count = counts.get(key) ?? { used: 0, effective: 0, failed: 0, throws: 0, coverage: 0, storageOnly: 0 };
    counts.set(key, count);
    count.used++;
    try {
      const keysBefore = cmd.op === "format" ? keysIn(replica, cmd.id, cmd.field) : undefined, held = storage?.snap(replica);
      let replay: string[];
      try { replay = watch(replica, () => { perform(replica, cmd); }, omit, ownCalls); } catch { count.effective++; count.throws++; continue; }
      if (omit !== -2 && !equal(replay, calls)) { count.coverage++; continue; }
      const styles = readStyles(replica), after = shown(replica);
      if (equal(styles, normalStyles) && equal(after, normal)) continue;
      count.effective++;
      const problems = [...promises(cmd, before, after, replica, record, !equal(styles, stylesBefore), keysBefore), ...neverAcceptable(reachability(replica)), ...storage?.check(held, replica, cmd) ?? []];
      if (problems.length) count.failed++;
      else if (equal(after, normal)) count.storageOnly++;
    } catch { count.effective++; count.throws++; count.checkThrows = (count.checkThrows ?? 0) + 1; } finally { replica.destroy(); }
  }
}
