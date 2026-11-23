import { once } from "node:events";
import { writeSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { Database } from "@hocuspocus/extension-database";
import { Server } from "@hocuspocus/server";
import type { Connection, Document, Extension } from "@hocuspocus/server";
import { messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import { applyUpdate, Doc, encodeStateAsUpdate, snapshot, snapshotContainsUpdate } from "yjs";
import { scriptAccess } from "./access.ts";
import { RelayError, relayConfig } from "./config.ts";
import {
  createRelayLimits,
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  HTTP_MAX_HEADERS_COUNT,
  HTTP_REQUEST_TIMEOUT_MS,
  isPictureUpload,
  MAX_PENDING_DOCUMENTS,
  MAX_UNAUTHENTICATED_QUEUE_BYTES,
  MAX_UNAUTHENTICATED_QUEUE_MESSAGES,
  MAX_WS_BUFFERED_CHUNKS,
  MAX_WS_FRAGMENTS,
  RETRY_AFTER_SECONDS
} from "./limits.ts";
import { statusRequests } from "./status.ts";
import type { StorageFailureRecord } from "./status.ts";
import { claimWriter, openWriter } from "./storage.ts";

const DOCUMENT_BYTES = 15_000_000;
const MAX_PAYLOAD = 16_000_000;
const STOP_SIGNALS = ["SIGINT", "SIGQUIT", "SIGTERM"] as const;

function failShutdown(message: string): never {
  writeSync(2, message + "\n");
  process.exit(1);
}

function exceedsMergeLimit(document: Document, update: Uint8Array): boolean {
  const candidate = new Doc({ gc: document.gc, gcFilter: document.gcFilter });
  try {
    applyUpdate(candidate, encodeStateAsUpdate(document));
    applyUpdate(candidate, update);
    return encodeStateAsUpdate(candidate).byteLength > DOCUMENT_BYTES;
  } finally {
    candidate.destroy();
  }
}

export async function startRelay(env: NodeJS.ProcessEnv, address = "0.0.0.0", extensions: Extension[] = []) {
  const {
    directory, port, origins, debounce, maxDebounce, managementSecret,
    maxConnections, maxConnectionsPerInvitation, maxMessagesPerSecond, maxUploadsInFlight
  } = relayConfig(env);
  const lock = claimWriter(directory);
  let db: ReturnType<typeof openWriter>;
  try {
    db = openWriter(directory);
  } catch (error) {
    lock.close();
    throw error;
  }
  let shutdown: NodeJS.Timeout | undefined;
  let lastStorageFailure: StorageFailureRecord | null = null;
  function beginShutdown(): void {
    shutdown ??= setTimeout(() => failShutdown("Relay shutdown timed out. Some edits may not have been stored."), 15_000);
  }
  function closeStorage(): void {
    clearTimeout(shutdown);
    for (const signal of STOP_SIGNALS) process.removeListener(signal, beginShutdown);
    db.close();
    lock.close();
  }
  const limits = createRelayLimits({
    maxConnections,
    maxConnectionsPerInvitation,
    maxMessagesPerSecond,
    maxUploadsInFlight
  });
  const load = db.prepare("SELECT state FROM documents WHERE name = ?");
  const size = db.prepare("SELECT length(state) AS bytes FROM documents WHERE name = ?");
  const write = db.prepare("INSERT INTO documents VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET state = excluded.state");
  type Admission = { invitationId: string; reservationId: string };
  const storage = new Database({
    async fetch({ documentName, context }) {
      try {
        return (load.get(documentName)?.state as Uint8Array | undefined) ?? null;
      } catch (error) {
        lastStorageFailure = { at: new Date().toISOString(), reason: "document-load-failed" };
        const admission = context as Partial<Admission> | undefined;
        if (admission?.invitationId && admission.reservationId) {
          limits.releaseInvitation(admission.invitationId, admission.reservationId);
        }
        throw error;
      }
    },
    async store({ documentName, state }) {
      try {
        write.run(documentName, state);
      } catch (error) {
        lastStorageFailure = { at: new Date().toISOString(), reason: "document-store-failed" };
        if (shutdown) failShutdown("Relay shutdown failed. The last edits were not stored.");
        throw error;
      }
    }
  });
  const access = scriptAccess(db);
  function requireAccess(context: Admission): void {
    if (!access.isValid(context.invitationId)) throw { code: 4403, reason: "access-removed" };
  }
  const limitsExtension: Extension<Admission> = {
    priority: 200,
    async onRequest({ request, response }) {
      if (!isPictureUpload(request)) return;
      if (!limits.tryAdmitUpload(response)) {
        if (!request.complete) response.setHeader("Connection", "close");
        response.writeHead(503, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Retry-After": RETRY_AFTER_SECONDS
        }).end(JSON.stringify({ error: "too-many-uploads" }));
        // why: the stock server treats a falsy rejection as an HTTP response handled by the hook
        throw undefined;
      }
    },
    async onConnect({ socketId }) {
      if (!limits.allowMessage(socketId)) throw { reason: "rate-limited" };
    }
  };
  const status = statusRequests(managementSecret, db, directory, {
    totalConnections: () => limits.totalSockets(),
    authenticatedConnections: () => relay.hocuspocus.getConnectionsCount(),
    openDocuments: () => relay.hocuspocus.getDocumentsCount(),
    uploadsInFlight: () => limits.uploadsInFlight(),
    lastStorageFailure: () => lastStorageFailure
  });

  const writes = new WeakMap<Document, { connection: Connection; done: Promise<void>; release: () => void }>();
  const relay = new Server<Admission>({
    address, port, debounce, maxDebounce, quiet: true,
    maxUnauthenticatedQueueSize: MAX_UNAUTHENTICATED_QUEUE_BYTES,
    maxUnauthenticatedQueueMessages: MAX_UNAUTHENTICATED_QUEUE_MESSAGES,
    maxPendingDocuments: MAX_PENDING_DOCUMENTS,
    websocketOptions: {
      maxPayload: MAX_PAYLOAD,
      maxFragments: MAX_WS_FRAGMENTS,
      maxBufferedChunks: MAX_WS_BUFFERED_CHUNKS,
      perMessageDeflate: false,
      verifyClient(
        { origin, req }: { origin: string | undefined; req: IncomingMessage },
        done: (verified: boolean, code?: number, message?: string, headers?: Record<string, string>) => void
      ) {
        if (!origins.has(origin ?? "")) {
          done(false, 401);
          return;
        }
        if (!limits.tryAdmitSocket(req.socket)) {
          done(false, 503, "too-many-connections", { "Retry-After": RETRY_AFTER_SECONDS });
          return;
        }
        done(true);
      }
    },
    extensions: [limitsExtension, ...extensions, storage],
    async onRequest({ request, response }) {
      if (status(request, response)) throw undefined;
    },
    async onAuthenticate({ token, instance, documentName, connectionConfig, requestParameters }) {
      if (requestParameters.getAll("wire").join(",") !== "1" || requestParameters.getAll("schema").join(",") !== "1") {
        throw { reason: "unsupported-version" };
      }
      const invitationId = access.authenticate(documentName, token);
      const reservationId = limits.tryAdmitInvitation(invitationId);
      if (!reservationId) throw { reason: "too-many-connections" };
      try {
        const loading = instance.loadingDocuments.get(documentName);
        const live = instance.documents.get(documentName) ?? (loading ? await loading : undefined);
        if (loading) access.authenticate(documentName, token);
        const bytes = live ? encodeStateAsUpdate(live).byteLength : Number(size.get(documentName)?.bytes ?? 0);
        connectionConfig.readOnly = bytes >= DOCUMENT_BYTES;
        return { invitationId, reservationId };
      } catch (error) {
        limits.releaseInvitation(invitationId, reservationId);
        throw error;
      }
    },
    async connected({ context, connection }) {
      connection.onClose(() => {
        limits.releaseInvitation(context.invitationId, context.reservationId);
        limits.clearSocket(connection.socketId);
      });
      if (!access.isValid(context.invitationId)) {
        connection.close({ code: 4403, reason: "access-removed" });
        connection.webSocket.close(4403, "access-removed");
      }
    },
    async onDisconnect({ context, socketId }) {
      if (context?.invitationId && context?.reservationId) {
        limits.releaseInvitation(context.invitationId, context.reservationId);
      }
      limits.clearSocket(socketId);
    },
    async beforeHandleMessage({ context, connection, socketId }) {
      requireAccess(context);
      if (!limits.allowMessage(socketId)) {
        connection.close({ code: 4429, reason: "rate-limited" });
        connection.webSocket.close(4429, "rate-limited");
        throw { code: 4429, reason: "rate-limited" };
      }
    },
    async beforeHandleAwareness({ context }) {
      if (context) requireAccess(context);
    },
    async beforeSync({ connection, context, document, type, payload }) {
      const returning = type === messageYjsSyncStep2 && !(payload.length === 2 && payload[0] === 0 && payload[1] === 0);
      if (!returning && (type !== messageYjsUpdate || connection.readOnly)) return;
      // why: the stock receiver awaits this hook before applying, so a second writer could otherwise race the check
      let active = writes.get(document);
      while (active) {
        await active.done;
        active = writes.get(document);
      }
      requireAccess(context);
      let release!: () => void;
      const done = new Promise<void>(resolve => { release = resolve; });
      writes.set(document, { connection, done, release });
      if (!returning || snapshotContainsUpdate(snapshot(document), payload)) return;
      if (connection.readOnly || exceedsMergeLimit(document, payload)) {
        connection.readOnly = true;
        connection.sendStateless("merge-too-large");
      }
    },
    async afterHandleMessage({ document, connection }) {
      const active = writes.get(document);
      if (active?.connection !== connection) return;
      writes.delete(document);
      active.release();
    },
    async onDestroy() {
      closeStorage();
    }
  });
  relay.httpServer.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  relay.httpServer.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  relay.httpServer.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  relay.httpServer.maxHeadersCount = HTTP_MAX_HEADERS_COUNT;
  const listening = new AbortController();
  try {
    for (const signal of STOP_SIGNALS) process.prependListener(signal, beginShutdown);
    await Promise.race([
      relay.listen(),
      once(relay.httpServer, "error", { signal: listening.signal }).then(() => { throw new Error(); })
    ]);
    function closeRemovedAccess(): void {
      for (const document of relay.hocuspocus.documents.values()) {
        for (const connection of document.getConnections()) {
          const context = connection.context as Admission;
          if (!access.isValid(context.invitationId)) {
            connection.close({ code: 4403, reason: "access-removed" });
            connection.webSocket.close(4403, "access-removed");
          }
        }
      }
    }
    return Object.assign(relay, {
      registerScript: access.register,
      issueInvitation: access.issue,
      revokeInvitation(id: string) {
        access.revoke(id);
        closeRemovedAccess();
      },
      deleteScript(name: string) {
        access.deleteScript(name);
        closeRemovedAccess();
      }
    });
  } catch {
    closeStorage();
    throw new RelayError("Relay could not listen on the configured port.");
  } finally {
    listening.abort();
  }
}
