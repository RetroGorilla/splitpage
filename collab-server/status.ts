import { readdirSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { lastBackupTime } from "./backup.ts";
import { managementAuthorizer } from "./management-auth.ts";

const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface StorageFailureRecord {
  readonly at: string;
  readonly reason: "document-load-failed" | "document-store-failed";
}

export interface RelayStatusSnapshot {
  readonly connections: {
    readonly total: number;
    readonly authenticated: number;
    readonly documents: number;
  };
  readonly uploadsInFlight: number;
  readonly storedBytes: number;
  readonly pictureBytes: number;
  readonly lastStorageFailure: StorageFailureRecord | null;
  readonly lastBackupAt: string | null;
}

export interface RelayStatusSources {
  readonly totalConnections: () => number;
  readonly authenticatedConnections: () => number;
  readonly openDocuments: () => number;
  readonly uploadsInFlight: () => number;
  readonly lastStorageFailure: () => StorageFailureRecord | null;
}

function measurePictureBytes(directory: string): number {
  const pictures = join(directory, "pictures");
  let entries;
  try {
    entries = readdirSync(pictures, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !SHA256_HEX.test(entry.name)) continue;
    try {
      total += statSync(join(pictures, entry.name)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return total;
}

export function statusRequests(secret: string | undefined, db: DatabaseSync, directory: string, sources: RelayStatusSources) {
  const authorize = managementAuthorizer(secret);
  const storedBytes = db.prepare("SELECT coalesce(sum(length(state)), 0) AS bytes FROM documents");

  return (request: IncomingMessage, response: ServerResponse): boolean => {
    const path = (request.url ?? "").split("?")[0] ?? "";
    if (path !== "/api/status") return false;
    response.setHeader("Cache-Control", "no-store");
    if (!authorize(request)) {
      response.writeHead(401, { "Content-Type": "application/json" }).end();
      return true;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end();
      return true;
    }
    try {
      const snapshot: RelayStatusSnapshot = {
        connections: {
          total: sources.totalConnections(),
          authenticated: sources.authenticatedConnections(),
          documents: sources.openDocuments()
        },
        uploadsInFlight: sources.uploadsInFlight(),
        storedBytes: Number(storedBytes.get()?.bytes ?? 0),
        pictureBytes: measurePictureBytes(directory),
        lastStorageFailure: sources.lastStorageFailure(),
        lastBackupAt: lastBackupTime(directory)
      };
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(snapshot));
    } catch {
      response.writeHead(500).end();
    }
    return true;
  };
}
