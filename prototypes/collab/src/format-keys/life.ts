import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { NativeReplica, nativeRuns } from "../native/variant.ts";
import type { NativeDeltaItem, NativeField } from "../native/variant.ts";
import { typingTape } from "../native/tape.ts";
import { collapse, countKeys, quantile, rebuiltDelta } from "./keys.ts";
import type { KeyScheme } from "./keys.ts";
import { readCell, firstDifference } from "./model.ts";
import { CheckFailure, World, cellKey, deltaOf, pasteRuns } from "./world.ts";
import type { Command, Mismatch, Snapshot } from "./world.ts";

export interface Rate { name: string; typed: number; formats: number; pastes: number; overlap: number; undo: number }

// why: the long demo, typed in full, holds 72 formatted runs in 10,424 characters, 61 of them tags. A realistic day
// revises a tenth of the script and makes 20 formatting commands; a heavy one makes ten times as many, half over
// text that already shows the same kind, the pattern where one key per action stacks keys
export const RATES: Record<string, Rate> = {
  realistic: { name: "realistic", typed: 1000, formats: 20, pastes: 2, overlap: 0.2, undo: 0.1 },
  heavy: { name: "heavy", typed: 1000, formats: 200, pastes: 20, overlap: 0.5, undo: 0.1 }
};

const KINDS: readonly [string, number][] = [["tag", 0.4], ["hl", 0.15], ["b", 0.15], ["i", 0.1], ["dir", 0.05], ["cue", 0.05], ["comment", 0.1]];
const WORDS = "the quick camera pans across a quiet harbour while the narrator explains why the light changes".split(" ");

export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DayRow extends Snapshot { day: number; formattingTotal: number; dayFormatting: number; dayFormattingBytes: number; bytesPerFormatting: number; meanBytesPerFormatting: number; mismatches: number }
export interface LifeResult { scheme: KeyScheme; rate: string; writers: number; days: DayRow[]; seconds: number; firstMismatch: Mismatch | null }

type Intent = { kind: "edit"; length: number } | { kind: "format" } | { kind: "paste" };

function words(next: () => number, length: number): string {
  let text = "";
  while (text.length < length) text += WORDS[Math.floor(next() * WORDS.length)] + " ";
  return text.slice(0, length);
}

function runsOf(world: World, key: string, name: string): { from: number; to: number }[] {
  const runs: { from: number; to: number }[] = [];
  world.model.cell(key).forEach((char, index) => {
    if (!char.names.includes(name)) return;
    const last = runs.at(-1);
    if (last && last.to === index) last.to = index + 1; else runs.push({ from: index, to: index + 1 });
  });
  return runs;
}

let commentSerial = 0;

function act(world: World, writer: number, beat: string, intent: Intent, rate: Rate, next: () => number): void {
  const field: NativeField = next() < 0.3 && world.length(beat, "visualText") >= 12 ? "visualText" : "audioText";
  const key = cellKey(beat, field), length = world.length(beat, field), pick = (limit: number): number => Math.floor(next() * limit);
  if (intent.kind === "edit") {
    const at = pick(length + 1), cut = Math.min(length - at, Math.max(0, intent.length + pick(11) - 5));
    if (cut > 0) world.run(writer, { op: "delete", beat, field, from: at, to: at + cut });
    world.run(writer, { op: "type", beat, field, at, text: words(next, intent.length) });
    return;
  }
  if (length < 4) return;
  if (intent.kind === "paste") {
    const from = pick(length - 3), to = Math.min(length, from + 10 + pick(51)), runs = pasteRuns(world.model.cell(key).slice(from, to));
    if (!runs.length) return;
    // why: a paste replaces a selection of its own length, so the script keeps its size over the days as typing does
    const size = runs.reduce((sum, run) => sum + run.text.length, 0), at = pick(length - size + 1);
    world.run(writer, { op: "delete", beat, field, from: at, to: at + size });
    world.run(writer, { op: "paste", beat, field, at, runs });
  } else {
    let roll = next(), kind = KINDS[0]?.[0] as string;
    for (const [name, share] of KINDS) { if (roll < share) { kind = name; break; } roll -= share; }
    let name = kind === "tag" ? `t:t:prop:item-${pick(6)}` : kind;
    if (kind === "comment") {
      const open = [...new Set(world.model.cell(key).flatMap(char => char.names.filter(item => item.startsWith("c:"))))];
      if (open.length && next() < 0.4) {
        const resolved = open[pick(open.length)] as string;
        for (const run of runsOf(world, key, resolved).reverse()) world.run(writer, { op: "format", beat, field, from: run.from, to: run.to, name: resolved, on: false });
        return;
      }
      name = `c:e4-${++commentSerial}`;
    }
    const existing = runsOf(world, key, name);
    let from: number, to: number;
    if (existing.length && next() < rate.overlap) {
      const run = existing[pick(existing.length)] as { from: number; to: number };
      from = Math.max(0, run.from + pick(13) - 6); to = Math.min(length, Math.max(from + 1, run.to + pick(13) - 6));
    } else {
      from = pick(length - 2); to = Math.min(length, from + 3 + pick(38));
    }
    world.run(writer, { op: "format", beat, field, from, to, name, on: !world.model.throughout(key, from, to, name) });
  }
  if (next() < rate.undo) world.run(writer, { op: "undo" });
}

