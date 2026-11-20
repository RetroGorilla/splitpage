import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { writeSync } from "node:fs";
import { Database } from "@hocuspocus/extension-database";
import { Server } from "@hocuspocus/server";
import type { Extension } from "@hocuspocus/server";
import { encodeStateAsUpdate } from "yjs";
import { RelayError, relayConfig } from "./config.ts";
import { claimWriter, openWriter } from "./storage.ts";

const DOCUMENT_BYTES = 15_000_000;
const MAX_PAYLOAD = 16_000_000;
const STOP_SIGNALS = ["SIGINT", "SIGQUIT", "SIGTERM"] as const;

function failShutdown(message: string): never {
  writeSync(2, message + "\n");
  process.exit(1);
}

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export async function startRelay(env: NodeJS.ProcessEnv, address = "0.0.0.0", extensions: Extension[] = []) {
  const { directory, port, origins, token, debounce, maxDebounce } = relayConfig(env);
  const expected = digest(token);
  const lock = claimWriter(directory);
  let db: ReturnType<typeof openWriter>;
  try {
    db = openWriter(directory);
  } catch (error) {
    lock.close();
    throw error;
  }
  let shutdown: NodeJS.Timeout | undefined;
  function beginShutdown(): void {
    shutdown ??= setTimeout(() => failShutdown("Relay shutdown timed out. Some edits may not have been stored."), 15_000);
  }
  function closeStorage(): void {
    clearTimeout(shutdown);
    for (const signal of STOP_SIGNALS) process.removeListener(signal, beginShutdown);
    db.close();
    lock.close();
  }
  const load = db.prepare("SELECT state FROM documents WHERE name = ?");
  const size = db.prepare("SELECT length(state) AS bytes FROM documents WHERE name = ?");
  const write = db.prepare("INSERT INTO documents VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET state = excluded.state");
  const storage = new Database({
    async fetch({ documentName }) {
      return (load.get(documentName)?.state as Uint8Array | undefined) ?? null;
    },
    async store({ documentName, state }) {
      try {
        write.run(documentName, state);
      } catch (error) {
        if (shutdown) failShutdown("Relay shutdown failed. The last edits were not stored.");
        throw error;
      }
    }
  });
  const relay = new Server({
    address, port, debounce, maxDebounce, quiet: true,
    websocketOptions: {
      maxPayload: MAX_PAYLOAD,
      verifyClient: ({ origin }: { origin: string | undefined }) => origins.has(origin ?? "")
    },
    extensions: [...extensions, storage],
    async onAuthenticate({ token: supplied, instance, documentName, connectionConfig }) {
      if (!timingSafeEqual(digest(supplied), expected)) throw { reason: "permission-denied" };
      const live = instance.documents.get(documentName) ?? await instance.loadingDocuments.get(documentName);
      const bytes = live ? encodeStateAsUpdate(live).byteLength : Number(size.get(documentName)?.bytes ?? 0);
      connectionConfig.readOnly = bytes >= DOCUMENT_BYTES;
    },
    async onDestroy() {
      closeStorage();
    }
  });
  const listening = new AbortController();
  try {
    for (const signal of STOP_SIGNALS) process.prependListener(signal, beginShutdown);
    await Promise.race([
      relay.listen(),
      once(relay.httpServer, "error", { signal: listening.signal }).then(() => { throw new Error(); })
    ]);
    return relay;
  } catch {
    closeStorage();
    throw new RelayError("Relay could not listen on the configured port.");
  } finally {
    listening.abort();
  }
}
