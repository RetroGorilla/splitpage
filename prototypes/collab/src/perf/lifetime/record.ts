import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, freemem } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { isProjectionEntry } from "../../proj/entry.ts";
import { beforeMeasurement, cpuBusy, perfMachine } from "../conditions.ts";
import { percentile } from "../measure.ts";
import { redactPerfText } from "../privacy.ts";
import type { collectLifetimeCounts } from "./counts.ts";
import { lifetimeProbe } from "./probe.ts";
import { lifetimeSources } from "./source.ts";
import { canonicalLifetimeSource, lifetimePlan } from "./workload.ts";

export interface LifetimeCountEvidence {
  version: number;
  source: ReturnType<typeof lifetimeSources>;
  node: string;
  instrumentation: { source: string; sha256: string }[];
  data: ReturnType<typeof collectLifetimeCounts>;
}

export const lifetimeTimingMethod = { rounds: 5, warmup: 3, samples: 11, minFreeMemoryBytes: 3 * 1024 ** 3, maxCpuBusyPercent: 35,
  maxConsecutiveRefusals: 3, retryDelayMs: 30000, locks: ["perf", "smoke"],
  otherLoad: "A game was running on the PC during this session; accepted runs retain background CPU before/after and free RAM. Node components omit paint, app derivations, M1 gate/queue, real network, blobs and join/load." };

export function lifetimeSnapshotDirectory(): string { return join(tmpdir(), "collab-b-lifetime-snapshots"); }

export async function recordLifetimeCounts(directory = lifetimeSnapshotDirectory()): Promise<LifetimeCountEvidence> {
  const source = lifetimeSources();
  mkdirSync(directory, { recursive: true });
  const instrumentation: LifetimeCountEvidence["instrumentation"] = [];
  const result = await build({ entryPoints: [fileURLToPath(new URL("count-worker.ts", import.meta.url))], bundle: true, write: false, platform: "node", format: "esm", target: "es2023",
    alias: { yjs: fileURLToPath(new URL("../../../node_modules/yjs/src/index.js", import.meta.url)) },
    plugins: [{ name: "lifetime-public-identity-counters", setup(builder) {
      builder.onLoad({ filter: /[\\/]yjs[\\/]src[\\/]utils[\\/](RelativePosition|StructStore)\.js$/ }, args => {
        let source = readFileSync(args.path, "utf8");
        instrumentation.push({ source: args.path.split(/[\\/]/).slice(-4).join("/"), sha256: createHash("sha256").update(source).digest("hex") });
        const needles = args.path.endsWith("RelativePosition.js") ? [["while (t !== null) {", "relativeItems"], ["while (n !== null) {", "absoluteItems"]]
          : [["let mid = structs[right]", "storeProbes"], ["mid = structs[midindex]", "storeProbes"]];
        for (const [needle, counter] of needles) {
          assert.ok(needle && counter); assert.equal(source.split(needle).length, 2);
          source = source.replace(needle, needle + `;if(globalThis.perfTraversal)globalThis.perfTraversal.${counter}++;`);
        }
        return { contents: source, loader: "js" };
      });
    } }] });
  assert.equal(instrumentation.length, 2);
  const code = result.outputFiles?.[0]?.text; assert.ok(code);
  const worker = join(directory, "counts.mjs"); writeFileSync(worker, code);
  const input = join(directory, "fixture.json"); writeFileSync(input, JSON.stringify(canonicalLifetimeSource()));
  const data = JSON.parse(execFileSync(process.execPath, [worker, directory, input], { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 ** 2 })) as ReturnType<typeof collectLifetimeCounts>;
  assert.deepEqual(lifetimeSources(), source, "Sources changed during count collection");
  return { version: 1, source, node: process.version, instrumentation: instrumentation.sort((a, b) => a.source.localeCompare(b.source)), data };
}

export function validateLifetimeCounts(value: LifetimeCountEvidence): void {
  assert.equal(value.version, 1); assert.deepEqual(value.source, lifetimeSources()); assert.equal(value.node, "v24.22.1");
  assert.deepEqual(value.data.plan, lifetimePlan); assert.equal(value.instrumentation.length, 2);
  assert.deepEqual(value.instrumentation.map(item => item.source), ["yjs/src/utils/RelativePosition.js", "yjs/src/utils/StructStore.js"]);
  for (const item of value.instrumentation) assert.equal(item.sha256, createHash("sha256").update(readFileSync(new URL(`../../../node_modules/${item.source}`, import.meta.url))).digest("hex"));
  assert.deepEqual(value.data.realistic.map(row => row.writers), [2, 6]);
  for (const row of value.data.realistic) {
    assert.ok(row.firstCap.encodedBytes >= lifetimePlan.capBytes);
    assert.ok(row.firstCap.previousStep && row.firstCap.previousStep.encodedBytes < lifetimePlan.capBytes);
    assert.ok(row.checkpoints.length >= 3); assert.equal(row.checkpoints[0]?.blocks, 1);
  }
  assert.deepEqual(value.data.synthetic.checkpoints.map(point => point.operations), [0, 10020, 25050, 50100]);
  const points = [...value.data.realistic.flatMap(row => row.checkpoints), ...value.data.synthetic.checkpoints];
  for (const point of points) {
    assert.ok(Object.values(point.bytes.categories).every(bytes => Number.isInteger(bytes) && bytes >= 0));
    assert.equal(Object.values(point.bytes.categories).reduce((sum, bytes) => sum + bytes, 0), point.bytes.encodedBytes);
    assert.equal(Object.values(point.bytes.otherRoots).reduce((sum, bytes) => sum + bytes, point.bytes.framingDeleteSetAndGcBytes), point.bytes.categories.other);
    assert.match(point.sha256, /^[a-f0-9]{64}$/);
    assert.equal(point.indexed.work.structure.records.statusEvents ?? 0, 0);
    assert.equal(point.indexed.value.projectedBeats, 1);
    assert.equal(point.indexed.work.apply.integratedItems, 1);
    assert.ok(point.indexed.work.capture.relativeItems > 0);
  }
}