// why: writers work at the same time on different beats and see each other's work between rounds
function phase(world: World, intents: Intent[], rate: Rate, next: () => number, rounds = 5): void {
  const writers = world.writers.length, slots = rounds * writers;
  for (let round = 0; round < rounds; round++) {
    world.pullAll();
    const free = [...world.beats];
    for (let writer = 0; writer < writers; writer++) {
      const beat = free.splice(Math.floor(next() * free.length), 1)[0] as string;
      for (let index = round * writers + writer; index < intents.length; index += slots) act(world, writer, beat, intents[index] as Intent, rate, next);
    }
  }
  world.pullAll();
}

export function typeTape(world: World): void {
  const tape = typingTape(1);
  let writer = 0;
  for (const op of tape.ops) {
    if (op.op === "turn") { writer = op.writer % world.writers.length; world.pull(writer); continue; }
    world.run(writer, { op: "splice", beat: op.beat, field: op.field, from: op.from, to: op.to, insert: op.insert });
  }
  world.pullAll();
}

export function life(scheme: KeyScheme, rate: Rate, writers: number, days: number, seed = 7, report: number[] = [], patch?: (replica: NativeReplica) => void): LifeResult {
  const started = performance.now(), next = random(seed * 1000 + writers), tape = typingTape(1);
  const world = new World(tape.document, scheme, writers), rows: DayRow[] = [];
  if (patch) world.writers.forEach(patch);
  commentSerial = 0;
  let firstMismatch: Mismatch | null = null, totalBytes = 0;
  try { typeTape(world); } catch (error) { if (!(error instanceof CheckFailure)) throw error; firstMismatch = error.mismatch; days = 0; }
  for (let day = 1; day <= days; day++) {
    let dayFormatting = 0, dayBytes = 0;
    try {
      const edits: Intent[] = [];
      for (let typed = 0; typed < rate.typed;) { const length = 5 + Math.floor(next() * 36); edits.push({ kind: "edit", length }); typed += length; }
      phase(world, edits, rate, next);
      const before = world.bytes(), formattedBefore = world.formatting;
      const marks: Intent[] = [...Array.from({ length: rate.formats }, (): Intent => ({ kind: "format" })), ...Array.from({ length: rate.pastes }, (): Intent => ({ kind: "paste" }))];
      for (let index = marks.length - 1; index > 0; index--) { const other = Math.floor(next() * (index + 1)); [marks[index], marks[other]] = [marks[other] as Intent, marks[index] as Intent]; }
      phase(world, marks, rate, next);
      dayFormatting = world.formatting - formattedBefore; dayBytes = world.bytes() - before;
    } catch (error) {
      if (!(error instanceof CheckFailure)) throw error;
      firstMismatch = error.mismatch;
      break;
    }
    totalBytes += dayBytes;
    if (day === days || report.includes(day)) {
      const mismatches = world.check();
      if (!firstMismatch && mismatches[0]) firstMismatch = mismatches[0];
      rows.push({ day, ...world.snapshot(), formattingTotal: world.formatting, dayFormatting, dayFormattingBytes: dayBytes,
        bytesPerFormatting: Math.round(dayBytes / Math.max(1, dayFormatting) * 10) / 10, meanBytesPerFormatting: Math.round(totalBytes / Math.max(1, world.formatting) * 10) / 10, mismatches: mismatches.length });
    }
  }
  world.destroy();
  return { scheme, rate: rate.name, writers, days: rows, seconds: Math.round((performance.now() - started) / 100) / 10, firstMismatch };
}

