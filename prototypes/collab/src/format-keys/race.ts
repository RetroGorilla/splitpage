import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { NativeReplica } from "../native/variant.ts";
import type { NativeDeltaItem } from "../native/variant.ts";
import { makeReplica } from "./keys.ts";
import type { KeyScheme, NormalisingReplica } from "./keys.ts";
import { random } from "./life.ts";
import { marksOfNames, printCell, readCell } from "./model.ts";
import type { ModelChar } from "./model.ts";

export type RaceKind = "b" | "i";
export type RaceDelivery = "updates" | "shuffled" | "state";
export type RaceStep =
  | { op: "add" | "remove"; by: number; kind: RaceKind; first: string; last: string }
  | { op: "delete"; by: number; first: string; last: string }
  | { op: "insert"; by: number; after: string | null; char: string; mode: "inherit" | "plain" | RaceKind }
  | { op: "undo"; by: number }
  | { op: "deliver"; from: number; to: number };
export type RaceWith = "typing" | "formatting" | "unformatting" | "deleting" | "undo" | "own-undo";
export interface RaceRun {
  same: boolean; at: number; copy: string; without: string; with: string; executed: number; normalised: number;
  races: RaceWith[]; convergedWithout: boolean; convergedWith: boolean; ineffective: number; unchecked: number;
}
export interface RaceSummary {
  writers: number; delivery: RaceDelivery; histories: number; executed: number; normalisingCommands: number; keysTurnedOff: number;
  historiesNormalised: number; raced: Record<RaceWith, number>; differing: number; ineffective: number; unchecked: number; divergedWithout: number; divergedWith: number;
  shortest: { steps: RaceStep[]; described: string[]; without: string; with: string; copy: string } | null;
}

const INITIAL = "abcdefgh";
const POOL = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ORDERS = ["forward", "reverse", "twice"] as const;

interface Copy { replica: NativeReplica; log: Uint8Array[] }

class Net {
  readonly copies: Copy[];
  private readonly read = new Map<string, number>();

  constructor(scheme: KeyScheme, writers: number, seed: Uint8Array, patch?: (replica: NativeReplica) => void) {
    this.copies = Array.from({ length: writers }, (_, index) => {
      const replica = makeReplica(scheme, index + 1), log: Uint8Array[] = [];
      patch?.(replica);
      Y.applyUpdate(replica.doc, seed, "remote");
      replica.changes();
      replica.doc.on("update", (update: Uint8Array, origin: unknown) => { if (origin !== "remote") log.push(update); });
      return { replica, log };
    });
  }

  pending(from: number, to: number): number { return (this.copies[from]?.log.length ?? 0) - (this.read.get(`${from}>${to}`) ?? 0); }

  deliver(from: number, to: number, order: (typeof ORDERS)[number]): void {
    const source = this.copies[from] as Copy, target = this.copies[to] as Copy, key = `${from}>${to}`, updates = source.log.slice(this.read.get(key) ?? 0);
    this.read.set(key, source.log.length);
    const sequence = order === "reverse" ? [...updates].reverse() : order === "twice" ? [...updates, ...updates] : updates;
    for (const update of sequence) Y.applyUpdate(target.replica.doc, update, "remote");
    target.replica.changes();
  }

  state(from: number, to: number): void {
    const source = this.copies[from] as Copy, target = this.copies[to] as Copy;
    Y.applyUpdate(target.replica.doc, Y.encodeStateAsUpdate(source.replica.doc, Y.encodeStateVector(target.replica.doc)), "remote");
    target.replica.changes();
  }

  settle(order: (typeof ORDERS)[number]): void {
    for (let round = 0; round < 10; round++) {
      let moved = false;
      for (let from = 0; from < this.copies.length; from++) for (let to = 0; to < this.copies.length; to++) {
        if (from === to || this.pending(from, to) === 0) continue;
        this.deliver(from, to, order); moved = true;
      }
      if (!moved) return;
    }
    throw new Error("The copies never settled");
  }

  late(from: number): NativeReplica {
    const replica = new NativeReplica(800, 0, "act");
    Y.applyUpdate(replica.doc, Y.encodeStateAsUpdate((this.copies[from] as Copy).replica.doc), "remote");
    replica.changes();
    return replica;
  }

  destroy(): void { for (const copy of this.copies) copy.replica.destroy(); }
}

export function readR1(replica: NativeReplica): string { return printCell(readCell(replica.block("R1").delta as NativeDeltaItem[])); }

