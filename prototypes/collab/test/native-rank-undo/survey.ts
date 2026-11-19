import { MODES } from "../native-chosen/engine.ts";
import { GENERATED_SPEC, generateHistory } from "../native-chosen/generate.ts";
import { play } from "../native-chosen/play.ts";
import type { Cmd, PlayResult, Step } from "../native-chosen/play.ts";
import { b, h } from "../native-chosen/kit.ts";
import type { Spec } from "../native-chosen/kit.ts";
import { makeOption } from "../../src/native-rank-undo/variants.ts";
import type { RankOption } from "../../src/native-rank-undo/variants.ts";
import { e15Checks } from "./storage.ts";
import { generate, namedHistories } from "../native-moves/e10-model.ts";
import type { E10Command, E10History, E10Step, E10View } from "../native-moves/e10-model.ts";

// why: E11's E10 fixture and command translation, copied because importing its test file would run its tests here
const E10_SPEC = (): Spec => ({
  order: ["scene-P", "beat-D", "scene-Q"],
  segments: {
    "scene-P": { head: h("P"), units: ["x", b("A"), "ab", b("B"), "cd", b("C"), "ef"] },
    "beat-D": { head: b("D"), units: ["gh"] },
    "scene-Q": { head: h("Q"), units: ["y", b("E"), "ij", b("F"), "kl", b("G"), "mn", b("H"), "op"] }
  },
  beats: { A: { note: "one" }, B: { note: "two" }, C: { paragraphStart: true }, D: {}, E: {}, F: {}, G: {}, H: {} },
  visuals: { A: "A", B: "B", C: "C", D: "D", E: "E", F: "F", G: "G", H: "H" },
  headings: { P: {}, Q: {} }
});

const strip = (id: string): string => id.replace(/^#/, "");
function translate(command: E10Command): Cmd {
  switch (command.op) {
    case "move": {
      const { drop } = command, scene = drop.unit === "scene";
      return { op: "move", drop: { ...drop, first: scene ? strip(drop.first) : drop.first, target: scene && drop.target ? strip(drop.target) : drop.target } };
    }
    case "type": return { op: "type", id: command.id, field: command.field === "audioText" ? "audio" : "visual", at: command.at, text: command.text };
    case "format": case "tag": return { op: "format", id: command.id, field: "audio", from: command.from, to: command.to, key: command.key, on: true };
    case "field": return { op: "field", id: command.id, key: command.key, value: command.value };
    case "split": return { op: "split", id: command.id, at: command.at, created: command.newId };
    case "join": case "unjoin": return { op: command.op, id: command.id };
    case "delete": return { op: "delete", rows: [command.id] };
    case "removeHeading": return { op: "removeHeading", id: strip(command.id) };
    case "heading": return { op: "heading", above: command.id, id: strip(command.newId), text: command.text };
    case "rename": return { op: "type", id: strip(command.id), field: "name", at: command.at, text: command.text };
    case "undo": case "redo": return { op: command.op };
  }
}
const e10Steps = (history: E10History): Step[] => history.steps.map((step: E10Step): Step => "from" in step ? step : { by: step.by, cmd: translate(step.command) });

export interface Tally {
  histories: number; never: Record<string, number>; neverSeeds: Record<string, number>; local: Record<string, number>; kinds: Record<string, number>;
  ranklessHistories: number; ranklessRows: number; ruleE: number; drift: { place: number; scene: number }; refused: number; disagree: number;
  localSeeds: Record<string, number>; generatorThrew: Record<string, number>;
}

// why: E11's chosen combination keeps heading names in their own cells (part B)
export const NAMES = "cells";

const blank = (): Tally => ({
  histories: 0, never: {}, neverSeeds: {}, local: {}, kinds: {}, ranklessHistories: 0, ranklessRows: 0, ruleE: 0, drift: { place: 0, scene: 0 }, refused: 0, disagree: 0,
  localSeeds: {}, generatorThrew: {}
});
const RANKLESS = "a row brought back by an undo after an unseen move is read at its stored place";

// why: the same wording E11's survey uses to group problems, so the counts compare with its tables
export const category = (problem: string): string => {
  if (problem.includes("threw: ")) return `threw: ${problem.slice(problem.indexOf("threw: ") + 7).replace(/b:[^\s]+/g, "b:#")}`;
  const text = problem.replace(/^(step \d+ \w+|settled( on \d+)?|settling): /, "");
  return text.replace(/\b(letter|narration|beat|beats|copy|row|heading) \S+/g, "$1 #").replace(/\(\w+\)/g, "").replace(/\s+/g, " ").slice(0, 90);
};

function add(tally: Tally, results: readonly PlayResult[], seed: number): void {
  const first = results[0];
  if (!first) return;
  tally.histories++;
  const plain = (lines: readonly string[]): string => lines.map(line => line.replace(/\[([^|\]]*)\|[^\]]*\]/g, "$1")).join("|");
  if (results.some(result => plain(result.lines) !== plain(first.lines))) tally.disagree++;
  for (const problem of new Set(results.flatMap(result => result.never).map(category))) {
    tally.never[problem] = (tally.never[problem] ?? 0) + 1;
    tally.neverSeeds[problem] ??= seed;
    if (problem.startsWith("threw")) tally.refused++;
  }
  for (const problem of new Set(results.flatMap(result => result.local).map(category))) { tally.local[problem] = (tally.local[problem] ?? 0) + 1; tally.localSeeds[problem] ??= seed; }
  for (const [kind, n] of Object.entries(first.kinds)) tally.kinds[kind] = (tally.kinds[kind] ?? 0) + n;
  if (results.some(result => result.kinds[RANKLESS])) tally.ranklessHistories++;
  tally.ranklessRows += first.kinds[RANKLESS] ?? 0;
  if (results.some(result => result.uses.rank)) tally.ruleE++;
  if (results.some(result => result.drift.place)) tally.drift.place++;
  if (results.some(result => result.drift.scene)) tally.drift.scene++;
}