export interface PatternRow {
  pattern: string; scheme: KeyScheme; actions: number; keysMedian: number; keysP95: number; keysMax: number; mostOfOneKind: number;
  bytes: number; bytesAdded: number; bytesPerAction: number; readMs: number; afterUnformat: number; mismatches: number;
  collapsed?: { keysMax: number; bytes: number; readMs: number }; rebuilt?: { bytes: number; readMs: number };
}

export const PATTERNS = {
  prefix: "Bold the first k characters, k = 1, 2, ..., each time after typing one plain character at the end",
  toggle: "Bold and unbold the same 50 characters, one command each",
  overlapping: "Bold a random range of 5 to 80 characters in 400, toggling as the app does",
  alternate: "Two writers in turn bold almost the same 100 characters, shifted by up to 10, each seeing the other's last",
  sliding: "Bold characters k to k + 20, k = 0, 1, 2, ...",
  "type-inside": "Type a plain character inside a bold range, then bold the whole range again",
  punch: "Unbold one character inside a bold range, then bold the whole range again",
  paste: "Copy 40 formatted characters and paste them at a random place"
} as const;
export type Pattern = keyof typeof PATTERNS;

function readTime(text: Y.Text): number {
  const samples: number[] = [];
  for (let round = 0; round < 11; round++) { const started = performance.now(); nativeRuns(text.toDelta() as NativeDeltaItem[]); samples.push(performance.now() - started); }
  return Math.round(quantile(samples, 0.5) * 10000) / 10000;
}

function cellStats(delta: readonly NativeDeltaItem[]): { keysMedian: number; keysP95: number; keysMax: number; mostOfOneKind: number } {
  const count = countKeys(delta), formatted = count.perCharacter.filter(keys => keys > 0);
  return { keysMedian: quantile(formatted, 0.5), keysP95: quantile(formatted, 0.95), keysMax: formatted.reduce((most, keys) => Math.max(most, keys), 0), mostOfOneKind: count.mostOfOneKind };
}

export function drivePattern(world: World, pattern: Pattern, actions: number, seed = 3): void {
  const next = random(seed), beat = "one", field = "audioText", key = cellKey(beat, field), length = (): number => world.length(beat, field);
  const toggle = (writer: number, from: number, to: number, name = "b"): void => {
    world.run(writer, { op: "format", beat, field, from, to, name, on: !world.model.throughout(key, from, to, name) });
  };
  for (let index = 0; index < actions; index++) {
    if (pattern === "prefix") { world.run(0, { op: "type", beat, field, at: length(), text: "x", names: [] }); toggle(0, 0, index + 1); }
    else if (pattern === "toggle") toggle(0, 10, 60);
    else if (pattern === "overlapping") { const from = Math.floor(next() * 395), to = Math.min(400, from + 5 + Math.floor(next() * 76)); toggle(0, from, to); }
    else if (pattern === "alternate") { const writer = index % 2, shift = Math.floor(next() * 11); world.pull(writer); toggle(writer, 20 + shift, 120 + shift); }
    else if (pattern === "sliding") toggle(0, index, index + 20);
    else if (pattern === "type-inside") {
      if (index === 0) toggle(0, 10, 60);
      world.run(0, { op: "type", beat, field, at: 30, text: "y", names: [] });
      toggle(0, 10, 61 + index);
    } else if (pattern === "punch") {
      if (index === 0) toggle(0, 10, 60);
      const at = 11 + Math.floor(next() * 48);
      world.run(0, { op: "format", beat, field, from: at, to: at + 1, name: "b", on: false });
      toggle(0, 10, 60);
    } else {
      const from = Math.floor(next() * 160);
      world.run(0, { op: "paste", beat, field, at: Math.floor(next() * length()), runs: pasteRuns(world.model.cell(key).slice(from, from + 40)) });
    }
  }
  world.pullAll();
}

