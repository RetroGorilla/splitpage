import { parentPort, workerData } from "node:worker_threads";
import { UpdateJournal } from "./journal.ts";
import { InstanceStorage } from "./instance/storage.ts";

const port = parentPort;
if (!port) throw new Error("Journal worker requires a parent");
const configuration = workerData as { path: string; journalMode: string; synchronous: string };
const journal = new UpdateJournal(configuration.path, configuration, 15000);
let instances: InstanceStorage | undefined;
port.postMessage({ id: 0, value: journal.configuration });
let mutation: { id: number; sequences: number[] } | null = null;
port.on("message", (request: { id: number; command: string; document: string; payloads: Uint8Array[]; mutation?: boolean; action?: string; data?: Record<string, unknown>; gate?: SharedArrayBuffer }) => {
  try {
    if (request.command === "append" && request.mutation) {
      journal.database.exec("BEGIN IMMEDIATE");
      const insert = journal.database.prepare("INSERT INTO updates(document, payload) VALUES (?, ?)");
      mutation = { id: request.id, sequences: request.payloads.map(payload => Number(insert.run(request.document, payload).lastInsertRowid)) };
      port.postMessage({ id: request.id, phase: "mutation-before-commit" });
      return;
    }
    let value: unknown;
    if (request.command === "instance") {
      instances ??= new InstanceStorage(journal.database);
      value = instances.run(String(request.action), request.data ?? {}, phase => {
        if (!request.gate) return;
        const gate = new Int32Array(request.gate);
        Atomics.store(gate, 0, 0);
        port.postMessage({ id: request.id, phase });
        if (Atomics.wait(gate, 0, 0, 15000) === "timed-out") throw new Error(`Instance gate timed out: ${phase}`);
      });
    } else if (request.command === "commit-mutation") {
      if (!mutation || mutation.id !== request.id) throw new Error("No matching early-ack mutation transaction");
      journal.database.exec("COMMIT");
      value = mutation.sequences;
      mutation = null;
    } else if (request.command === "append") value = journal.append(request.document, request.payloads);
    else if (request.command === "read") value = journal.read(request.document);
    else if (request.command === "close") journal.close();
    else throw new Error("Unknown journal request");
    port.postMessage({ id: request.id, value });
    if (request.command === "close") port.close();
  } catch (error) {
    port.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});