export function readLifetimeCounts(): LifetimeCountEvidence { return JSON.parse(readFileSync(new URL("counts.json", import.meta.url), "utf8")) as LifetimeCountEvidence; }

export function lifetimeTimingPoints(evidence: LifetimeCountEvidence) {
  return [...evidence.data.realistic.flatMap(row => row.checkpoints.filter(point => point.blocks === 1 || point.blocks === 10 || point === row.checkpoints.at(-1))
    .map(point => ({ name: `realistic ${row.writers} writers / ${point.blocks} blocks`, snapshot: point.snapshot, sha256: point.sha256 }))),
    ...evidence.data.synthetic.checkpoints.filter(point => point.operations === 50100).map(point => ({ name: "synthetic / 50100 operations", snapshot: point.snapshot, sha256: point.sha256 }))];
}

function timedPoint(point: ReturnType<typeof lifetimeTimingPoints>[number], directory: string, order: readonly ("legacy" | "indexed")[]) {
  if (freemem() < lifetimeTimingMethod.minFreeMemoryBytes) throw new Error("RAM fell below the unchanged 3 GiB guard");
  const state = readFileSync(join(directory, point.snapshot));
  assert.equal(createHash("sha256").update(state).digest("hex"), point.sha256);
  const modes = [];
  for (const mode of order) {
    const probe = lifetimeProbe(state, mode), samples: NonNullable<ReturnType<ReturnType<typeof lifetimeProbe>["run"]>["milliseconds"]>[] = [];
    try {
      for (let trial = -lifetimeTimingMethod.warmup; trial < lifetimeTimingMethod.samples; trial++) {
        const value = probe.run(true); if (trial >= 0) { assert.ok(value.milliseconds); samples.push(value.milliseconds); }
      }
      const p50 = Object.fromEntries(Object.keys(samples[0] ?? {}).map(key => [key, percentile(samples.map(sample => sample[key as keyof typeof sample]), 0.5)]));
      const p95 = Object.fromEntries(Object.keys(samples[0] ?? {}).map(key => [key, percentile(samples.map(sample => sample[key as keyof typeof sample]), 0.95)]));
      modes.push({ mode, target: probe.target, samples, p50, p95 });
    } finally { probe.destroy(); globalThis.gc?.(); }
  }
  return { name: point.name, sha256: point.sha256, modes };
}

export interface LifetimeTimingEvidence {
  version: number; source: ReturnType<typeof lifetimeSources>; sourceHead: string; machine: ReturnType<typeof perfMachine>; method: typeof lifetimeTimingMethod;
  refused: Awaited<ReturnType<typeof beforeMeasurement>>[];
  runs: { round: number; before: Awaited<ReturnType<typeof beforeMeasurement>>; cpuAfter: number; valid: boolean; reason?: string; points: ReturnType<typeof timedPoint>[] }[];
}

