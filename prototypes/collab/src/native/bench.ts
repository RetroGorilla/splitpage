import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { records } from "../proj/value.ts";
import { scaledDemo, typingTape } from "./tape.ts";

const MAIN = fileURLToPath(new URL("../../../../tests/collab/measure/native-spike-main.mjs", import.meta.url));
const VARIANT = fileURLToPath(new URL("./subject.mjs", import.meta.url));
const SUBJECTS = { main: [MAIN], variant: [VARIANT, "name"], variantAct: [VARIANT, "act"] } as const;
type SubjectName = keyof typeof SUBJECTS;
const NAMES: readonly SubjectName[] = ["main", "variant", "variantAct"];
const TITLES: Record<SubjectName, string> = { main: "Main", variant: "Variant, one key per mark name", variantAct: "Variant, one key per formatting act" };

export interface TimingSummary { n: number; median: number; p95: number; max: number; updatesPerKeystroke?: number; updateBytes?: number }
interface SizeResult { fresh: number; bytes: number; text: { id: string; audio: string; visual: string }[]; extra: number; extraBytes: number }
type SizeNumbers = Omit<SizeResult, "text">;
export interface SizeRow { writers: number; copies: number; typed: number; finalCharacters: number; agree: boolean; firstDifference: string | null;
  main: SizeNumbers | null; variant: SizeNumbers; variantAct: SizeNumbers }
export interface TimingRow { beats: number; pretype: number; main: TimingSummary[]; variant: TimingSummary[]; variantAct: TimingSummary[] }
export interface BenchResults {
  node: string; arch: string; commit: string; rounds: number; samples: number; warmup: number;
  tape: { typed: number; atoms: number; corrections: number; revisionDeletes: number; finalCharacters: number };
  size: SizeRow[]; typing: TimingRow[]; remote: TimingRow[];
}

function sharedBlock(path: string): string {
  const source = readFileSync(path, "utf8").replace(/\r\n/g, "\n"), start = source.indexOf("// why: bench.ts requires"), end = source.indexOf("export { measure };");
  if (start < 0 || end < start) throw new Error("Missing shared measurement block");
  return source.slice(start, end);
}

