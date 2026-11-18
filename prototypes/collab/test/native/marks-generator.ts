import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { nativeMarkName } from "../../src/native/variant.ts";
import type { NativeReplica, NativeScheme } from "../../src/native/variant.ts";
import { KitNet, start } from "./kit.ts";

export type MarkKind = "b" | "i";
export type MarkDelivery = "updates" | "state";
export type MarkStep =
  | { op: "add" | "remove"; by: number; kind: MarkKind; first: string; last: string }
  | { op: "delete"; by: number; first: string; last: string }
  | { op: "insert"; by: number; after: string | null; char: string; mode: "inherit" | "plain" | MarkKind }
  | { op: "deliver"; from: number; to: number };
export type MarkClass = keyof typeof MARK_CLASSES;
export interface MarkDifference { char: string; kind: MarkKind; direction: "lost" | "extra"; cause: MarkClass }
export interface MarkRun { agree: boolean; text: string; expectedText: string; native: string; model: string; differences: MarkDifference[]; executed: number }
export interface MarkCase { cause: MarkClass; histories: number; steps: MarkStep[]; example: string[]; native: string; model: string }
export interface MarkSummary {
  scheme: NativeScheme; writers: number; delivery: MarkDelivery; histories: number; executed: number; disagreements: number; textMismatches: number;
  withLost: number; withExtra: number; cases: MarkCase[];
}

// why: every difference from main's rule falls in exactly one of these, decided from the commands alone
export const MARK_CLASSES = {
  "lost-selected": "Formatting gone from a character someone selected and formatted, and nobody unformatted",
  "lost-typed-with": "Formatting gone from a character that was typed with it and that nobody formatted or unformatted afterwards",
  "lost-unformat-apart": "Formatting gone from a character one person formatted while another, who had not seen that, unformatted it",
  "lost-typed-inside": "No formatting on a character typed inside a formatted range by someone who had not seen the formatting",
  "extra-typed-apart": "Formatting on a character typed without it, beside or inside a range someone formatted or partly unformatted without having seen the character",
  "extra-unformatted": "Formatting still on a character that someone unformatted after seeing every formatting of it",
  "extra-nowhere": "Formatting on a character nobody formatted and no unseen range reaches"
} as const;

interface ModelCommand { id: number; op: "add" | "remove" | "delete" | "insert"; kind?: MarkKind; selected: string[]; marks: MarkKind[]; known: ReadonlySet<number> }
interface Shown { char: string; kinds: MarkKind[] }

const KINDS: readonly MarkKind[] = ["b", "i"];
const POOL = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ";
const LETTER = (writer: number): string => String.fromCharCode(65 + writer);

function read(replica: NativeReplica): Shown[] {
  const result: Shown[] = [];
  for (const item of replica.rows().find(row => row.id === "R1")?.audio ?? []) {
    if (typeof item.insert !== "string") continue;
    const names = new Set(Object.entries(item.attributes ?? {}).filter(([, value]) => value === true).map(([key]) => nativeMarkName(key)));
    for (const char of item.insert) result.push({ char, kinds: KINDS.filter(kind => names.has(kind)) });
  }
  return result;
}

const printed = (shown: readonly Shown[]): string => shown.map(item => item.kinds.length ? `[${item.char}|${item.kinds.join(",")}]` : item.char).join("");

// why: main's mark rule, computed without the shared library: a mark covers what it selected and what arrives unseen
// strictly inside; a removal takes away only marks it had seen; typed text carries the marks it was given
function expected(commands: readonly ModelCommand[], order: string): Shown[] {
  const place = new Map([...order].map((char, index) => [char, index])), at = (char: string | undefined): number => place.get(char ?? "") ?? -1;
  const deleted = new Set(commands.filter(command => command.op === "delete").flatMap(command => command.selected));
  const births = new Map(commands.filter(command => command.op === "insert").map(command => [command.selected[0] ?? "", command]));
  const reaches = (command: ModelCommand, char: string): boolean => {
    if (command.selected.includes(char)) return true;
    const birth = births.get(char);
    return !!birth && !birth.known.has(command.id) && at(command.selected[0]) < at(char) && at(char) < at(command.selected.at(-1));
  };
  const result: Shown[] = [];
  for (const char of order) {
    if (deleted.has(char)) continue;
    const kinds = KINDS.filter(kind => {
      const removals = commands.filter(command => command.op === "remove" && command.kind === kind && reaches(command, char));
      if (births.get(char)?.marks.includes(kind) && !removals.some(removal => removal.selected.includes(char))) return true;
      return commands.some(command => command.op === "add" && command.kind === kind && reaches(command, char) && !removals.some(removal => removal.known.has(command.id)));
    });
    result.push({ char, kinds });
  }
  return result;
}

