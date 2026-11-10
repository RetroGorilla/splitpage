import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, platform, release, arch } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import * as Y from "yjs";
import { UpdateJournal } from "./journal.ts";

const directory = resolve(process.argv[2] ?? tmpdir());
const output = process.argv[3];
const repetitions = 3;
const results: Record<string, unknown>[] = [];
function percentile(values: readonly number[], fraction: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  return Number((ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] ?? 0).toFixed(4));
}
for (const batchSize of [1, 5]) {
  for (const workload of ["typing", "burst"]) {
    const milliseconds: number[] = [];
    const amortized: number[] = [];
    const payloadSizes: number[] = [];
    let totalUpdates = 0;
    for (let repetition = 0; repetition < repetitions; repetition++) {
      const folder = await mkdtemp(join(directory, "journal-cost-"));
      const journal = new UpdateJournal(join(folder, "updates.sqlite"));
      journal.database.exec("PRAGMA wal_autocheckpoint=0");
      const doc = new Y.Doc();
      doc.clientID = 11;
      try {
        journal.append("fixture", [Y.encodeStateAsUpdate(doc)]);
        let batch: Uint8Array[] = [];
        doc.on("update", (update: Uint8Array) => { batch.push(update); payloadSizes.push(update.length); });
        const count = workload === "typing" ? 50 : 1000;
        for (let index = 0; index < count; index++) {
          if (workload === "typing") await delay(100);
          doc.getText("R1").insert(index, "a");
          if (batch.length < batchSize && index < count - 1) continue;
          const start = performance.now();
          journal.append("fixture", batch);
          const elapsed = performance.now() - start;
          milliseconds.push(elapsed);
          amortized.push(elapsed / batch.length);
          totalUpdates += batch.length;
          batch = [];
        }
      } finally { doc.destroy(); journal.close(); await rm(folder, { recursive: true, force: true }); }
    }
    results.push({
      workload, batchSize, repetitions, updates: totalUpdates, transactions: milliseconds.length,
      transactionMs: { p50: percentile(milliseconds, 0.5), p95: percentile(milliseconds, 0.95), max: percentile(milliseconds, 1) },
      amortizedCommitMsPerUpdate: { p50: percentile(amortized, 0.5), p95: percentile(amortized, 0.95), max: percentile(amortized, 1) },
      payloadBytes: { min: Math.min(...payloadSizes), max: Math.max(...payloadSizes) },
      maximumBatchWaitMsAtNominalRate: workload === "typing" ? (batchSize - 1) * 100 : 0,
    });
  }
}
const report = {
  scope: process.argv[4] ?? "LOCAL PC DISK ONLY; deployment disk has not been measured", measuredAt: new Date().toISOString(),
  node: process.version, sqlite: process.versions.sqlite, platform: platform(), osRelease: release(), architecture: arch(), directory: "<measurement-directory>",
  durability: { journalMode: "wal", synchronous: 2 },
  method: "Three fresh databases per row, 50 one-character Yjs transactions spaced 100 ms apart per typing repetition, then 1000 without delay per burst repetition. Fixed batches of 1 or 5 separately stored raw updates per BEGIN IMMEDIATE / COMMIT. Timing includes BEGIN, inserts and FULL COMMIT, excludes Yjs encoding and batch wait. No WAL checkpoint inside timed regions. No asynchronous receipt before commit.",
  results,
};
const json = `${JSON.stringify(report, null, 2)}\n`;
if (output) await writeFile(resolve(output), json);
process.stdout.write(json);
