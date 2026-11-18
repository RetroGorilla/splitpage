import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CurveRow, LifeResult, PatternRow } from "./life.ts";
import type { RaceSummary } from "./race.ts";

const n = (value: number): string => value.toLocaleString("en-US");
const ms = (value: number): string => value < 0.001 ? "under 0.001" : String(value);

export function lifeTables(runs: readonly LifeResult[]): string {
  const lines: string[] = [];
  for (const rate of [...new Set(runs.map(run => run.rate))]) {
    lines.push(`### ${rate}`, "", "| Writers | Day | Visible characters / actions so far | Kind keys | Action keys | Action keys + rule |",
      "| --- | --- | --- | --- | --- | --- |");
    const cohort = runs.filter(run => run.rate === rate);
    for (const writers of [...new Set(cohort.map(run => run.writers))]) {
      const byScheme = cohort.filter(run => run.writers === writers), days = [...new Set(byScheme.flatMap(run => run.days.map(row => row.day)))];
      for (const day of days) {
        const cells = ["name", "act", "act+norm"].map(scheme => byScheme.find(run => run.scheme === scheme)?.days.find(row => row.day === day));
        const row = cells.find(value => value !== undefined);
        const format = (value: typeof row): string => value
          ? `${n(value.bytes)} · ${value.bytesPerFormatting}/${value.meanBytesPerFormatting} · ${value.keysMedian}/${value.keysP95}/${value.keysMax}/${value.mostOfOneKind} · ${ms(value.readMs)}`
          : "—";
        if (row) lines.push(`| ${writers} | ${day} | ${n(row.characters)} / ${n(row.formattingTotal)} | ${cells.map(format).join(" | ")} |`);
      }
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

export function patternTable(rows: readonly PatternRow[]): string {
  const lines = ["| Pattern | Actions | Scheme | Keys per formatted character: median / p95 / max | Stored bytes (at start) | Bytes per action | Reading the cell, ms | Stored bytes, all unformatted | Collapsed: stored bytes / read ms | Rebuilt: stored bytes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const row of rows) {
    lines.push(`| ${row.pattern} | ${n(row.actions)} | ${row.scheme} | ${row.keysMedian} / ${row.keysP95} / ${row.keysMax} | ${n(row.bytes)} (${n(row.bytes - row.bytesAdded)}) | ${row.bytesPerAction} | ${ms(row.readMs)} | ${n(row.afterUnformat + row.bytes - row.bytesAdded)} | ${row.collapsed ? `${n(row.collapsed.bytes)} / ${ms(row.collapsed.readMs)}` : ""} | ${row.rebuilt ? n(row.rebuilt.bytes) : ""} |`);
  }
  return lines.join("\n") + "\n";
}

export function curveTable(rows: readonly CurveRow[]): string {
  const lines = ["| Actions | Keys per formatted character (median / max) | Delta pieces | Stored bytes | Read (ms) | Limit scan (ms) | Collapsed bytes / read (ms) |", "| --- | --- | --- | --- | --- | --- | --- |"];
  for (const row of rows) lines.push(`| ${row.acts} | ${row.keysMedian} / ${row.keysMax} | ${row.items} | ${n(row.bytes)} | ${ms(row.readMs)} | ${ms(row.limitScanMs)} | ${n(row.collapsedBytes)} / ${ms(row.collapsedReadMs)} |`);
  return lines.join("\n") + "\n";
}

export function raceTable(summaries: readonly RaceSummary[]): string {
  const lines = ["| Writers | Delivery | Histories | Rule fired | Concurrent typing / format / unformat / deletion / undo / own undo | Differed | Still differed without undo | Stopped at first difference | Disagreed without / with rule |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const row of summaries) {
    const raced = row.raced;
    lines.push(`| ${row.writers} | ${row.delivery} | ${n(row.histories)} | ${n(row.historiesNormalised)} | ${raced.typing} / ${raced.formatting} / ${raced.unformatting} / ${raced.deleting} / ${raced.undo} / ${raced["own-undo"]} | ${row.differing} | ${row.differingWithoutUndo} | ${row.stoppedEarly} | ${row.divergedWithout} / ${row.divergedWith} |`);
  }
  return lines.join("\n") + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const inputs = process.argv.slice(2).map(path => JSON.parse(readFileSync(path, "utf8").trimStart()) as Record<string, unknown>);
  if (!inputs.length) throw new Error("Pass the files produced by life.ts or race.ts");
  const order = (run: LifeResult): number => ["realistic", "heavy"].indexOf(run.rate) * 1000 + run.writers * 10 + ["act", "act+norm", "name"].indexOf(run.scheme);
  const life = inputs.flatMap(input => (input.life as LifeResult[] | undefined) ?? []).sort((a, b) => order(a) - order(b));
  const patterns = inputs.flatMap(input => (input.patterns as PatternRow[] | undefined) ?? []);
  const curve = inputs.findLast(input => input.curve)?.curve as CurveRow[] | undefined;
  const race = inputs.flatMap(input => (input.summaries as RaceSummary[] | undefined) ?? []);
  const tables: string[] = [];
  if (life.length) tables.push(lifeTables(life));
  if (patterns.length) tables.push(patternTable(patterns));
  if (curve) tables.push(curveTable(curve));
  if (race.length) tables.push(raceTable(race));
  process.stdout.write(tables.join("\n"));
}