function patternText(pattern: Pattern, actions: number): string {
  if (pattern === "prefix") return "";
  if (pattern === "sliding") return "s".repeat(actions + 20);
  if (pattern === "paste") return "p".repeat(200);
  return "o".repeat(400);
}

export function worstCase(pattern: Pattern, scheme: KeyScheme, actions: number): PatternRow {
  const world = new World({ rows: [{ id: "one", audioText: patternText(pattern, actions), visualText: "" }] }, scheme, pattern === "alternate" ? 2 : 1);
  if (pattern === "paste") {
    for (const [from, to, name] of [[0, 20, "b"], [10, 30, "i"], [25, 45, "hl"], [50, 90, "t:t:prop:item-1"], [100, 140, "c:p"], [150, 200, "b"]] as const) {
      world.run(0, { op: "format", beat: "one", field: "audioText", from, to, name, on: true });
    }
    world.pullAll();
  }
  const base = world.bytes();
  drivePattern(world, pattern, actions);
  const mismatches = world.check().length, reader = world.reader(), text = reader.cell("one", "audioText").text;
  const delta = text.toDelta() as NativeDeltaItem[], bytesAdded = world.bytes() - base, readMs = readTime(text);
  const row: PatternRow = { pattern, scheme, actions, ...cellStats(delta), bytes: world.bytes(), bytesAdded, bytesPerAction: Math.round(bytesAdded / actions * 10) / 10, readMs, afterUnformat: 0, mismatches };
  if (scheme !== "name") {
    const lone = new NativeReplica(5, 0, "act");
    Y.applyUpdate(lone.doc, Y.encodeStateAsUpdate(world.server), "remote");
    lone.changes();
    const names = new Set(readCell(delta).flatMap(char => char.names)), loneText = lone.cell("one", "audioText").text;
    for (const name of names) collapse(lone, loneText, name);
    lone.changes();
    if (firstDifference(readCell(deltaOf(lone, "one", "audioText")), readCell(delta)) >= 0) row.mismatches++;
    const stored = new Y.Doc();
    Y.applyUpdate(stored, Y.encodeStateAsUpdate(lone.doc));
    row.collapsed = { keysMax: cellStats(loneText.toDelta() as NativeDeltaItem[]).keysMax, bytes: Y.encodeStateAsUpdate(stored).length, readMs: readTime(loneText) };
    stored.destroy();
    lone.destroy();
    const fresh = new NativeReplica(1, 0, "act");
    fresh.hydrate({ rows: [{ id: "one", audioText: "", visualText: "" }] });
    const rebuilt = fresh.cell("one", "audioText").text;
    fresh.doc.transact(() => {
      let index = 0;
      for (const item of rebuiltDelta(delta, 1, { next: 0 })) {
        if (typeof item.insert === "string") rebuilt.insert(index, item.insert, item.attributes ?? {}); else rebuilt.insertEmbed(index, item.insert, item.attributes ?? {});
        index += typeof item.insert === "string" ? item.insert.length : 1;
      }
    }, "hydration");
    fresh.changes();
    if (firstDifference(readCell(deltaOf(fresh, "one", "audioText")), readCell(delta)) >= 0) row.mismatches++;
    row.rebuilt = { bytes: fresh.encode().length, readMs: readTime(rebuilt) };
    fresh.destroy();
  }
  const length = world.length("one", "audioText");
  for (const name of new Set(world.model.cell("one/audioText").flatMap(char => char.names))) world.run(0, { op: "format", beat: "one", field: "audioText", from: 0, to: length, name, on: false });
  row.afterUnformat = world.bytes() - base;
  reader.destroy(); world.destroy();
  return row;
}

export interface CurveRow { acts: number; keysMedian: number; keysMax: number; items: number; bytes: number; readMs: number; collapsedBytes: number; collapsedReadMs: number }