export function runMarks(steps: readonly MarkStep[], writers: number, scheme: NativeScheme, delivery: MarkDelivery, initial = "abcdef"): MarkRun {
  const copies = start([{ id: "R1", audioText: initial }], writers, scheme), net = new KitNet(copies), oracle = new Y.Doc({ gc: false });
  // why: a copy that never collects deleted text gives the order of every character ever typed, which the rule needs
  Y.applyUpdate(oracle, Y.encodeStateAsUpdate((copies[0] as NativeReplica).doc));
  for (const copy of copies) copy.doc.on("update", (update: Uint8Array) => { Y.applyUpdate(oracle, update); });
  const commands: ModelCommand[] = [], known = copies.map(() => new Set<number>()), issued = copies.map((): number[] => []);
  const record = (by: number, command: Omit<ModelCommand, "id" | "known">): void => {
    const id = commands.length;
    commands.push({ ...command, id, known: new Set(known[by]) });
    known[by]?.add(id); issued[by]?.push(id);
  };
  const sync = (from: number, to: number): void => {
    const source = copies[from] as NativeReplica, target = copies[to] as NativeReplica;
    if (delivery === "updates") { net.deliver(source, target); for (const id of issued[from] ?? []) known[to]?.add(id); return; }
    Y.applyUpdate(target.doc, Y.encodeStateAsUpdate(source.doc, Y.encodeStateVector(target.doc)), "remote");
    target.changes();
    for (const id of known[from] ?? []) known[to]?.add(id);
  };
  let executed = 0;
  for (const step of steps) {
    if (step.op === "deliver") { if (step.from < writers && step.to < writers && step.from !== step.to) sync(step.from, step.to); continue; }
    const replica = copies[step.by];
    if (!replica) continue;
    const shown = read(replica), index = (char: string): number => shown.findIndex(item => item.char === char);
    if (step.op === "insert") {
      const at = step.after === null ? 0 : index(step.after) + 1;
      if ((step.after !== null && at === 0) || index(step.char) >= 0 || commands.some(command => command.op === "insert" && command.selected[0] === step.char)) continue;
      const marks = step.mode === "plain" ? [] : step.mode === "inherit" ? [...(shown[at - 1]?.kinds ?? [])] : [step.mode];
      replica.splice("R1", "audioText", at, at, [{ text: step.char, marks: Object.fromEntries(marks.map(kind => [kind, true])) }]);
      record(step.by, { op: "insert", selected: [step.char], marks });
    } else {
      const from = index(step.first), to = index(step.last);
      if (from < 0 || to < from) continue;
      const selected = shown.slice(from, to + 1).map(item => item.char);
      if (step.op === "delete") replica.splice("R1", "audioText", from, to + 1, []);
      else replica.format("R1", "audioText", from, to + 1, { [step.kind]: step.op === "add" ? true : null });
      record(step.by, { op: step.op, ...step.op === "delete" ? {} : { kind: step.kind }, selected, marks: [] });
    }
    replica.changes(); executed++;
  }
  if (delivery === "updates") net.settle();
  else for (let round = 0; round < 3; round++) for (let from = 0; from < writers; from++) for (let to = 0; to < writers; to++) if (from !== to) sync(from, to);
  const late = net.late(scheme), readings = [...copies, late].map(copy => printed(read(copy)));
  const text = oracle.getMap<Y.Map<unknown>>("segments").get("seg-b-R1")?.get("text") as Y.Text;
  const everything = text.toDelta(Y.createSnapshot(Y.createDeleteSet(), Y.decodeStateVector(Y.encodeStateVector(oracle)))) as { insert: unknown }[];
  const order = everything.map(item => typeof item.insert === "string" ? item.insert : "").join("");
  const native = read(copies[0] as NativeReplica), model = expected(commands, order), differences: MarkDifference[] = [];
  const shownNow = new Map(native.map(item => [item.char, item.kinds]));
  for (const item of model) for (const kind of KINDS) {
    const here = shownNow.get(item.char)?.includes(kind) ?? false, wanted = item.kinds.includes(kind);
    if (here === wanted) continue;
    const birth = commands.find(command => command.op === "insert" && command.selected[0] === item.char);
    const selected = commands.some(command => command.op === "add" && command.kind === kind && command.selected.includes(item.char));
    const formatted = !!birth?.marks.includes(kind) || selected;
    const unformatted = commands.some(command => command.op === "remove" && command.kind === kind && command.selected.includes(item.char));
    const apart = !!birth && commands.some(command => (command.op === "add" || command.op === "remove") && command.kind === kind && !birth.known.has(command.id) && !command.known.has(birth.id));
    const cause: MarkClass = wanted ? (formatted ? (unformatted ? "lost-unformat-apart" : selected ? "lost-selected" : "lost-typed-with") : "lost-typed-inside")
      : apart ? "extra-typed-apart" : formatted && unformatted ? "extra-unformatted" : "extra-nowhere";
    differences.push({ char: item.char, kind, direction: wanted ? "lost" : "extra", cause });
  }
  return { agree: readings.every(value => value === readings[0]), text: native.map(item => item.char).join(""), expectedText: model.map(item => item.char).join(""),
    native: printed(native), model: printed(model), differences, executed };
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateMarks(seed: number, writers: number, length: number, initial = "abcdef"): MarkStep[] {
  const next = random(seed), pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;
  const chars = [...initial], steps: MarkStep[] = [];
  let typed = 0;
  const range = (): { first: string; last: string } => {
    const from = Math.floor(next() * chars.length), to = Math.min(chars.length - 1, from + Math.floor(next() * 3));
    return { first: chars[from] as string, last: chars[to] as string };
  };
  while (steps.length < length) {
    const roll = next(), by = Math.floor(next() * writers);
    if (roll < 0.25) steps.push({ op: "add", by, kind: pick(KINDS), ...range() });
    else if (roll < 0.37) steps.push({ op: "remove", by, kind: pick(KINDS), ...range() });
    else if (roll < 0.5) steps.push({ op: "delete", by, ...range() });
    else if (roll < 0.75) {
      const after = next() < 0.1 ? null : pick(chars), char = POOL.charAt(typed++ % POOL.length);
      steps.push({ op: "insert", by, after, char, mode: pick(["inherit", "plain", "plain", pick(KINDS)] as const) });
      chars.splice(after === null ? 0 : chars.indexOf(after) + 1, 0, char);
    } else { const to = Math.floor(next() * writers); if (to !== by) steps.push({ op: "deliver", from: by, to }); }
  }
  return steps;
}

export function shrinkMarks(steps: readonly MarkStep[], keeps: (candidate: readonly MarkStep[]) => boolean): MarkStep[] {
  let current = [...steps];
  for (let changed = true; changed;) {
    changed = false;
    for (let index = current.length - 1; index >= 0; index--) {
      const candidate = current.filter((_, other) => other !== index);
      if (keeps(candidate)) { current = candidate; changed = true; }
    }
  }
  return current;
}

export function describeStep(step: MarkStep): string {
  const kind = (value: MarkKind): string => value === "b" ? "bold" : "italic", span = (first: string, last: string): string => first === last ? first : `${first}..${last}`;
  if (step.op === "deliver") return `${LETTER(step.from)}'s changes reach ${LETTER(step.to)}`;
  if (step.op === "insert") return `${LETTER(step.by)} types ${step.char} ${step.after === null ? "at the start" : `after ${step.after}`}, ${step.mode === "plain" ? "plain" : step.mode === "inherit" ? "taking the formatting on its left" : kind(step.mode)}`;
  if (step.op === "delete") return `${LETTER(step.by)} deletes ${span(step.first, step.last)}`;
  return `${LETTER(step.by)} ${step.op === "add" ? "makes" : "takes"} ${span(step.first, step.last)} ${step.op === "add" ? "" : "out of "}${kind(step.kind)}`.replace("  ", " ");
}

export function surveyMarks(scheme: NativeScheme, writers: number, delivery: MarkDelivery, seeds: number, length: number): MarkSummary {
  const summary: MarkSummary = { scheme, writers, delivery, histories: seeds, executed: 0, disagreements: 0, textMismatches: 0, withLost: 0, withExtra: 0, cases: [] };
  for (let seed = 1; seed <= seeds; seed++) {
    const steps = generateMarks(seed, writers, length), run = runMarks(steps, writers, scheme, delivery);
    summary.executed += run.executed;
    if (!run.agree) summary.disagreements++;
    if (run.text !== run.expectedText) summary.textMismatches++;
    if (run.differences.some(difference => difference.direction === "lost")) summary.withLost++;
    if (run.differences.some(difference => difference.direction === "extra")) summary.withExtra++;
    for (const cause of new Set(run.differences.map(difference => difference.cause))) {
      const found = summary.cases.find(item => item.cause === cause);
      if (found && found.steps.length <= 2) { found.histories++; continue; }
      const small = shrinkMarks(steps, candidate => runMarks(candidate, writers, scheme, delivery).differences.some(difference => difference.cause === cause));
      const result = runMarks(small, writers, scheme, delivery), entry = { steps: small, example: small.map(describeStep), native: result.native, model: result.model };
      if (!found) summary.cases.push({ cause, histories: 1, ...entry });
      else { found.histories++; if (small.length < found.steps.length) Object.assign(found, entry); }
    }
  }
  summary.cases.sort((a, b) => a.cause.localeCompare(b.cause));
  return summary;
}

export function marksReport(summaries: readonly MarkSummary[]): string {
  const causes = Object.keys(MARK_CLASSES) as MarkClass[], sent = (row: MarkSummary): string => row.delivery === "updates" ? "each update" : "state";
  const lines = [`| Key scheme | Writers | Delivery | Histories | Commands run | Copies or late joiner disagree | Text differs from typed minus deleted | ${causes.join(" | ")} |`,
    `| --- | --- | --- | --- | --- | --- | --- | ${causes.map(() => "---").join(" | ")} |`];
  for (const row of summaries) lines.push(`| ${row.scheme} | ${row.writers} | ${sent(row)} | ${row.histories} | ${row.executed} | ${row.disagreements} | ${row.textMismatches} | ${causes.map(cause => row.cases.find(item => item.cause === cause)?.histories ?? 0).join(" | ")} |`);
  lines.push("", "The seven columns on the right count histories with at least one difference of that kind:", "");
  for (const cause of causes) lines.push(`- \`${cause}\`: ${MARK_CLASSES[cause]}.`);
  lines.push("", "Shortest reduced history found for each kind (text starts as plain `abcdef`; `[x|b]` is bold x, `[x|i]` italic):", "",
    "| Kind | Key scheme | Writers, delivery | Reduced history | Variant shows | Main's rule gives |", "| --- | --- | --- | --- | --- | --- |");
  for (const cause of causes) for (const row of summaries) {
    const item = row.cases.find(entry => entry.cause === cause);
    if (item) lines.push(`| ${cause} | ${row.scheme} | ${row.writers}, ${sent(row)} | ${item.example.join("; ")} | \`${item.native}\` | \`${item.model}\` |`);
  }
  return lines.join("\n") + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const flag = (name: string, fallback: number): number => Number(process.argv.find(value => value.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
  const output = process.argv.find(value => value.startsWith("--write="))?.split("=")[1], summaries: MarkSummary[] = [];
  for (const scheme of ["name", "act"] as const) for (const [writers, delivery] of [[2, "updates"], [2, "state"], [3, "state"]] as const) {
    summaries.push(surveyMarks(scheme, writers, delivery, flag("seeds", 300), flag("length", 14)));
    process.stderr.write(`${scheme} ${writers} ${delivery}: done\n`);
  }
  if (output) writeFileSync(output, JSON.stringify(summaries, null, 2) + "\n");
  process.stdout.write(marksReport(summaries));
}