export function seedState(): Uint8Array {
  const seed = new NativeReplica(900, 0, "act");
  seed.hydrate({ rows: [{ id: "R1", audioText: INITIAL, visualText: "" }] });
  seed.format("R1", "audioText", 1, 4, { b: true });
  seed.format("R1", "audioText", 6, 8, { i: true });
  const state = seed.encode();
  seed.destroy();
  return state;
}

// why: what a command must leave on the copy that made it, from the command and the characters it was made on: a
// format shows on every selected character, an unformat on none, a typed letter sits after its left with its marks
function took(step: RaceStep, before: readonly ModelChar[], replica: NativeReplica): boolean {
  const after = readCell(replica.block("R1").delta as NativeDeltaItem[]), at = (char: string): number => after.findIndex(item => item.ch === char);
  if (step.op === "undo" || step.op === "deliver") return true;
  if (step.op === "insert") {
    const left = step.after === null ? -1 : before.findIndex(item => item.ch === step.after), own = after[at(step.char)];
    const names = step.mode === "inherit" ? [...(before[left]?.names ?? [])] : step.mode === "plain" ? [] : [step.mode];
    return !!own && at(step.char) === left + 1 && own.names.join(",") === [...names].sort().join(",");
  }
  const from = before.findIndex(item => item.ch === step.first), to = before.findIndex(item => item.ch === step.last), selected = before.slice(from, to + 1).map(item => item.ch);
  if (step.op === "delete") return selected.every(char => at(char) < 0) && after.length === before.length - selected.length;
  return selected.every(char => after[at(char)]?.names.includes(step.kind) === (step.op === "add"));
}

interface Issued { id: number; by: number; kind: RaceWith; known: Set<number>; normalising: boolean }