// why: each act bolds a random half of a 400-character cell with a fresh key, so characters carry about half the keys
// and the cell splits into many differently formatted pieces; this times reading against keys per character
export function readCurve(acts: number, seed = 11): CurveRow {
  const next = random(seed), replica = new NativeReplica(1, 0, "act");
  replica.hydrate({ rows: [{ id: "one", audioText: "c".repeat(400), visualText: "" }] });
  replica.undo.destroy();
  for (let index = 0; index < acts; index++) { const from = Math.floor(next() * 200); replica.format("one", "audioText", from, from + 200, { b: true }); }
  const text = replica.cell("one", "audioText").text, delta = text.toDelta() as NativeDeltaItem[], stats = cellStats(delta), bytes = replica.encode().length, readMs = readTime(text);
  collapse(replica, text, "b");
  const stored = new Y.Doc();
  Y.applyUpdate(stored, replica.encode());
  const row = { acts, keysMedian: stats.keysMedian, keysMax: stats.keysMax, items: delta.length, bytes, readMs, collapsedBytes: Y.encodeStateAsUpdate(stored).length, collapsedReadMs: readTime(text) };
  stored.destroy(); replica.destroy();
  return row;
}

// why: B bolds c..e; A bolds h..i, collapsing the cell's bold keys in the same command; then B undoes its bold
export function afterCollapseUndo(collapsing: boolean): string {
  const world = new World({ rows: [{ id: "one", audioText: "abcdefghij", visualText: "" }] }, "act", 2);
  const first = world.writers[0] as NativeReplica, second = world.writers[1] as NativeReplica;
  second.format("one", "audioText", 2, 5, { b: true }); second.changes(); world.pullAll();
  first.transact(() => {
    first.format("one", "audioText", 7, 9, { b: true });
    if (collapsing) collapse(first, first.cell("one", "audioText").text, "b");
  });
  first.changes(); world.pullAll();
  const undone = second.undo.undo() !== null;
  second.changes(); world.pullAll();
  const shown = readCell(deltaOf(first, "one", "audioText")).map(char => char.names.includes("b") ? char.ch.toUpperCase() : char.ch).join("");
  world.destroy();
  return `${shown}${undone ? "" : " (the undo changed nothing)"}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const flag = (name: string, fallback: string): string => process.argv.find(value => value.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
  const part = flag("part", "life"), output = flag("write", ""), result: Record<string, unknown> = { node: process.version };
  if (part === "life") {
    const days = Number(flag("days", "250")), schemes = flag("schemes", "act,act+norm,name").split(",") as KeyScheme[];
    const runs: LifeResult[] = [], report = [1, 5, 10, 25, 50, 100, 150, 200, 250].filter(day => day < days);
    for (const rate of flag("rates", "realistic,heavy").split(",")) for (const writers of flag("writers", "1,2,6").split(",").map(Number)) for (const scheme of schemes) {
      const run = life(scheme, RATES[rate] as (typeof RATES)["realistic"], writers, days, 7, report);
      runs.push(run);
      const last = run.days.at(-1);
      process.stderr.write(`${rate} ${writers} ${scheme}: ${run.seconds} s, ${last?.bytes} bytes, keys max ${last?.keysMax}, mismatches ${last?.mismatches}\n`);
    }
    result.life = runs;
  } else {
    const rows: PatternRow[] = [];
    const patterns = flag("patterns", Object.keys(PATTERNS).join(",")).split(",") as Pattern[], schemes = flag("schemes", "act,act+norm,name").split(",") as KeyScheme[];
    for (const pattern of patterns) for (const actions of flag("actions", "100,300").split(",").map(Number)) for (const scheme of schemes) {
      rows.push(worstCase(pattern, scheme, actions));
      process.stderr.write(`${pattern} ${actions} ${scheme}: keys max ${rows.at(-1)?.keysMax}, ${rows.at(-1)?.bytesAdded} bytes\n`);
    }
    result.patterns = rows;
    result.undoAfterCollapse = { without: afterCollapseUndo(false), with: afterCollapseUndo(true) };
    result.curve = flag("curve", "4,8,16,32,64,128,256").split(",").map(Number).map(acts => readCurve(acts));
  }
  if (output) writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  else process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
