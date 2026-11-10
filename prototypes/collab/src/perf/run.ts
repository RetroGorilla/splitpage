import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, freemem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import * as Y from "yjs";
import { fromDocument, toDocument } from "../proj/document.ts";
import { isProjectionEntry } from "../proj/entry.ts";
import { records } from "../proj/value.ts";
import type { SchemaCandidate } from "../schema.ts";
import { perfFixtures } from "./fixtures.ts";
import type { PerfFixture } from "./fixtures.ts";
import { measureEdits } from "./measure.ts";
import { applyWritingCycle, historyMix, retainedCounts } from "./history.ts";
import { beforeMeasurement, cpuBusy, perfMachine } from "./conditions.ts";
import type { measureLoad } from "./load.ts";
import { perfSourceDigest, validatePerfSetup } from "./setup.ts";
import type { plannedPerfSetup } from "./setup.ts";

export interface PerfCheckpoint {
  operations: number;
  encodedBytes: number;
  counts: ReturnType<typeof retainedCounts>;
  load: ReturnType<typeof measureLoad>;
}

export interface PerfRun {
  round: number;
  candidate: SchemaCandidate;
  fixture: string;
  condition: Awaited<ReturnType<typeof beforeMeasurement>>;
  cpuAfter: number;
  valid: boolean;
  edits: ReturnType<typeof measureEdits>;
  checkpoints: PerfCheckpoint[];
  historyElapsedMs: number;
  afterHistory: ReturnType<typeof measureEdits>;
}

export interface PerfEvidence {
  version: number;
  machine: ReturnType<typeof perfMachine>;
  sourceHead: string;
  sourceDigest: string;
  method: { rounds: number; warmup: number; samplesPerCase: number; historyCycles: number; historyMix: typeof historyMix; locks: string[]; otherLoad: string };
  fixtures: { name: string; copies: number; beats: number; fileBytes: number; sha256: string }[];
  runs: PerfRun[];
  refusedStarts: Awaited<ReturnType<typeof beforeMeasurement>>[];
}

function checkpoint(replica: ReturnType<typeof fromDocument>, operations: number, directory: string): PerfCheckpoint {
  if (freemem() < 3 * 1024 ** 3) throw new Error("Checkpoint refused below 3 GiB free RAM");
  const state = Y.encodeStateAsUpdate(replica.doc);
  const path = join(directory, "checkpoint.bin");
  writeFileSync(path, state);
  const output = execFileSync(process.execPath, ["--expose-gc", fileURLToPath(new URL("load.ts", import.meta.url)), replica.candidate, path], { encoding: "utf8", windowsHide: true, maxBuffer: 1024 ** 2 });
  return { operations, encodedBytes: state.length, counts: retainedCounts(replica), load: JSON.parse(output) as ReturnType<typeof measureLoad> };
}

function runCandidate(input: PerfFixture, candidate: SchemaCandidate, directory: string) {
  const replica = fromDocument(input.document, candidate, 10);
  let edits: ReturnType<typeof measureEdits>;
  const checkpoints: PerfCheckpoint[] = [];
  try {
    checkpoints.push(checkpoint(replica, 0, directory));
    edits = measureEdits(replica);
  } finally { replica.destroy(); }
  let afterHistory: ReturnType<typeof measureEdits> = [];
  let historyElapsedMs = 0;
  if (input.name === "large") {
    const writer = fromDocument(input.document, candidate, 10);
    const ids = records(input.document.rows).map(row => String(row.id));
    const comments = records(input.document.comments).map(comment => String(comment.id));
    try {
      let operations = 0;
      const start = performance.now();
      for (let cycle = 0; cycle < 500; cycle++) {
        operations += applyWritingCycle(writer, cycle, ids[cycle % ids.length] as string, comments[cycle % comments.length] as string);
        if ([99, 249, 499].includes(cycle)) checkpoints.push(checkpoint(writer, operations, directory));
      }
      historyElapsedMs = performance.now() - start;
      afterHistory = measureEdits(writer);
      if (records(toDocument(writer.doc, candidate).rows).length < 800) throw new Error("Writing history lost split beats");
    } finally { writer.destroy(); }
  }
  return { edits, checkpoints, historyElapsedMs, afterHistory };
}