// why: the same commands run on copies without the rule and copies with it; every copy, and copies loaded late from the
// stored state, must show the same formatting on every character in both, after every step and once all is delivered
export function runRace(steps: readonly RaceStep[], writers: number, delivery: RaceDelivery, tamper?: (replica: NativeReplica) => void,
  patch?: (replica: NativeReplica) => void): RaceRun {
  const seed = seedState(), without = new Net("act", writers, seed, patch), withRule = new Net("act+norm", writers, seed, patch);
  const known = Array.from({ length: writers }, () => new Set<number>()), issued: Issued[] = [], own = Array.from({ length: writers }, (): number[] => []);
  const result: RaceRun = { same: true, at: -1, copy: "", without: "", with: "", executed: 0, normalised: 0, races: [], convergedWithout: true, convergedWith: true, ineffective: 0, unchecked: 0 };
  const compare = (at: number, extra: [string, NativeReplica, NativeReplica][] = []): boolean => {
    const pairs: [string, NativeReplica, NativeReplica][] = [...without.copies.map((copy, index): [string, NativeReplica, NativeReplica] => [`copy ${index + 1}`, copy.replica, (withRule.copies[index] as Copy).replica]), ...extra];
    for (const [name, left, right] of pairs) {
      const a = readR1(left), b = readR1(right);
      if (a !== b) { Object.assign(result, { same: false, at, copy: name, without: a, with: b }); return false; }
    }
    return true;
  };
  const used = new Set<string>();
  let stopped = false;
  for (const [position, step] of steps.entries()) {
    if (step.op === "deliver") {
      if (step.from === step.to || step.from >= writers || step.to >= writers) continue;
      for (const net of [without, withRule]) {
        if (delivery === "state") net.state(step.from, step.to); else net.deliver(step.from, step.to, delivery === "shuffled" ? ORDERS[position % 3] as (typeof ORDERS)[number] : "forward");
      }
      for (const id of delivery === "state" ? known[step.from] ?? [] : issued.filter(item => item.by === step.from).map(item => item.id)) known[step.to]?.add(id);
      if (!compare(position)) { stopped = true; break; }
      continue;
    }
    if (step.by >= writers) continue;
    const left = (without.copies[step.by] as Copy).replica, right = (withRule.copies[step.by] as Copy).replica, chars = readCell(left.block("R1").delta);
    const index = (char: string): number => chars.findIndex(item => item.ch === char);
    const before = (right as NormalisingReplica).turnedOff;
    let kind: RaceWith;
    if (step.op === "undo") {
      kind = "undo";
      const top = own[step.by]?.pop();
      if (top !== undefined && issued[top]?.normalising) kind = "own-undo";
      for (const replica of [left, right]) { replica.undo.undo(); replica.changes(); }
    } else if (step.op === "insert") {
      const at = step.after === null ? 0 : index(step.after) + 1;
      if ((step.after !== null && at === 0) || used.has(step.char)) continue;
      used.add(step.char);
      const names = step.mode === "inherit" ? [...(chars[at - 1]?.names ?? [])] : step.mode === "plain" ? [] : [step.mode];
      for (const replica of [left, right]) { replica.splice("R1", "audioText", at, at, [{ text: step.char, marks: marksOfNames(names) }]); replica.changes(); }
      kind = "typing";
    } else {
      const from = index(step.first), to = index(step.last);
      if (from < 0 || to < from) continue;
      for (const replica of [left, right]) {
        if (step.op === "delete") replica.splice("R1", "audioText", from, to + 1, []);
        else replica.format("R1", "audioText", from, to + 1, { [step.kind]: step.op === "add" ? true : null });
        replica.changes();
      }
      kind = step.op === "delete" ? "deleting" : step.op === "add" ? "formatting" : "unformatting";
    }
    // why: two undos that each restore one deleted letter show it twice (the spike's double-restore); a letter is then
    // no longer found by identity, so such commands are counted and not checked for their effect
    if (new Set(chars.map(item => item.ch)).size < chars.length) result.unchecked++;
    else if (!took(step, chars, left) || !took(step, chars, right)) { result.ineffective++; Object.assign(result, { same: false, at: position, copy: `copy ${step.by + 1}, command without its effect` }); stopped = true; break; }
    const normalising = (right as NormalisingReplica).turnedOff > before, id = issued.length;
    if (normalising) result.normalised += (right as NormalisingReplica).turnedOff - before;
    issued.push({ id, by: step.by, kind, known: new Set(known[step.by]), normalising });
    known[step.by]?.add(id);
    if (step.op !== "undo") own[step.by]?.push(id);
    result.executed++;
    if (!compare(position)) { stopped = true; break; }
  }
  if (!stopped) {
    for (const net of [without, withRule]) {
      if (delivery !== "state") net.settle(delivery === "shuffled" ? ORDERS[steps.length % 3] as (typeof ORDERS)[number] : "forward");
      else for (let round = 0; round < 3; round++) for (let from = 0; from < writers; from++) for (let to = 0; to < writers; to++) if (from !== to) net.state(from, to);
    }
    if (tamper) tamper((withRule.copies[0] as Copy).replica);
    const lates: [string, NativeReplica, NativeReplica][] = Array.from({ length: writers }, (_, index) => [`late joiner from copy ${index + 1}`, without.late(index), withRule.late(index)]);
    compare(steps.length, lates);
    for (const [, left, right] of lates) { left.destroy(); right.destroy(); }
    const readings = (net: Net): Set<string> => new Set(net.copies.map(copy => readR1(copy.replica)));
    result.convergedWithout = readings(without).size === 1;
    result.convergedWith = readings(withRule).size === 1;
  }
  const races = new Set<RaceWith>();
  for (const normaliser of issued.filter(item => item.normalising)) for (const other of issued) {
    if (other.by === normaliser.by) { if (other.kind === "own-undo" && other.id > normaliser.id) races.add("own-undo"); continue; }
    const concurrent = other.id > normaliser.id ? !other.known.has(normaliser.id) : !normaliser.known.has(other.id);
    if (concurrent) races.add(other.kind === "own-undo" ? "undo" : other.kind);
  }
  result.races = [...races];
  without.destroy(); withRule.destroy();
  return result;
}

export function generateRace(seed: number, writers: number, length: number): RaceStep[] {
  const next = random(seed), pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;
  const chars = [...INITIAL], steps: RaceStep[] = [];
  let typed = 0;
  const range = (): { first: string; last: string } => {
    const from = Math.floor(next() * chars.length), to = Math.min(chars.length - 1, from + Math.floor(next() * 5));
    return { first: chars[from] as string, last: chars[to] as string };
  };
  while (steps.length < length) {
    const roll = next(), by = Math.floor(next() * writers);
    if (roll < 0.28) steps.push({ op: "add", by, kind: pick(["b", "i"] as const), ...range() });
    else if (roll < 0.38) steps.push({ op: "remove", by, kind: pick(["b", "i"] as const), ...range() });
    else if (roll < 0.45) steps.push({ op: "delete", by, ...range() });
    else if (roll < 0.63) {
      const after = next() < 0.1 ? null : pick(chars), char = POOL.charAt(typed++ % POOL.length);
      steps.push({ op: "insert", by, after, char, mode: pick(["inherit", "inherit", "plain", "b", "i"] as const) });
      chars.splice(after === null ? 0 : chars.indexOf(after) + 1, 0, char);
    } else if (roll < 0.75) steps.push({ op: "undo", by });
    else { const to = Math.floor(next() * writers); if (to !== by) steps.push({ op: "deliver", from: by, to }); }
  }
  return steps;
}

