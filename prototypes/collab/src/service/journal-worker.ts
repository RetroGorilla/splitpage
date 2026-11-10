import { parentPort, workerData } from "node:worker_threads";
import { UpdateJournal } from "./journal.ts";

const port = parentPort;
if (!port) throw new Error("Journal worker requires a parent");
const configuration = workerData as { path: string; journalMode: string; synchronous: string };
const journal = new UpdateJournal(configuration.path, configuration, 15000);
port.postMessage({ id: 0, value: journal.configuration });
port.on("message", (request: { id: number; command: string; document: string; payloads: Uint8Array[] }) => {
  try {
    let value: unknown;
    if (request.command === "append") value = journal.append(request.document, request.payloads);
    else if (request.command === "read") value = journal.read(request.document);
    else if (request.command === "close") journal.close();
    else throw new Error("Unknown journal request");
    port.postMessage({ id: request.id, value });
    if (request.command === "close") port.close();
  } catch (error) {
    port.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});