function run(directory: string, name: SubjectName, label: string, job: unknown): unknown {
  const input = join(directory, `${label}.job.json`), output = join(directory, `${label}.${name}.json`), [script, ...rest] = SUBJECTS[name];
  writeFileSync(input, JSON.stringify(job));
  const started = Date.now();
  const result = spawnSync(process.execPath, ["--expose-gc", "--max-old-space-size=8192", script, input, output, ...rest], { stdio: ["ignore", "inherit", "inherit"] });
  if (result.status !== 0) throw new Error(`${name} failed on ${label}`);
  process.stderr.write(`${label} ${name}: ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
  return JSON.parse(readFileSync(output, "utf8"));
}

function firstDifference(a: SizeResult["text"], b: SizeResult["text"]): string | null {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index], right = b[index];
    if (!left || !right || left.id !== right.id) return `row ${index}: ${left?.id ?? "none"} / ${right?.id ?? "none"}`;
    for (const field of ["audio", "visual"] as const) if (left[field] !== right[field]) {
      let at = 0;
      while (left[field].charAt(at) === right[field].charAt(at)) at++;
      return `${left.id} ${field} at ${at}: ${JSON.stringify(left[field].slice(at, at + 12))} / ${JSON.stringify(right[field].slice(at, at + 12))}`;
    }
  }
  return null;
}

const strip = (result: SizeResult): SizeNumbers => ({ fresh: result.fresh, bytes: result.bytes, extra: result.extra, extraBytes: result.extraBytes });

export function bench(options: { rounds: number; samples: number; warmup: number; volume: number; only: ReadonlySet<string> }): BenchResults {
  if (sharedBlock(MAIN) !== sharedBlock(VARIANT)) throw new Error("The two subjects do not share one measurement block");
  const directory = mkdtempSync(join(tmpdir(), "native-spike-"));
  const tape = typingTape(2);
  const results: BenchResults = { node: process.version, arch: process.arch, commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    rounds: options.rounds, samples: options.samples, warmup: options.warmup,
    tape: { typed: tape.typed, atoms: tape.atoms, corrections: tape.corrections, revisionDeletes: tape.revisionDeletes, finalCharacters: tape.finalCharacters },
    size: [], typing: [], remote: [] };
  try {
    const sizes = [[2, 1], [6, 1], ...(options.volume > 1 ? [[2, options.volume]] : [])] as [number, number][];
    if (options.only.has("size")) for (const [writers, copies] of sizes) {
      const current = typingTape(writers, copies), first = String(records(current.document.rows)[0]?.id), label = `size-${writers}-${copies}`;
      const job = { kind: "size", document: current.document, writers, ops: current.ops, beat: first, extra: 1000 };
      const variant = run(directory, "variant", label, job) as SizeResult, variantAct = run(directory, "variantAct", label, job) as SizeResult;
      const main = copies === 1 ? run(directory, "main", label, job) as SizeResult : null;
      const difference = firstDifference(variant.text, variantAct.text) ?? (main ? firstDifference(main.text, variant.text) : null);
      results.size.push({ writers, copies, typed: current.typed, finalCharacters: variant.text.reduce((sum, row) => sum + row.audio.length + row.visual.length, 0),
        agree: difference === null, firstDifference: difference, main: main ? strip(main) : null, variant: strip(variant), variantAct: strip(variantAct) });
    }
    const cases = [{ beats: 30, pretype: 0 }, { beats: 300, pretype: 0 }, { beats: 900, pretype: 0 }, { beats: 30, pretype: 1000 }];
    for (const kind of ["typing", "remote"] as const) {
      if (!options.only.has(kind)) continue;
      for (const item of cases) {
        if (kind === "remote" && item.pretype) continue;
        const document = scaledDemo(item.beats / 30), beat = String(records(document.rows)[0]?.id);
        const row: TimingRow = { ...item, main: [], variant: [], variantAct: [] };
        for (let round = 0; round < options.rounds; round++) {
          for (const name of round % 2 ? [...NAMES].reverse() : NAMES) {
            row[name].push(run(directory, name, `${kind}-${item.beats}-${item.pretype}`,
              { kind, document, beat, pretype: item.pretype, samples: options.samples, warmup: options.warmup }) as TimingSummary);
          }
        }
        results[kind].push(row);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
  return results;
}

const middle = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? NaN;
const spread = (rows: TimingSummary[], pick: (row: TimingSummary) => number, digits: number): string => {
  const values = rows.map(pick);
  return `${middle(values).toFixed(digits)} [${Math.min(...values).toFixed(digits)}–${Math.max(...values).toFixed(digits)}]`;
};

export function benchReport(results: BenchResults): string {
  const lines = [`Commit ${results.commit}, Node ${results.node} ${results.arch}. ${results.rounds} rounds per timing case, rotating which subject runs first;`,
    `each round times ${results.samples} keystrokes after ${results.warmup} untimed ones. Timing cells are the median of the per-round values [smallest–largest].`, "",
    `Typing tape: ${results.tape.typed} typed characters, ${results.tape.atoms} inline atoms, ${results.tape.corrections} corrections, ${results.tape.revisionDeletes} range deletions.`, "",
    "| Tape | Writers | Typed characters | Final characters | Same final text | Subject | Fresh bytes | Bytes after tape | Bytes per typed character | Bytes for 1,000 more keystrokes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const row of results.size) for (const name of NAMES) {
    const value = row[name];
    lines.push(`| ${row.copies}× | ${row.writers} | ${row.typed} | ${row.finalCharacters} | ${row.agree ? "yes" : "no: " + String(row.firstDifference)} | ${TITLES[name]} | ` +
      (value ? `${value.fresh} | ${value.bytes} | ${((value.bytes - value.fresh) / row.typed).toFixed(2)} | ${value.extraBytes} |` : "not measured | not measured | not measured | not measured |"));
  }
  for (const [title, rows] of [["Local keystroke commit", results.typing], ["One remote keystroke applied", results.remote]] as const) {
    lines.push("", `| ${title} | Subject | Samples per round | Median ms | p95 ms |`, "| --- | --- | --- | --- | --- |");
    for (const row of rows) for (const name of NAMES) {
      const digits = name === "main" ? 2 : 3;
      lines.push(`| ${row.beats} beats${row.pretype ? `, after ${row.pretype} characters typed in one beat` : ""} | ${TITLES[name]} | ${row[name][0]?.n ?? 0} | ${spread(row[name], value => value.median, digits)} | ${spread(row[name], value => value.p95, digits)} |`);
    }
  }
  if (results.remote.length) {
    lines.push("", "| Update for one keystroke | Subject | Updates | Bytes |", "| --- | --- | --- | --- |");
    for (const row of results.remote) for (const name of NAMES) lines.push(`| ${row.beats} beats | ${TITLES[name]} | ${row[name][0]?.updatesPerKeystroke ?? ""} | ${row[name][0]?.updateBytes ?? ""} |`);
  }
  return lines.join("\n") + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const flag = (name: string, fallback: number): number => Number(process.argv.find(value => value.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
  const only = process.argv.find(value => value.startsWith("--only="))?.split("=")[1]?.split(",") ?? ["size", "typing", "remote"];
  const output = process.argv.find(value => value.startsWith("--write="))?.split("=")[1];
  const results = bench({ rounds: flag("rounds", 3), samples: flag("samples", 200), warmup: flag("warmup", 20), volume: flag("volume", 10), only: new Set(only) });
  if (output) writeFileSync(output, JSON.stringify(results, null, 2) + "\n");
  process.stdout.write(benchReport(results));
}