export async function recordLifetimeTimings(directory = lifetimeSnapshotDirectory()): Promise<LifetimeTimingEvidence> {
  assert.equal(typeof globalThis.gc, "function", "Run Node with --expose-gc");
  assert.equal(process.version, "v24.22.1");
  const counts = readLifetimeCounts(); validateLifetimeCounts(counts);
  const evidence: LifetimeTimingEvidence = { version: 1, source: lifetimeSources(), sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    machine: perfMachine(), method: lifetimeTimingMethod, refused: [], runs: [] };
  const save = (): void => writeFileSync(new URL("timings.json", import.meta.url), JSON.stringify(evidence, null, 2) + "\n");
  for (let round = 0; round < lifetimeTimingMethod.rounds; round++) {
    let accepted = false;
    for (let attempt = 0; attempt < lifetimeTimingMethod.maxConsecutiveRefusals && !accepted; attempt++) {
      globalThis.gc?.(); const before = await beforeMeasurement();
      if (before.freeMemoryBytes < lifetimeTimingMethod.minFreeMemoryBytes || before.cpuBefore > lifetimeTimingMethod.maxCpuBusyPercent || before.forbiddenProcesses.length) {
        evidence.refused.push(before); save(); process.stdout.write(`guard refused ${attempt + 1}/3\n`);
      } else {
        const points: ReturnType<typeof timedPoint>[] = []; let reason: string | undefined;
        try { for (const point of lifetimeTimingPoints(counts)) points.push(timedPoint(point, directory, round % 2 ? ["indexed", "legacy"] : ["legacy", "indexed"])); }
        catch (error) { reason = error instanceof Error ? redactPerfText(error.message) : "Measurement failed"; }
        const cpuAfter = await cpuBusy(); accepted = !reason && cpuAfter <= lifetimeTimingMethod.maxCpuBusyPercent;
        evidence.runs.push({ round, before, cpuAfter, valid: accepted, ...(reason ? { reason } : {}), points }); save();
        process.stdout.write(`round ${round + 1}: ${accepted ? "accepted" : "void"}; CPU ${before.cpuBefore.toFixed(1)}/${cpuAfter.toFixed(1)}%; free ${(before.freeMemoryBytes / 1024 ** 3).toFixed(2)} GiB\n`);
      }
      if (!accepted && attempt < lifetimeTimingMethod.maxConsecutiveRefusals - 1) await delay(lifetimeTimingMethod.retryDelayMs);
    }
    if (!accepted) throw new Error("Stopped after three consecutive guard refusals; no timer retries remain");
  }
  assert.deepEqual(lifetimeSources(), evidence.source, "Sources changed during timing collection");
  return evidence;
}

export function validateLifetimeTimings(value: LifetimeTimingEvidence, counts = readLifetimeCounts()): void {
  assert.equal(value.version, 1);
  assert.deepEqual(value.source, counts.source); assert.deepEqual(value.method, lifetimeTimingMethod);
  assert.equal(value.machine.node, "v24.22.1"); assert.match(value.sourceHead, /^[a-f0-9]{40}$/);
  const valid = value.runs.filter(run => run.valid); assert.equal(valid.length, 5); assert.deepEqual(valid.map(run => run.round), [0, 1, 2, 3, 4]);
  for (const run of valid) {
    assert.ok(run.before.freeMemoryBytes >= lifetimeTimingMethod.minFreeMemoryBytes); assert.ok(run.before.cpuBefore <= 35 && run.cpuAfter <= 35);
    assert.deepEqual(run.before.forbiddenProcesses, []); assert.equal(run.reason, undefined);
    assert.deepEqual(run.points.map(point => point.name), lifetimeTimingPoints(counts).map(point => point.name));
    for (const [index, point] of run.points.entries()) {
      assert.equal(point.sha256, lifetimeTimingPoints(counts)[index]?.sha256);
      assert.equal(point.modes.length, 2);
      assert.deepEqual(point.modes.map(mode => mode.mode), run.round % 2 ? ["indexed", "legacy"] : ["legacy", "indexed"]);
      for (const mode of point.modes) {
        assert.equal(mode.samples.length, 11);
        const keys = ["applyExcludingIncremental", "incremental", "structure", "component", "capture", "resolve", "withIdentity"];
        assert.deepEqual(Object.keys(mode.p50), keys); assert.deepEqual(Object.keys(mode.p95), keys);
        for (const sample of mode.samples) {
          assert.deepEqual(Object.keys(sample), keys);
          assert.ok(Math.abs(sample.component - sample.applyExcludingIncremental - sample.incremental - sample.structure) < 0.000001);
          assert.ok(Math.abs(sample.withIdentity - sample.component - sample.capture - sample.resolve) < 0.000001);
        }
        for (const [key, median] of Object.entries(mode.p50)) {
          const samples = mode.samples.map(sample => sample[key as keyof typeof sample]);
          assert.ok(samples.every(sample => Number.isFinite(sample) && sample >= 0));
          assert.equal(median, percentile(samples, 0.5)); assert.equal(mode.p95[key], percentile(samples, 0.95));
        }
      }
    }
  }
}

if (isProjectionEntry(import.meta.url)) {
  const supplied = process.argv.indexOf("--snapshots"), directory = supplied >= 0 ? resolve(process.argv[supplied + 1] ?? "") : lifetimeSnapshotDirectory();
  if (process.argv.includes("--counts")) {
    const evidence = await recordLifetimeCounts(directory); validateLifetimeCounts(evidence);
    writeFileSync(new URL("counts.json", import.meta.url), JSON.stringify(evidence, null, 2) + "\n"); process.stdout.write("Deterministic lifetime counts recorded; no clock samples.\n");
  }
  if (process.argv.includes("--time")) await recordLifetimeTimings(directory);
  if (process.argv.includes("--check")) {
    const counts = readLifetimeCounts(); validateLifetimeCounts(counts);
    if (existsSync(new URL("timings.json", import.meta.url))) validateLifetimeTimings(JSON.parse(readFileSync(new URL("timings.json", import.meta.url), "utf8")) as LifetimeTimingEvidence, counts);
    process.stdout.write("Lifetime source, count structure and timing method valid; no timing thresholds checked.\n");
  }
}
