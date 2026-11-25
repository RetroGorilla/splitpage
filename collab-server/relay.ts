import { once } from "node:events";
import { writeSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { Database } from "@hocuspocus/extension-database";
import { Server } from "@hocuspocus/server";
import type { Connection, Document, Extension } from "@hocuspocus/server";
import { messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import { applyUpdate, Doc, encodeStateAsUpdate, snapshot, snapshotContainsUpdate } from "yjs";
import { scriptAccess } from "./access.ts";
import type { InvitationRole } from "./access.ts";
import { appShell } from "./app-shell.ts";
import { RelayError, relayConfig } from "./config.ts";
import {
  createRelayLimits,
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  HTTP_MAX_HEADERS_COUNT,
  HTTP_REQUEST_TIMEOUT_MS,
  MAX_PENDING_DOCUMENTS,
  MAX_UNAUTHENTICATED_QUEUE_BYTES,
  MAX_UNAUTHENTICATED_QUEUE_MESSAGES,
  MAX_WS_BUFFERED_CHUNKS,
  MAX_WS_FRAGMENTS,
  RETRY_AFTER_SECONDS
} from "./limits.ts";
import { ownerRequests } from "./owner-http.ts";
import { pictureApi } from "./pictures.ts";
import { statusRequests } from "./status.ts";
import type { StorageFailureRecord } from "./status.ts";
import { claimWriter, openWriter } from "./storage.ts";
import { versionRequests } from "./version-http.ts";
import { versionStorage } from "./version-storage.ts";
import { versionHistory } from "./versions.ts";

const DOCUMENT_BYTES = 15_000_000;
const VERSION_READ_LIMIT = 4;
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
    directory, deployment, port, origins, debounce, maxDebounce, managementSecret,
    maxConnections, maxConnectionsPerInvitation, maxConnectionsPerGuestInvitation, maxMessagesPerSecond, maxUploadsInFlight,
    versions: versionOptions
  } = relayConfig(env);
  const lock = claimWriter(directory);
  let db: ReturnType<typeof openWriter> | undefined;
  let pictures: ReturnType<typeof pictureApi>;
  let access: ReturnType<typeof scriptAccess>;
  let versions: ReturnType<typeof versionStorage>;
  let history: ReturnType<typeof versionHistory>;
  try {
    db = openWriter(directory);
    access = scriptAccess(db);
    pictures = pictureApi(db, directory, access, origins, maxUploadsInFlight);
    versions = versionStorage(db);
    history = versionHistory(versions, directory, versionOptions);
  } catch (error) {
    db?.close();
    lock.close();
    throw error;
  }
  let shutdown: NodeJS.Timeout | undefined;
  let stopping = false;
  let lastStorageFailure: StorageFailureRecord | null = null;
  function stopHistory(): void {
    stopping = true;
    history.stop();
  }
  function beginShutdown(): void {
    stopHistory();
    shutdown ??= setTimeout(() => failShutdown("Relay shutdown timed out. Some edits may not have been stored."), 15_000);
  }
  function closeStorage(): void {
    clearTimeout(shutdown);
    for (const signal of STOP_SIGNALS) process.removeListener(signal, beginShutdown);
    history.close();
    db?.close();
    lock.close();
  }
  const limits = createRelayLimits({
    maxConnections,
    maxConnectionsPerInvitation,
    maxConnectionsPerGuestInvitation,
    maxMessagesPerSecond
  });
  const load = db.prepare("SELECT state FROM documents WHERE name = ?");
  const size = db.prepare("SELECT length(state) AS bytes FROM documents WHERE name = ?");
  const write = db.prepare(`INSERT INTO documents (name, state, version_generation) VALUES (?, ?, 1)
    ON CONFLICT(name) DO UPDATE SET state = excluded.state, version_generation = documents.version_generation + 1`);
  type Admission = { invitationId: string; role: InvitationRole; reservationId?: string };
  const storage = new Database({
    async fetch({ documentName }) {
      try {
        return (load.get(documentName)?.state as Uint8Array | undefined) ?? null;
      } catch (error) {
        lastStorageFailure = { at: new Date().toISOString(), reason: "document-load-failed" };
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
      history.changed(documentName);
    }
  });
  function requireAccess(context: Admission): void {
    if (!access.isValid(context.invitationId)) throw { code: 4403, reason: "access-removed" };
  }

  function closeRemovedAccess(): void {
    for (const document of relay.hocuspocus.documents.values()) {
      for (const connection of document.getConnections()) {
        const context = connection.context as Admission;
        if (!access.isValid(context.invitationId)) connection.close({ code: 4403, reason: "access-removed" });
      }
    }
  }

  function resetGuests(name: string) {
    const issued = access.resetGuests(name);
    if (issued) closeRemovedAccess();
    return issued;
  }

  function revokeInvitation(id: string): boolean {
    if (!access.revoke(id)) return false;
    closeRemovedAccess();
    return true;
  }

  function deleteScript(name: string): boolean {
    if (!access.deleteScript(name)) return false;
    history.reclaimSoon(name);
    closeRemovedAccess();
    return true;
  }

  function abandonCreation(id: string) {
    const result = access.abandon(id);
    if (result === "deleted") {
      const creation = access.findCreation(id);
      if (creation) history.reclaimSoon(creation.script);
    }
    return result;
  }

  const manage = ownerRequests(managementSecret, DOCUMENT_BYTES, {
    findCreation: access.findCreation,
    create(creationId, bytes, hash) {
      const created = access.create(creationId, bytes, hash);
      if (created.owner) history.changed(created.scriptId);
      return created;
    },
    abandonCreation,
    listScripts: access.listScripts,
    issue: access.issue,
    list: access.list,
    authorizeOwner: access.authorizeOwner,
    authenticate: access.authenticate,
    resetGuests,
    revokeInvitation,
    deleteScript
  }, deployment);
  const status = statusRequests(managementSecret, db, directory, {
    totalConnections: () => limits.totalSockets(),
    authenticatedConnections: () => relay.hocuspocus.getConnectionsCount(),
    openDocuments: () => relay.hocuspocus.getDocumentsCount(),
    uploadsInFlight: () => pictures.inFlight(),
    lastStorageFailure: () => lastStorageFailure,
    versionBytes: versions.total,
    lastVersionFailure: history.lastFailure
  });
  const versionRequest = versionRequests(versions, access, origins, {
    documentBytes: DOCUMENT_BYTES, readLimit: VERSION_READ_LIMIT, stopping: () => stopping
  });

  const limitsExtension: Extension<Admission> = {
    priority: 200,
    async onConnect({ socketId, requestHeaders }) {
      limits.bindSocket(socketId, requestHeaders.get("sec-websocket-key"));
      if (!limits.allowMessage(socketId)) throw { reason: "rate-limited" };
    }
  };

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
        const keyHeader = req.headers["sec-websocket-key"];
        const websocketKey = typeof keyHeader === "string" ? keyHeader : undefined;
        if (!limits.tryAdmitSocket(req.socket, websocketKey)) {
          done(false, 503, "too-many-connections", { "Retry-After": RETRY_AFTER_SECONDS });
          return;
        }
        done(true);
      }
    },
    extensions: [limitsExtension, ...extensions, ...(env.SPLITPAGE_APP_DIR ? [appShell(env.SPLITPAGE_APP_DIR, deployment)] : []), storage],
    async onRequest({ request, response }) {
      // why: the stock server treats a falsy rejection as an HTTP response handled by the hook
      if (status(request, response) || await manage(request, response) ||
          await pictures.handle(request, response) || await versionRequest(request, response)) throw null;
    },
    async onAuthenticate({ token, instance, documentName, connectionConfig, requestParameters }) {
      if (requestParameters.getAll("wire").join(",") !== "1" || requestParameters.getAll("schema").join(",") !== "1") {
        throw { reason: "unsupported-version" };
      }
      const { id: invitationId, role } = access.authenticate(documentName, token);
      if (!limits.hasInvitationCapacity(invitationId, role)) throw { reason: "too-many-connections" };
      const loading = instance.loadingDocuments.get(documentName);
      const live = instance.documents.get(documentName) ?? (loading ? await loading : undefined);
      if (loading) access.authenticate(documentName, token);
      const bytes = live ? encodeStateAsUpdate(live).byteLength : Number(size.get(documentName)?.bytes ?? 0);
      connectionConfig.readOnly = bytes >= DOCUMENT_BYTES;
      return { invitationId, role };
    },
    async connected({ context, connection }) {
      const reservationId = limits.tryAdmitInvitation(context.invitationId, context.role);
      if (!reservationId) {
        connection.close({ code: 4429, reason: "too-many-connections" });
        return;
      }
      context.reservationId = reservationId;
      connection.onClose(() => {
        limits.releaseInvitation(reservationId);
      });
      if (!access.isValid(context.invitationId)) {
        connection.close({ code: 4403, reason: "access-removed" });
      }
    },
    async onDisconnect({ context }) {
      if (context?.reservationId) limits.releaseInvitation(context.reservationId);
    },
    async beforeHandleMessage({ context, socketId }) {
      requireAccess(context);
      if (!limits.allowMessage(socketId)) {
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
      stopHistory();
      await pictures.close();
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
    const destroy = relay.destroy.bind(relay);
    return Object.assign(relay, {
      destroy() {
        stopHistory();
        return destroy();
      },
      registerScript: access.register,
      issueInvitation: access.issue,
      resetGuests,
      abandonCreation,
      revokeInvitation,
      deleteScript
    });
  } catch {
    closeStorage();
    throw new RelayError("Relay could not listen on the configured port.");
  } finally {
    listening.abort();
  }
}