export async function runMeasurements(): Promise<PerfEvidence> {
  if (!globalThis.gc) throw new Error("Run with --expose-gc");
  if (freemem() < 3 * 1024 ** 3) throw new Error("Run refused below 3 GiB free RAM");
  const inputs = perfFixtures();
  validatePerfSetup(JSON.parse(readFileSync(new URL("setup.json", import.meta.url), "utf8")) as ReturnType<typeof plannedPerfSetup>);
  const sourceDigest = perfSourceDigest();
  let evidence: PerfEvidence = { version: 1, machine: perfMachine(), sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceDigest,
    method: { rounds: 5, warmup: 3, samplesPerCase: 11, historyCycles: 500, historyMix, locks: ["perf", "smoke"], otherLoad: "The owner is playing a lighter game during this session. Other lanes, browser applications and background processes are running; perf/smoke locks held. Per-run before/after CPU records background load. No own tests concurrent." },
    fixtures: inputs.map(input => ({ name: input.name, copies: input.copies, beats: records(input.document.rows).length, fileBytes: input.fileBytes, sha256: input.sha256 })), runs: [], refusedStarts: [] };
  if (process.argv.includes("--resume")) {
    const saved = JSON.parse(readFileSync(new URL("results.json", import.meta.url), "utf8")) as PerfEvidence;
    if (saved.sourceDigest !== sourceDigest || JSON.stringify(saved.fixtures) !== JSON.stringify(evidence.fixtures)) throw new Error("Cannot resume measurements from different source or fixtures");
    evidence = saved;
  }
  const directory = mkdtempSync(join(tmpdir(), "perf-"));
  try {
    for (let round = 0; round < 5; round++) for (const input of inputs) for (const candidate of (round % 2 ? ["B", "A"] : ["A", "B"]) as SchemaCandidate[]) {
      if (evidence.runs.some(run => run.valid && run.round === round && run.fixture === input.name && run.candidate === candidate)) continue;
      let accepted = false;
      for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
        globalThis.gc(); globalThis.gc();
        const condition = await beforeMeasurement();
        if (condition.freeMemoryBytes < 3 * 1024 ** 3 || condition.cpuBefore > 35 || condition.forbiddenProcesses.length) {
          evidence.refusedStarts.push(condition);
          writeFileSync(new URL("results.json", import.meta.url), JSON.stringify(evidence, null, 2) + "\n");
          process.stdout.write(`guard refused (${attempt + 1}/3): RAM ${(condition.freeMemoryBytes / 1024 ** 3).toFixed(2)} GiB, CPU ${condition.cpuBefore.toFixed(1)}%, processes ${condition.forbiddenProcesses.join(",")}\n`);
          if (attempt < 2) await delay(30000);
          continue;
        }
        process.stdout.write(`round ${round + 1} ${input.name} ${candidate}, free ${(condition.freeMemoryBytes / 1024 ** 3).toFixed(2)} GiB\n`);
        const result = runCandidate(input, candidate, directory);
        const cpuAfter = await cpuBusy();
        accepted = cpuAfter <= 35;
        evidence.runs.push({ round, fixture: input.name, candidate, condition, cpuAfter, valid: accepted, ...result });
        writeFileSync(new URL("results.json", import.meta.url), JSON.stringify(evidence, null, 2) + "\n");
        if (!accepted) {
          process.stdout.write(`void run (${attempt + 1}/3): CPU after ${cpuAfter.toFixed(1)}%; raw run retained\n`);
          if (attempt < 2) await delay(30000);
        }
      }
      if (!accepted) throw new Error("Stopped after three consecutive guard refusals; coordinator report required");
    }
    return evidence;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

if (isProjectionEntry(import.meta.url) && process.argv.includes("--write")) await runMeasurements();
if (isProjectionEntry(import.meta.url) && process.argv.includes("--check")) {
  const { validateStructuralEvidence } = await import("./report.ts");
  validatePerfSetup(JSON.parse(readFileSync(new URL("setup.json", import.meta.url), "utf8")) as ReturnType<typeof plannedPerfSetup>);
  const { readStructuralEvidence } = await import("./report.ts");
  validateStructuralEvidence(readStructuralEvidence());
  process.stdout.write("Prepared recorder method, source hash and structural evidence valid; no timings executed or gated.\n");
}
