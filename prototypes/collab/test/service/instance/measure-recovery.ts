import assert from "node:assert/strict";
import { writeFile, stat } from "node:fs/promises";
import { hostname, cpus, totalmem, platform, release } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import * as Y from "yjs";
import { JournalWorkerClient } from "../../../src/service/journal-client.ts";
import { InstanceGateway } from "../../../src/service/instance/gateway.ts";
import type { NodeInstanceReplica } from "../../../src/service/instance/client.ts";
import { workspace } from "../harness.ts";
import { OWNER, INVITE, joinFixture } from "./harness.ts";

const repetitions = Number(process.argv[2] ?? 5);
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 20) throw new Error("Repetitions must be 1..20");
const samples: Record<string, unknown>[] = [];
for (const withCheckpoint of [false, true]) {
  for (let repetition = 0; repetition < repetitions; repetition++) {
    const work = await workspace();
    let worker: JournalWorkerClient | undefined;
    let client: NodeInstanceReplica | undefined;
    const document = new Y.Doc();
    try {
      worker = new JournalWorkerClient(work.path, { journalMode: "WAL", synchronous: "FULL" });
      await worker.ready;
      let gateway = new InstanceGateway(worker);
      const record = await gateway.create("measurement-k", OWNER, INVITE);
      document.clientID = 7;
      document.getText("R1").insert(0, "abcd");
      await gateway.request("upload", { operation: "measurement-k", owner: OWNER, payload: Y.encodeStateAsUpdate(document) });
      await gateway.request("commit", { operation: "measurement-k", owner: OWNER });
      document.clientID = 11;
      for (let i = 0; i < 3000; i++) {
        const vector = Y.encodeStateVector(document);
        document.getText("R1").insert(document.getText("R1").length, "x");
        await worker.append(record.id, [Y.encodeStateAsUpdate(document, vector)]);
        if (withCheckpoint && i === 2499) {
          await gateway.checkpoint(await gateway.capture(record.id));
          await gateway.prune(record.id);
        }
      }
      await worker.close();
      worker = undefined;
      const db = new DatabaseSync(work.path, { readOnly: true });
      let rows: Record<string, unknown>;
      try {
        const journal = db.prepare("SELECT COUNT(*) AS rows, COALESCE(SUM(length(payload)), 0) AS bytes FROM updates").get();
        const checkpoints = db.prepare("SELECT COUNT(*) AS rows, COALESCE(SUM(length(payload)), 0) AS bytes FROM instance_checkpoints").get();
        rows = { journalRows: Number(journal?.rows), journalBytes: Number(journal?.bytes), checkpointBytes: Number(checkpoints?.bytes) };
      } finally { db.close(); }
      worker = new JournalWorkerClient(work.path, { journalMode: "WAL", synchronous: "FULL" });
      await worker.ready;
      gateway = new InstanceGateway(worker);
      const start = performance.now();
      const recovered = await gateway.recover(record.id);
      const replayMs = performance.now() - start;
      const check = new Y.Doc();
      try {
        Y.applyUpdate(check, recovered.payload);
        assert.equal(check.getText("R1").toString(), `abcd${"x".repeat(3000)}`);
      } finally { check.destroy(); }
      await worker.close();
      worker = undefined;
      const childStart = performance.now();
      const server = await work.start({ INSTANCE_OWNER: OWNER });
      client = await joinFixture(server, record.id);
      const restartAndJoinMs = performance.now() - childStart;
      assert.equal(client.document.getText("R1").toString(), `abcd${"x".repeat(3000)}`);
      samples.push({ withCheckpoint, repetition, ...rows, databaseBytes: (await stat(work.path)).size, replayMs, restartAndJoinMs });
    } finally { client?.destroy(); await worker?.close(); document.destroy(); await work.clean(); }
  }
}
const result = {
  measuredAt: new Date().toISOString(), machine: hostname(), os: `${platform()} ${release()}`,
  cpu: cpus()[0]?.model, totalMemoryBytes: totalmem(), node: process.version,
  volume: process.env.TEMP, updates: 3000, checkpointAfter: 2500, tail: 500, repetitions, samples,
};
await writeFile(new URL("./recovery.local.json", import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
