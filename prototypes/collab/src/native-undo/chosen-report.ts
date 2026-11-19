import { runHistory } from "./generator.ts";
import type { HistoryResult } from "./generator.ts";
import type { CommandDifference, TagDifference, WorldStats } from "./harness.ts";
import type { NativeScheme } from "../native/variant.ts";

export const DELIVERIES = ["forward", "reverse", "twice"] as const;
type Schedule = "mixed" | (typeof DELIVERIES)[number];

export function classifyCommand(difference: CommandDifference): string {
  const [format] = difference.formats;
  if (!format || difference.formats.length !== 1) throw new Error("Expected one format in a command disagreement");
  if (difference.perAction === difference.updated && difference.markerOnly) return `marker-only ${format.on ? "on" : "off"}`;
  if (format.on && !difference.updated) return format.mark.startsWith("t:") ? "A: redundant tag on" : "A: redundant simple on";
  if (!format.on && !difference.updated && format.pending) return "A: format pending integration";
  if (!format.on && difference.updated && [...format.displayed].every((bit, index) => bit !== "1" || format.restored[index] === "1")) {
    return format.mark.startsWith("t:") ? "A: restored tagged text" : "A: restored bold text";
  }
  if (!format.on && difference.updated && format.mark.startsWith("t:") && format.requested !== format.displayed) return "C: tag on never-requested text";
  if (!format.on && difference.updated && !format.mark.startsWith("t:")) return "B: simple mark outside expected range";
  throw new Error(`Unclassified command: ${JSON.stringify(difference)}`);
}

const COUNTERS = [
  "checks", "presses", "undoPresses", "undone", "redone", "uncertainPresses", "uncertainUndos", "uncertainRedos",
  "uncertainCommands", "differentStep", "skippedToOlder", "formatSkips", "formatRemains", "inheritedTagLost"
] as const satisfies readonly (keyof WorldStats)[];

function countTags(differences: readonly TagDifference[]): number {
  return new Set(differences.map(({ original, kind }) => `${original}/${kind}`)).size;
}

export function study(scheme: NativeScheme, schedule: Schedule, details = false) {
  const counters = Object.fromEntries(COUNTERS.map(key => [key, 0])) as Record<(typeof COUNTERS)[number], number>;
  const updates: Record<number, number> = {}, commands: Record<string, number> = {};
  const missing = { histories: 0, characters: 0, settledHistories: 0, settledCharacters: 0 };
  const extra = { ...missing };
  const failures: { pace: string; seed: number; message: string }[] = [];
  const cases: unknown[] = [];
  const multiUpdate: { pace: string; seed: number; count: number }[] = [];
  let completed = 0, textOrFieldLosses = 0, correctedCommandDisagreements = 0;
  for (const pace of ["batched", "continuous"] as const) {
    for (let seed = 0; seed < 300; seed++) {
      let run: HistoryResult;
      try {
        run = runHistory({
          pace, seed, steps: 40, scheme, auditTags: true, modes: schedule === "mixed" ? DELIVERIES : [schedule],
          onExtraPressUpdates: count => { multiUpdate.push({ pace, seed, count }); }
        });
      } catch (error) {
        failures.push({ pace, seed, message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      completed++;
      textOrFieldLosses += run.losses.length;
      const { stats } = run;
      for (const key of COUNTERS) counters[key] += stats[key];
      for (const [size, count] of Object.entries(stats.pressUpdates)) updates[Number(size)] = (updates[Number(size)] ?? 0) + count;
      const classified = stats.commandDifferences.map(difference => {
        if (difference.predicted !== difference.updated) correctedCommandDisagreements++;
        const shape = classifyCommand(difference);
        commands[shape] = (commands[shape] ?? 0) + 1;
        return { ...difference, shape };
      });
      for (const [summary, entries] of [[missing, stats.tagDifferences.filter(item => item.requests.length)],
        [extra, stats.tagDifferences.filter(item => !item.requests.length)]] as const) {
        const settled = entries.filter(item => item.copy === "settled");
        summary.histories += Number(entries.length > 0);
        summary.characters += countTags(entries);
        summary.settledHistories += Number(settled.length > 0);
        summary.settledCharacters += countTags(settled);
      }
      if (details && (classified.length || stats.tagDifferences.length || run.losses.length)) {
        cases.push({ pace, seed, clients: run.clients, steps: run.steps, commands: classified, tags: stats.tagDifferences, losses: run.losses });
      }
    }
  }
  return { scheme, schedule, completed, failures, textOrFieldLosses, counters, updates, multiUpdate, correctedCommandDisagreements, commands, missing, extra,
    ...(details ? { cases } : {}) };
}

if (process.argv[1]?.endsWith("chosen-report.ts")) {
  const schedules = process.argv.includes("--fixed") ? DELIVERIES : ["mixed"] as const;
  for (const schedule of schedules) {
    for (const scheme of ["act", "name", "chosen"] as const) {
      process.stdout.write(JSON.stringify(study(scheme, schedule, process.argv.includes("--details"))) + "\n");
    }
  }
}
