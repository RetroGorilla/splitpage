import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";
import type { scriptAccess } from "./access.ts";
import { RETRY_AFTER_SECONDS } from "./limits.ts";
import type { versionStorage } from "./version-storage.ts";

const decompress = promisify(zstdDecompress);
const ROUTE = /^\/api\/scripts\/([^/]+)\/versions(?:\/([^/]+))?$/;

export function versionRequests(
  versions: Pick<ReturnType<typeof versionStorage>, "list" | "read">,
  access: Pick<ReturnType<typeof scriptAccess>, "authenticate">,
  origins: ReadonlySet<string>,
  { documentBytes, readLimit, stopping }: { documentBytes: number; readLimit: number; stopping: () => boolean }
) {
  let reads = 0;
  function unavailable(response: ServerResponse): void {
    response.writeHead(503, { "Retry-After": RETRY_AFTER_SECONDS }).end();
  }

  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const match = ROUTE.exec((request.url ?? "").split("?")[0] ?? "");
    if (!match) return false;
    const [, encodedScript = "", id] = match;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Vary", "Origin");
    const origin = request.headers.origin;
    if (origin !== undefined && !origins.has(origin)) {
      response.writeHead(403).end();
      return true;
    }
    if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
    if (request.method === "OPTIONS") {
      if (origin && request.headers["access-control-request-method"] === "GET") {
        response.writeHead(204, {
          "Access-Control-Allow-Methods": "GET",
          "Access-Control-Allow-Headers": "Authorization, Content-Type"
        }).end();
      } else response.writeHead(403).end();
      return true;
    }
    if (stopping()) {
      unavailable(response);
      return true;
    }
    let script: string;
    try {
      script = decodeURIComponent(encodedScript);
      access.authenticate(script, /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "");
    } catch {
      response.writeHead(403).end();
      return true;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end();
      return true;
    }
    if (id !== undefined && reads >= readLimit) {
      unavailable(response);
      return true;
    }
    if (id !== undefined) reads += 1;
    try {
      if (id === undefined) {
        const body = JSON.stringify(versions.list(script));
        response.writeHead(200, { "Content-Type": "application/json" }).end(body);
      } else {
        const version = versions.read(script, id);
        if (!version) {
          response.writeHead(404).end();
          return true;
        }
        const bytes = await decompress(version.compressed, { maxOutputLength: documentBytes });
        if (!createHash("sha256").update(bytes).digest().equals(version.hash)) {
          response.writeHead(500).end();
          return true;
        }
        response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length }).end(bytes);
        await finished(response, { cleanup: true });
      }
    } catch {
      if (!response.destroyed) {
        if (!response.headersSent) response.writeHead(500).end();
        else response.destroy();
      }
    } finally {
      if (id !== undefined) reads -= 1;
    }
    return true;
  };
}
