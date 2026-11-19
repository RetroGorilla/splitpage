import { ROW_MAKERS, incompleteBoundaries } from "../../src/native-row-record/variants.ts";
import type { RowControl, RowOption } from "../../src/native-row-record/variants.ts";
import type { ChosenReplica } from "../../src/native-chosen/replica.ts";
import type { KeptReplica } from "../../src/native-kept/replica.ts";
import { MODES } from "../native-chosen/engine.ts";
import type { Mode } from "../native-chosen/engine.ts";
import { GENERATED_SPEC, generateHistory } from "../native-chosen/generate.ts";
import { specOf } from "../native-chosen/kit.ts";
import type { Spec } from "../native-chosen/kit.ts";
import { generated, histories } from "../native-delete/histories.ts";
import { generate, namedHistories } from "../native-moves/e10-model.ts";
import { replay } from "../native-kept/replay.ts";
import type { KeptStep } from "../native-kept/replay.ts";
import { e10Command, e10Spec, e9Command } from "../native-kept/sets.ts";

export interface SetRun { label: string; spec: Spec; steps: KeptStep[]; writers: number; mode: Mode; number: number; first: boolean }

export const SET_NAMES = ["E9", "E10", "E11 mixed", "E11 double split"] as const;
export type SetName = typeof SET_NAMES[number];

// why: the same runs, schedules and seeds as E14's reruns, listed once so every option replays exactly these
export function setRuns(name: SetName): SetRun[] {
  const runs: SetRun[] = [];
  if (name === "E9") {
    const add = (history: ReturnType<typeof histories>[number], mode: Mode, number: number): void => {
      runs.push({ label: history.name, spec: specOf(history.initial), steps: history.forks.flatMap((fork, by) => fork.map(cmd => ({ by, cmd: e9Command(cmd) }))),
        writers: history.forks.length, mode, number, first: true });
    };
    for (const history of histories(1)) add(history, "reverse", 1);
    for (const [index, mode] of MODES.entries()) for (let n = 0; n < 12; n++) for (const history of generated(12 * index + n)) add(history, mode, 12 * index + n);
  } else if (name === "E10") {
    const all = [...namedHistories, ...Array.from({ length: 200 }, (_, i) => generate(i + 1))];
    for (const [index, history] of all.entries()) {
      const steps = history.steps.map((step): KeptStep => "from" in step ? step : { by: step.by, cmd: e10Command(step.command) });
      for (const [at, mode] of MODES.entries()) runs.push({ label: history.label, spec: e10Spec, steps, writers: index < namedHistories.length ? 2 : 3, mode, number: index * 5 + at, first: at === 0 });
    }
  } else {
    const twins = name === "E11 double split";
    for (let number = 1; number <= (twins ? 200 : 600); number++) {
      const { steps } = generateHistory(number, twins ? 28 : 40, twins, "cells");
      for (const [at, mode] of MODES.entries()) runs.push({ label: String(number), spec: GENERATED_SPEC(), steps, writers: 3, mode, number, first: at === 0 });
    }
  }
  return runs;
}

export interface Sweep {
  runs: number; commands: number; problems: number; problemKinds: Record<string, number>; samples: string[];
  orphans: number; dropped: number; droppedRuns: number; bareRuns: number; missingRank: number; stale: number;
  presses: number; passedOver: number; emptyPresses: number;
}

const kindOf = (problem: string): string => problem.replace(/(?:step|delivery|settled copy) \d+/g, "step").replace(/\b[A-Z]\d*\b/g, "ID").replace(/ at \d+/g, "");

// why: forward-delivery figures as E14 counted them; problems from all five deliveries
export function sweep(option: RowOption | RowControl, name: SetName): Sweep {
  const total: Sweep = {
    runs: 0, commands: 0, problems: 0, problemKinds: {}, samples: [], orphans: 0, dropped: 0, droppedRuns: 0, bareRuns: 0, missingRank: 0, stale: 0,
    presses: 0, passedOver: 0, emptyPresses: 0
  };
  const make = ROW_MAKERS[option], unread = option === "R" || option === "Rdrop" ? (replica: ChosenReplica) => incompleteBoundaries(replica as KeptReplica) : () => [];
  for (const run of setRuns(name)) {
    const held = new Map<ChosenReplica, Set<string>>(), stacks = new Map<ChosenReplica, [number, number]>();
    let dropped = 0, bare = false, presses = 0, passedOver = 0, emptyPresses = 0;
    const watch = (replica: ChosenReplica): void => {
      const now = new Set([...replica.beats.keys(), ...[...replica.visuals.keys()].map(id => `visual:${id}`)]);
      for (const key of held.get(replica) ?? []) if (!now.has(key)) dropped++;
      held.set(replica, now);
      if (incompleteBoundaries(replica as KeptReplica).length) bare = true;
    };
    // why: a copy's own stacks change only through its own commands, so the depths at its previous command are the depths
    // before this one; a press that pops more than one entry passed over entries that no longer changed anything
    const command = (replica: ChosenReplica, at: number): void => {
      watch(replica);
      const step = run.steps[at], [undo, redo] = stacks.get(replica) ?? [0, 0], now: [number, number] = [replica.undo.undoStack.length, replica.undo.redoStack.length];
      stacks.set(replica, now);
      if (!step || !("cmd" in step) || (step.cmd.op !== "undo" && step.cmd.op !== "redo")) return;
      const back = step.cmd.op === "undo", popped = back ? undo - now[0] : redo - now[1], pushed = back ? now[1] - redo : now[0] - undo;
      presses++;
      if (popped > 1) passedOver++;
      if (popped > 0 && pushed <= 0) emptyPresses++;
    };
    const result = replay(run.spec, run.steps, run.writers, true, run.mode, run.number, undefined, { command, settled: watch }, { make, unread });
    total.runs++;
    total.commands += result.count;
    total.problems += result.problems.length;
    for (const problem of result.problems) {
      const kind = kindOf(problem);
      total.problemKinds[kind] = (total.problemKinds[kind] ?? 0) + 1;
      if (total.samples.length < 6) total.samples.push(`${run.label} ${run.mode}: ${problem}`);
    }
    total.stale += result.stale.length;
    if (run.first) {
      total.orphans += result.orphans.length;
      total.dropped += dropped;
      total.droppedRuns += Number(dropped > 0);
      total.bareRuns += Number(bare);
      total.missingRank += Number(result.missingRank);
      total.presses += presses;
      total.passedOver += passedOver;
      total.emptyPresses += emptyPresses;
    }
  }
  return total;
}