// why: `own` picks each history's commands from the rows the option itself shows; otherwise the lists are the ones
// option A's rows give, so every option replays the same commands
export function surveyE11(option: RankOption, size: number, twins: boolean, own = false): Tally {
  const tally = blank(), make = makeOption(option), storage = e15Checks(option);
  for (let number = 1; number <= size; number++) {
    const generated = generateHistory(number, 40, twins, NAMES, own ? make : undefined), steps: Step[] = generated.steps;
    for (const problem of generated.thrown) tally.generatorThrew[problem] = (tally.generatorThrew[problem] ?? 0) + 1;
    add(tally, MODES.map((mode, at) => play({ spec: GENERATED_SPEC(), steps, writers: 3, mode, seed: number * 7 + at, make, names: NAMES, storage })), number);
  }
  return tally;
}

// why: E10's view, read back from the settled rows; a row's members are written in its id, and `start` is true for
// the first row under a heading, which is all E10's preferred orders use
export function e10View(result: PlayResult): E10View {
  const order: string[] = [], rows: E10View["rows"] = [];
  let scene: string | null = null, first = true;
  for (const line of result.lines) {
    if (line.startsWith("#")) { scene = line.slice(0, line.indexOf(" ")); order.push(scene); first = true; continue; }
    const head = line.slice(0, line.indexOf(":")), match = /^([^(]+)\((.+)\)$/.exec(head), id = match?.[1] ?? head, members = match?.[2]?.split("+") ?? [head];
    order.push(...members);
    rows.push({ id, scene, start: first, members });
    first = false;
  }
  return { order, rows, cells: result.cells };
}

export type E10Outcome = "preferred" | "other" | "broken";

export function surveyE10(option: RankOption): { tally: Tally; table: Record<string, Record<E10Outcome, number>>; outcomes: E10Outcome[] } {
  const make = makeOption(option), storage = e15Checks(option), tally = blank(), table: Record<string, Record<E10Outcome, number>> = {}, outcomes: E10Outcome[] = [];
  const all: { history: E10History; writers: number }[] = [...namedHistories.map(history => ({ history, writers: 2 })), ...Array.from({ length: 200 }, (_, i) => ({ history: generate(i + 1), writers: 3 }))];
  for (const [index, { history, writers }] of all.entries()) {
    const results = MODES.map((mode, at) => play({ spec: E10_SPEC(), steps: e10Steps(history), writers, mode, seed: index * 5 + at, make, names: NAMES, storage }));
    add(tally, results, index);
    const outcome: E10Outcome = results.some(result => result.never.length || result.local.length) ? "broken"
      : results.every(result => history.preferred(e10View(result))) ? "preferred" : "other";
    outcomes.push(outcome);
    const row = table[history.kind] ??= { preferred: 0, other: 0, broken: 0 };
    row[outcome]++;
  }
  return { tally, table, outcomes };
}
