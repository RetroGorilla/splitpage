import { writeFileSync } from "node:fs";
import { cpus, freemem, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import * as Y from "yjs";
import { fromDocument, toDocument } from "./document.ts";
import { assertProjectionInput, projectionReferences, serializeProjection } from "./reference.ts";
import { isProjectionEntry } from "./entry.ts";
import { differences } from "./experiment.ts";
import { copy, records } from "./value.ts";
import type { ProjectionBag } from "./value.ts";

export function largeProjectionFixture(base: ProjectionBag): ProjectionBag {
  const result = copy(base);
  const rows: ProjectionBag[] = [], comments: ProjectionBag[] = [], shots: ProjectionBag[] = [];
  for (let index = 0; index < 10; index++) {
    const suffix = index ? `-${index}` : "";
    const retag = (value: unknown): unknown => typeof value === "string"
      ? value.replace(/(data-cmt|data-broll-id)="([^"]*)"/g, (_whole, attribute: string, id: string) => `${attribute}="${id}${suffix}"`)
      : value;
    for (const row of records(base.rows)) {
      const value = copy(row);
      value.id = String(row.id) + suffix;
      value.visualText = retag(value.visualText);
      value.audioText = retag(value.audioText);
      rows.push(value);
    }
    for (const comment of records(base.comments)) {
      const value = copy(comment);
      value.id = String(comment.id) + suffix;
      value.rowId = String(comment.rowId) + suffix;
      if (value.anchorId) value.anchorId = String(value.anchorId) + suffix;
      comments.push(value);
    }
    for (const shot of records(base.brollShots)) {
      const value = copy(shot);
      value.id = String(shot.id) + suffix;
      shots.push(value);
    }
  }
  Object.assign(result, { rows, comments, brollShots: shots });
  return result;
}

function cpuSnapshot(): { idle: number; total: number } {
  return cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
}

function distribution(samples: readonly number[]): { median: number; min: number; max: number; samples: readonly number[] } {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] as number : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  return { median, min: sorted[0] as number, max: sorted.at(-1) as number, samples };
}

export function measureProjectionCosts(rounds = 5) {
  if (rounds < 5) throw new Error("At least five measured runs are required");
  const references = projectionReferences();
  let largest = 0;
  references.forEach((reference, index) => {
    if (reference.appSaved.bytes > (references[largest]?.appSaved.bytes ?? 0)) largest = index;
  });
  const longIndex = references.findIndex(fixture => fixture.name === "src/starters/long-demo.json");
  const long = references[longIndex];
  if (!long) throw new Error("Missing long demo");
  const large = projectionReferences("experiment-reference.json").find(reference => reference.name === "cost/large");
  const biggest = references[largest];
  if (!large || !biggest) throw new Error("Missing cost input");
  assertProjectionInput(large, largeProjectionFixture(long.document));
  const inputs = [
    { ...biggest, label: "largest canonical", source: biggest.name },
    { ...large, label: "large", source: "tools/perf-record.mjs SCALE, long demo x10" }
  ];
  const before = cpuSnapshot();
  const memoryBefore = freemem();
  const rows = [];
  for (const input of inputs) {
    const samples = { A: { from: [] as number[], full: [] as number[], after: [] as number[], bytes: [] as number[] }, B: { from: [] as number[], full: [] as number[], after: [] as number[], bytes: [] as number[] } };
    for (const candidate of ["A", "B"] as const) {
      const warmup = fromDocument(input.document, candidate);
      try {
        if (differences(input.document, toDocument(warmup.doc, candidate)).length) throw new Error("Cost fixture failed its untimed full-document equality check");
      } finally { warmup.destroy(); }
    }
    for (let run = 0; run < rounds; run++) for (const candidate of run % 2 ? ["B", "A"] as const : ["A", "B"] as const) {
      const start = performance.now();
      const replica = fromDocument(input.document, candidate);
      samples[candidate].from.push(performance.now() - start);
      try {
        samples[candidate].bytes.push(Y.encodeStateAsUpdate(replica.doc).byteLength);
        const full = performance.now();
        toDocument(replica.doc, candidate);
        samples[candidate].full.push(performance.now() - full);
        const rows = records(input.document.rows);
        const row = rows[Math.floor(rows.length / 2)];
        if (!row) throw new Error("Cost fixture needs a beat");
        const location = replica.locate(String(row.id));
        location.text.insert(location.start + Math.min(1, location.end - location.start), "x", {});
        const after = performance.now();
        const edited = toDocument(replica.doc, candidate);
        samples[candidate].after.push(performance.now() - after);
        const changed = differences(input.document, edited);
        if (changed.length !== 1 || changed[0]?.path !== `$.rows.${Math.floor(rows.length / 2)}.audioText`) throw new Error("Cost edit did not change exactly the target narration field");
      } finally { replica.destroy(); }
    }
    for (const candidate of ["A", "B"] as const) {
      const data = samples[candidate];
      if (new Set(data.bytes).size !== 1) throw new Error("Fresh encoded size changed across runs");
      const encodedBytes = data.bytes[0] as number;
      const fileBytes = input.appSaved.bytes;
      if (Buffer.byteLength(serializeProjection(input.document)) !== fileBytes) throw new Error("Cost file encoding differs from the reference");
      rows.push({ fixture: input.label, source: input.source, candidate, beats: records(input.document.rows).length,
        fileBytes, encodedBytes, ratio: encodedBytes / fileBytes, fromDocumentMs: distribution(data.from),
        fullToDocumentMs: distribution(data.full), afterCharacterMs: distribution(data.after), incremental: false });
    }
  }
  const after = cpuSnapshot();
  return {
    measuredAt: new Date().toISOString(), machine: "<machine>", cpu: cpus()[0]?.model, architecture: process.arch,
    platform: process.platform, osRelease: release(), totalMemoryBytes: totalmem(), freeMemoryBefore: memoryBefore, freeMemoryAfter: freemem(),
    aggregateCpuBusyPercent: 100 * (1 - (after.idle - before.idle) / (after.total - before.total)),
    node: process.version, yjs: "13.6.33", rounds, warmupPerInputCandidate: 1,
    fixtureGenerator: "SCALE.grow in tools/perf-record.mjs; no browser, openFile, server or rendering", rows
  };
}

if (isProjectionEntry(import.meta.url) && process.argv.includes("--write")) {
  const result = measureProjectionCosts();
  writeFileSync(new URL("cost-results.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

