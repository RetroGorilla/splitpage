import { writeFileSync } from "node:fs";
import { minimize, replay, runHistory } from "./generator.ts";
import type { Pace } from "./generator.ts";
import type { CreationRule } from "./layer.ts";
import type { NativeScheme } from "../native/variant.ts";

export interface ConfigResult {
  readonly pace: Pace; readonly creations: CreationRule; readonly histories: number; readonly failures: number; readonly presses: number; readonly undone: number; readonly redone: number;
  readonly uncertainPresses: number; readonly uncertainCommands: number; readonly losses: number; readonly unseenLosses: number; readonly formatSkips: number;
  readonly undoPresses: number; readonly uncertainUndos: number; readonly uncertainRedos: number; readonly formatRemains: number;
  readonly inheritedTagLost: number; readonly formatSkipSeeds: number[]; readonly extraPressUpdates: { seed: number; updates: number[] }[];
  readonly scheme: NativeScheme; readonly historiesWithMarkDifferences: number; readonly actions: Record<string, number>
}
export interface MarkExample { readonly category: string; readonly count: number; readonly shortest: string[] }

const MODES = ["forward", "reverse", "twice"] as const;

export function config(pace: Pace, creations: CreationRule, histories: number, scheme: NativeScheme = "act"): ConfigResult {
  const result = {
    pace, creations, histories, scheme, failures: 0, presses: 0, undone: 0, redone: 0, uncertainPresses: 0, uncertainCommands: 0,
    losses: 0, unseenLosses: 0, formatSkips: 0, historiesWithMarkDifferences: 0, actions: {} as Record<string, number>,
    undoPresses: 0, uncertainUndos: 0, uncertainRedos: 0, formatRemains: 0, inheritedTagLost: 0,
    formatSkipSeeds: [] as number[], extraPressUpdates: [] as { seed: number; updates: number[] }[]
  };
  for (let seed = 0; seed < histories; seed++) {
    try {
      const updates: number[] = [];
      const run = runHistory({ seed, steps: 40, pace, modes: MODES, creations, scheme,
        ...(scheme === "name" ? { onExtraPressUpdates: (count: number) => { updates.push(count); } } : {}) });
      if (updates.length) { result.failures++; result.extraPressUpdates.push({ seed, updates }); }
      result.presses += run.stats.presses; result.undone += run.stats.undone; result.redone += run.stats.redone;
      result.undoPresses += run.stats.undoPresses;
      result.uncertainUndos += run.stats.uncertainUndos; result.uncertainRedos += run.stats.uncertainRedos;
      result.uncertainPresses += run.stats.uncertainPresses; result.uncertainCommands += run.stats.uncertainCommands;
      result.losses += run.losses.length; result.unseenLosses += run.losses.filter(loss => loss.unseen).length;
      result.formatSkips += run.stats.formatSkips;
      if (run.stats.formatSkips) result.formatSkipSeeds.push(seed);
      result.formatRemains += run.stats.formatRemains; result.inheritedTagLost += run.stats.inheritedTagLost;
      if (run.stats.markMismatches.length) result.historiesWithMarkDifferences++;
      for (const [action, times] of Object.entries(run.actions)) result.actions[action] = (result.actions[action] ?? 0) + times;
    } catch { result.failures++; }
  }
  return result;
}

// why: each history with a formatting difference is cut to the fewest steps that still show one, then sorted by
// whether undo or redo is among them and which way the mark differs
export function markExamples(pace: Pace, histories: number): MarkExample[] {
  const found = new Map<string, MarkExample>();
  for (let seed = 0; seed < histories; seed++) {
    const run = runHistory({ seed, steps: 40, pace, modes: MODES });
    if (!run.stats.markMismatches.length) continue;
    const holds = (steps: Parameters<typeof replay>[0]): boolean => {
      try { const world = replay(steps, { clients: run.clients }); world.settle(); world.check(); return world.stats.markMismatches.length > 0; } catch { return false; }
    };
    const steps = minimize(run.steps, holds), world = replay(steps, { clients: run.clients });
    world.settle(); world.check();
    const mismatch = world.stats.markMismatches[0];
    if (!mismatch) continue;
    const undo = steps.some(step => step.act === "undo" || step.act === "redo");
    const category = `${undo ? "with undo or redo" : "without undo"}: ${mismatch.kind} ${mismatch.expected ? "missing" : "extra"} on ${mismatch.char.includes("{") ? "a beat boundary" : "a letter"}`;
    const shortest = [`clients ${run.clients.join(",")}`, ...world.history, `${mismatch.kind} expected ${mismatch.expected ? "on" : "off"} for ${mismatch.char}`];
    const known = found.get(category);
    found.set(category, { category, count: (known?.count ?? 0) + 1, shortest: known && known.shortest.length <= shortest.length ? known.shortest : shortest });
  }
  return [...found.values()].sort((a, b) => b.count - a.count);
}

export function report(histories: number): { configs: ConfigResult[]; marks: Record<Pace, MarkExample[]> } {
  const paces: Pace[] = ["batched", "continuous"], rules: CreationRule[] = ["keep-always", "keep-holding"];
  return {
    configs: [...rules.flatMap(rule => paces.map(pace => config(pace, rule, histories))), ...paces.map(pace => config(pace, "keep-always", histories, "name"))],
    marks: { batched: markExamples("batched", histories), continuous: markExamples("continuous", histories) }
  };
}

if (process.argv[1]?.endsWith("report.ts")) {
  const result = JSON.stringify(report(300), null, 2);
  if (process.argv.includes("--write")) writeFileSync(new URL("./generated-results.json", import.meta.url), result + "\n");
  process.stdout.write(result + "\n");
}
