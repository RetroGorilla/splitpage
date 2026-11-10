import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import * as Y from "yjs";
import { readFrame, syncFrame } from "../../src/service/wire.ts";
import { fixture, readRecoveredRows, workspace } from "./harness.ts";

const iterations = Number(process.argv[2] ?? 200);
assert.ok(Number.isInteger(iterations) && iterations > 0);
const output = new URL(process.argv[3] ?? "./ack-kill.local.json", import.meta.url);
const results: { mode: string; iterations: number; exactRowsRecovered: number; missingRows: number; detectionRate: number; elapsedMs: number; firstMissing: number | null }[] = [];
const started = performance.now();
for (const mode of ["journal", "after-unlock-ack"] as const) {
  const begin = performance.now();
  let missingRows = 0;
  let firstMissing: number | null = null;
  for (let iteration = 1; iteration <= iterations; iteration++) {
    const work = await workspace();
    const doc = fixture();
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const server = await work.start();
      if (mode === "after-unlock-ack") await server.command("configure", { acknowledgeBeforeCommit: true });
      doc.getText("R1").insert(4, "e");
      const update = Y.encodeStateAsUpdate(doc);
      const expected = Buffer.from(update).toString("base64");
      const exited = once(server.child, "exit");
      socket = new WebSocket(`ws://127.0.0.1:${server.port}`, { perMessageDeflate: false });
      const acknowledged = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("No acknowledgement frame to kill on")), 8000);
        socket?.on("message", data => {
          assert.ok(Buffer.isBuffer(data));
          const frame = readFrame(data);
          if (frame.kind !== 8) return;
          if (frame.subtype !== 1) { reject(new Error("Unexpected negative receipt in kill measurement")); return; }
          const killed = server.child.kill("SIGKILL");
          clearTimeout(timer);
          if (!killed) reject(new Error("Could not hard-kill the exact server process"));
          else resolve();
        });
      });
      await once(socket, "open", { signal: AbortSignal.timeout(8000) });
      socket.send(Uint8Array.from([7, ...new TextEncoder().encode("fixture"), 2, 0, 0, 5, ...new TextEncoder().encode("4.8.0")]));
      socket.send(syncFrame("fixture", 2, update));
      await acknowledged;
      await exited;
      const rows = readRecoveredRows(work.path);
      if (!rows.some(row => row.payload === expected)) {
        missingRows++;
        if (firstMissing === null) {
          firstMissing = iteration;
          await writeFile(new URL(`../../histories/probabilistic-ack-kill-${mode}.json`, import.meta.url), `${JSON.stringify({
            shows: "Probabilistic observation: the server was killed in the positive acknowledgement frame callback and the exact sent update was absent from the recovered journal.",
            mode, iteration, expectedRawUpdate: expected, recoveredRows: rows,
          }, null, 2)}\n`);
        }
      }
    } finally {
      clearTimeout(timer);
      socket?.terminate();
      doc.destroy();
      await work.clean();
    }
    if (iteration % 25 === 0) process.stderr.write(`${mode}: ${iteration}/${iterations}, missing exact rows: ${missingRows}\n`);
  }
  results.push({ mode, iterations, exactRowsRecovered: iterations - missingRows, missingRows, detectionRate: missingRows / iterations,
    elapsedMs: Number((performance.now() - begin).toFixed(2)), firstMissing });
}
const report = {
  label: "PROBABILISTIC LOCAL PROCESS-KILL CHECK; zero misses does not prove COMMIT/status ordering", measuredAt: new Date().toISOString(),
  node: process.version, platform: process.platform, totalElapsedMs: Number((performance.now() - started).toFixed(2)),
  method: "Serial fresh child server/database per iteration, one accepted full update abcde, SIGKILL requested directly in the first positive status WebSocket frame callback; await process exit, independently open the recovered SQLite journal read-only and require the exact raw update. No success window or delay is used. The mutation signals the server after BEGIN/INSERT, sends its positive status, then receives permission to COMMIT. No extra delay is inserted in the mutation window.",
  results,
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
assert.equal(results[0]?.missingRows, 0, "Honest journal path lost an acknowledged exact update");