export function describeRace(step: RaceStep): string {
  const who = (index: number): string => String.fromCharCode(65 + index), kind = (value: RaceKind): string => value === "b" ? "bold" : "italic";
  const span = (first: string, last: string): string => first === last ? first : `${first}..${last}`;
  if (step.op === "deliver") return `${who(step.from)}'s changes reach ${who(step.to)}`;
  if (step.op === "undo") return `${who(step.by)} presses undo`;
  if (step.op === "insert") return `${who(step.by)} types ${step.char} ${step.after === null ? "at the start" : `after ${step.after}`}, ${step.mode === "inherit" ? "taking the formatting on its left" : step.mode === "plain" ? "plain" : kind(step.mode)}`;
  if (step.op === "delete") return `${who(step.by)} deletes ${span(step.first, step.last)}`;
  return `${who(step.by)} ${step.op === "add" ? "makes" : "takes"} ${span(step.first, step.last)} ${step.op === "add" ? "" : "out of "}${kind(step.kind)}`.replace("  ", " ");
}

export function shrinkRace(steps: readonly RaceStep[], fails: (candidate: readonly RaceStep[]) => boolean): RaceStep[] {
  let current = [...steps];
  for (let changed = true; changed;) {
    changed = false;
    for (let index = current.length - 1; index >= 0; index--) {
      const candidate = current.filter((_, other) => other !== index);
      if (fails(candidate)) { current = candidate; changed = true; }
    }
  }
  return current;
}

export function surveyRace(writers: number, delivery: RaceDelivery, seeds: number, length: number, first = 1): RaceSummary {
  const raced = { typing: 0, formatting: 0, unformatting: 0, deleting: 0, undo: 0, "own-undo": 0 };
  const summary: RaceSummary = { writers, delivery, histories: seeds, executed: 0, normalisingCommands: 0, keysTurnedOff: 0, historiesNormalised: 0, raced, differing: 0, ineffective: 0, unchecked: 0, divergedWithout: 0, divergedWith: 0, shortest: null };
  for (let seed = first; seed < first + seeds; seed++) {
    const steps = generateRace(seed, writers, length), run = runRace(steps, writers, delivery);
    summary.executed += run.executed; summary.keysTurnedOff += run.normalised;
    if (run.normalised) summary.historiesNormalised++;
    for (const kind of run.races) summary.raced[kind]++;
    if (!run.convergedWithout) summary.divergedWithout++;
    if (!run.convergedWith) summary.divergedWith++;
    if (run.ineffective) summary.ineffective++;
    summary.unchecked += run.unchecked;
    if (run.same) continue;
    summary.differing++;
    if (summary.shortest && summary.shortest.steps.length <= 4) continue;
    const small = shrinkRace(steps, candidate => !runRace(candidate, writers, delivery).same), again = runRace(small, writers, delivery);
    if (!summary.shortest || small.length < summary.shortest.steps.length) summary.shortest = { steps: small, described: small.map(describeRace), without: again.without, with: again.with, copy: again.copy };
  }
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const flag = (name: string, fallback: string): string => process.argv.find(value => value.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
  const seeds = Number(flag("seeds", "2000")), length = Number(flag("length", "20")), output = flag("write", ""), summaries: RaceSummary[] = [];
  for (const [writers, delivery] of [[2, "updates"], [2, "shuffled"], [2, "state"], [3, "updates"], [3, "shuffled"], [3, "state"]] as const) {
    summaries.push(surveyRace(writers, delivery, seeds, length));
    const last = summaries.at(-1);
    process.stderr.write(`${writers} ${delivery}: ${last?.differing} differing of ${seeds}, normalised in ${last?.historiesNormalised}\n`);
  }
  const result = { node: process.version, seeds, length, initial: INITIAL, summaries };
  if (output) writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  else process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
