import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CurveRow, LifeResult, PatternRow } from "./life.ts";
import type { RaceSummary } from "./race.ts";

const n = (value: number): string => value.toLocaleString("en-US");
const ms = (value: number): string => value < 0.001 ? "under 0.001" : String(value);

export function lifeTables(runs: readonly LifeResult[], days: readonly number[]): string {
  const lines: string[] = [];
  for (const rate of [...new Set(runs.map(run => run.rate))]) {
    lines.push(`### ${rate}`, "", "| Writers | Day | Formatting actions so far | Keys per formatted character: median / p95 / max | Most keys of one kind on a character | Stored bytes | Bytes per formatting action that day | Mean bytes per formatting action | Reading the busiest cell, ms |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const run of runs.filter(item => item.rate === rate && item.scheme === "act")) for (const day of run.days.filter(row => days.includes(row.day))) {
      lines.push(`| ${run.writers} | ${day.day} | ${n(day.formattingTotal)} | ${day.keysMedian} / ${day.keysP95} / ${day.keysMax} | ${day.mostOfOneKind} | ${n(day.bytes)} | ${day.bytesPerFormatting} | ${day.meanBytesPerFormatting} | ${ms(day.readMs)} |`);
    }
    lines.push("");
  }
  lines.push("### Last day, three key schemes", "", "| Rate | Writers | Scheme | Stored bytes | Mean bytes per formatting action | Keys per formatted character: median / p95 / max | Most keys of one kind | Reading the busiest cell, ms | Mismatches with the model |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const run of runs) {
    const last = run.days.at(-1);
    if (last) lines.push(`| ${run.rate} | ${run.writers} | ${run.scheme} | ${n(last.bytes)} | ${last.meanBytesPerFormatting} | ${last.keysMedian} / ${last.keysP95} / ${last.keysMax} | ${last.mostOfOneKind} | ${ms(last.readMs)} | ${run.days.reduce((sum, day) => sum + day.mismatches, 0)} |`);
  }
  return lines.join("\n") + "\n";
}

export function patternTable(rows: readonly PatternRow[]): string {
  const lines = ["| Pattern | Actions | Scheme | Keys per formatted character: median / p95 / max | Bytes added | Bytes per action | Reading the cell, ms | Bytes added, all unformatted | Collapsed: stored bytes / read ms | Rebuilt: stored bytes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const row of rows) {
    lines.push(`| ${row.pattern} | ${n(row.actions)} | ${row.scheme} | ${row.keysMedian} / ${row.keysP95} / ${row.keysMax} | ${n(row.bytesAdded)} | ${row.bytesPerAction} | ${ms(row.readMs)} | ${n(row.afterUnformat)} | ${row.collapsed ? `${n(row.collapsed.bytes)} / ${ms(row.collapsed.readMs)}` : ""} | ${row.rebuilt ? n(row.rebuilt.bytes) : ""} |`);
  }
  return lines.join("\n") + "\n";
}

export function curveTable(rows: readonly CurveRow[]): string {
  const lines = ["| Acts | Keys per character: median / max | Pieces in the cell | Stored bytes | Reading the cell, ms | After collapse: stored bytes / read ms |", "| --- | --- | --- | --- | --- | --- |"];
  for (const row of rows) lines.push(`| ${row.acts} | ${row.keysMedian} / ${row.keysMax} | ${row.items} | ${n(row.bytes)} | ${ms(row.readMs)} | ${n(row.collapsedBytes)} / ${ms(row.collapsedReadMs)} |`);
  return lines.join("\n") + "\n";
}

export function raceTable(summaries: readonly RaceSummary[]): string {
  const lines = ["| Writers | Delivery | Histories | Commands run | Histories where the rule fired | Keys turned off | Rule raced with typing / formatting / unformatting / deleting / undo / own undo | Histories that differ | Copies disagree, without / with |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const row of summaries) {
    const raced = row.raced;
    lines.push(`| ${row.writers} | ${row.delivery} | ${n(row.histories)} | ${n(row.executed)} | ${n(row.historiesNormalised)} | ${n(row.keysTurnedOff)} | ${raced.typing} / ${raced.formatting} / ${raced.unformatting} / ${raced.deleting} / ${raced.undo} / ${raced["own-undo"]} | ${row.differing} | ${row.divergedWithout} / ${row.divergedWith} |`);
  }
  for (const row of summaries) if (row.shortest) lines.push("", `${row.writers} writers, ${row.delivery}: ${row.shortest.described.join("; ")}. Without the rule \`${row.shortest.without}\`, with it \`${row.shortest.with}\` (${row.shortest.copy}).`);
  return lines.join("\n") + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const read = (path: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Record<string, unknown>;
  const life = ["realistic", "heavy"].flatMap(rate => ["1", "2", "6"].flatMap(writers => read(`./life-${rate}-${writers}.json`).life as LifeResult[]));
  const patterns = read("./patterns.json"), race = read("./race.json");
  process.stdout.write(["## Life", lifeTables(life, [1, 25, 100, 250]), "## Patterns", patternTable(patterns.patterns as PatternRow[]),
    "## Curve", curveTable(patterns.curve as CurveRow[]), `Undo after collapse: ${JSON.stringify(patterns.undoAfterCollapse)}`, "", "## Race", raceTable(race.summaries as RaceSummary[])].join("\n"));
}
