import { Server, OutgoingMessage } from "@hocuspocus/server";
import { setTimeout as delay } from "node:timers/promises";
import * as Y from "yjs";
import { JournalWorkerClient } from "./journal-client.ts";

const path = process.argv[2];
if (!path) throw new Error("Database path required");
const journal = new JournalWorkerClient(path, {
  journalMode: process.env.JOURNAL_MODE ?? "WAL", synchronous: process.env.JOURNAL_SYNC ?? "FULL",
});
const journalConfiguration = await journal.ready;
let hold = "";
let premature = false;
let prematureAfter20 = false;
let falseRefusal = false;
let unsafe = false;
let throwHook = false;
let failWrite = false;
let hookDelay = 0;
let storeFailure = false;
let storeHold = false;
let changeHold = false;
const gates = new Map<string, () => void>();
const emit = (event: string, data: Record<string, unknown> = {}): void => {
  process.send?.({ event, ...data });
};
const gate = (name: string): Promise<void> => new Promise(resolve => {
  gates.set(name, resolve);
  emit(name);
});
const server = new Server({
  port: 0, address: "127.0.0.1", quiet: true, stopOnSignals: false,
  ...(process.env.MAX_PAYLOAD ? { websocketOptions: { maxPayload: Number(process.env.MAX_PAYLOAD) } } : {}),
  debounce: 2000, maxDebounce: 10000,
  async onLoadDocument({ documentName, document }) {
    for (const row of await journal.read(documentName)) Y.applyUpdate(document, row.payload);
    return document;
  },
  async beforeSync({ type, payload, connection, document, documentName }) {
    emit("before", { type, payload: Buffer.from(payload).toString("base64"), text: document.getText("R1").toString() });
    if (hookDelay) await delay(hookDelay);
    if (type !== 1 && type !== 2) return;
    if (throwHook) throw new Error("Injected hook exception");
    if (connection.readOnly) return;
    if (falseRefusal) {
      connection.sendStateless(JSON.stringify({ rejected: "invalid-or-oversized" }));
      return;
    }
    if (!unsafe) {
      let invalid = payload.byteLength > 2 * 1024 * 1024;
      if (!invalid) {
        try { Y.decodeUpdate(payload); } catch { invalid = true; }
      }
      if (invalid) {
        connection.readOnly = true;
        connection.sendStateless(JSON.stringify({ rejected: "invalid-or-oversized", exportable: true }));
        emit("refused");
        return;
      }
    }
    let holdAfterCommit = false;
    if (hold === Buffer.from(payload).toString("base64")) {
      if (premature) connection.send(new OutgoingMessage(connection.messageAddress).writeSyncStatus(true).toUint8Array());
      if (prematureAfter20) {
        connection.send(new OutgoingMessage(connection.messageAddress).writeSyncStatus(true).toUint8Array());
        await delay(20);
        holdAfterCommit = true;
      } else await gate("held");
      hold = "";
    }
    if (failWrite) {
      connection.readOnly = true;
      connection.sendStateless(JSON.stringify({ rejected: "journal-write-failed", exportable: true }));
      emit("write-failed");
      return;
    }
    if (!unsafe) {
      try {
        const [sequence] = await journal.append(documentName, [payload]);
        emit("committed", { sequence });
        if (holdAfterCommit) await gate("post-commit-held");
      } catch {
        connection.readOnly = true;
        connection.sendStateless(JSON.stringify({ rejected: "journal-write-failed", exportable: true }));
        emit("write-failed");
      }
    }
  },
  async onChange({ document }) {
    emit("change", { text: document.getText("R1").toString() });
    if (changeHold) await gate("change-held");
  },
  async onStoreDocument() {
    emit("store-start");
    if (storeHold) await gate("store-held");
    emit("store-end");
    if (storeFailure) throw new Error("Injected store failure");
  },
});
process.on("message", (message: unknown) => {
  void handleCommand(message);
});
async function handleCommand(message: unknown): Promise<void> {
  if (typeof message !== "object" || message === null || !("command" in message)) return;
  const m = message as Record<string, unknown>;
  if (m.command === "configure") {
    hold = typeof m.hold === "string" ? m.hold : "";
    premature = m.premature === true;
    prematureAfter20 = m.prematureAfter20 === true;
    falseRefusal = m.falseRefusal === true;
    unsafe = m.unsafe === true;
    throwHook = m.throwHook === true;
    failWrite = m.failWrite === true;
    hookDelay = Number(m.hookDelay ?? 0);
    storeFailure = m.storeFailure === true;
    storeHold = m.storeHold === true;
    changeHold = m.changeHold === true;
    emit("configured");
  } else if (m.command === "release") {
    gates.get(String(m.gate))?.();
    gates.delete(String(m.gate));
  } else if (m.command === "inspect") {
    const document = server.hocuspocus.documents.get("fixture");
    emit("inspection", {
      rows: (await journal.read("fixture")).map(row => ({ sequence: row.sequence, payload: Buffer.from(row.payload).toString("base64") })),
      state: document ? Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64") : null,
    });
  } else if (m.command === "flush") {
    const result: unknown = server.hocuspocus.flushPendingStores();
    emit("flush-return", { value: result === undefined ? "undefined" : "other" });
  } else if (m.command === "store-immediate" || m.command === "store-schedule") {
    const document = server.hocuspocus.documents.get("fixture");
    if (document) {
      void server.hocuspocus.storeDocumentHooks(document, {
        document, documentName: "fixture", instance: server.hocuspocus,
        clientsCount: document.getConnectionsCount(), lastContext: {}, lastTransactionOrigin: { source: "local" },
      }, m.command === "store-immediate").then(() => emit(m.command === "store-immediate" ? "immediate-return" : "scheduled-return"));
    }
  } else if (m.command === "stop") {
    for (const resolve of gates.values()) resolve();
    await server.destroy();
    await journal.close();
    process.exit(0);
  }
}
await server.listen();
emit("ready", { port: server.address.port, configuration: journalConfiguration });
