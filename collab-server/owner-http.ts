import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";
import { isSha256Hex } from "../shared/blob-policy.ts";
import type { AbandonResult, InvitationRole, IssuedInvitation, scriptAccess } from "./access.ts";
import { RelayError } from "./config.ts";
import { managementAuthorizer } from "./management-auth.ts";

type Commands = Pick<
  ReturnType<typeof scriptAccess>,
  "findCreation" | "create" | "listScripts" | "issue" | "list" | "authorizeOwner"
> & {
  abandonCreation: (id: string) => AbandonResult;
  authenticate: (name: string, token: string) => unknown;
  resetGuests: (name: string) => IssuedInvitation | undefined;
  revokeInvitation: (id: string) => boolean;
  deleteScript: (name: string) => boolean;
};

class RequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super();
    this.status = status;
  }
}

async function body(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new RequestError(413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function checkState(bytes: Buffer, limit: number): void {
  const doc = new Doc();
  try {
    applyUpdate(doc, bytes);
    if (encodeStateAsUpdate(doc).byteLength > limit) throw new RequestError(413);
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400);
  } finally {
    doc.destroy();
  }
}

function parseIssuePayload(raw: Buffer): { role: InvitationRole; label: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new RequestError(400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RequestError(400);
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !Object.prototype.hasOwnProperty.call(record, "role") || !Object.prototype.hasOwnProperty.call(record, "label")) {
    throw new RequestError(400);
  }
  const { role, label } = record;
  if ((role !== "owner" && role !== "guest") || typeof label !== "string") throw new RequestError(400);
  const trimmed = label.trim();
  if (!trimmed || Buffer.byteLength(trimmed, "utf8") > 1024) throw new RequestError(400);
  return { role, label: trimmed };
}

function bearerToken(request: IncomingMessage): string | null {
  return /^Bearer ([A-Za-z0-9_-]{1,512})$/.exec(request.headers.authorization ?? "")?.[1] ?? null;
}

export function ownerRequests(secret: string | undefined, limit: number, commands: Commands, deployment?: string) {
  const authorize = managementAuthorizer(secret);
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = request.url?.split("?")[0] ?? "";
    const script = /^\/api\/scripts\/([a-zA-Z0-9_-]{1,128})(?:\/(invitations|reset|link))?$/.exec(path);
    const invitation = /^\/api\/invitations\/([a-zA-Z0-9_-]{1,128})$/.exec(path);
    const creation = /^\/api\/creations\/([a-zA-Z0-9_-]{1,128})$/.exec(path);
    if (path !== "/api/scripts" && !script && !invitation && !creation) return false;
    function reply(status: number, data?: unknown): void {
      if (!request.complete) response.setHeader("Connection", "close");
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(data === undefined ? undefined : JSON.stringify(data));
    }
    try {
      const method = request.method;
      if (script?.[1] && script[2] === "link" && method === "HEAD") {
        if (deployment !== undefined) response.setHeader("Splitpage-Deployment", deployment);
        try { commands.authenticate(script[1], bearerToken(request) ?? ""); }
        catch { throw new RequestError(403); }
        reply(204);
        return true;
      }
      const isManager = authorize(request);
      if (script?.[1] && script[2] === "reset" && method === "POST") {
        if (!isManager) {
          const token = bearerToken(request);
          if (!token) throw new RequestError(401);
          const check = commands.authorizeOwner(script[1], token, false);
          if (check === "unknown") throw new RequestError(401);
          if (check === "forbidden") throw new RequestError(403);
          if (check === "inactive") throw new RequestError(409);
        }
        const issued = commands.resetGuests(script[1]);
        if (!issued) throw new RequestError(404);
        reply(200, issued);
        return true;
      }
      if (script?.[1] && !script[2] && method === "DELETE") {
        if (!isManager) {
          const token = bearerToken(request);
          if (!token) throw new RequestError(401);
          const check = commands.authorizeOwner(script[1], token, true);
          if (check === "unknown") throw new RequestError(401);
          if (check === "forbidden") throw new RequestError(403);
          if (check === "inactive") throw new RequestError(409);
          if (check === "already-deleted") {
            reply(204);
            return true;
          }
        }
        reply(commands.deleteScript(script[1]) ? 204 : 404);
        return true;
      }
      if (!isManager) throw new RequestError(401);
      if (method === "POST" && path === "/api/scripts") {
        const id = request.headers["idempotency-key"];
        const hashHeader = request.headers["splitpage-content-sha256"];
        if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) ||
            typeof hashHeader !== "string" || !isSha256Hex(hashHeader)) {
          throw new RequestError(400);
        }
        const expectedHash = Buffer.from(hashHeader, "hex");
        const existing = commands.findCreation(id);
        if (existing !== undefined && (existing.contentHash === null || Buffer.compare(existing.contentHash, expectedHash) !== 0)) {
          throw new RequestError(409);
        }
        if (Number(request.headers["content-length"]) > limit) throw new RequestError(413);
        const bytes = await body(request, limit);
        if (!request.complete || response.destroyed) return true;
        const actualHash = createHash("sha256").update(bytes).digest();
        if (Buffer.compare(actualHash, expectedHash) !== 0) throw new RequestError(422);
        if (existing === undefined) checkState(bytes, limit);
        const created = commands.create(id, bytes, actualHash);
        if (deployment !== undefined) response.setHeader("Splitpage-Deployment", deployment);
        reply(200, created);
        return true;
      }
      if (method === "GET" && path === "/api/scripts") {
        reply(200, commands.listScripts());
      } else if (script?.[1] && script[2] === "invitations" && method === "POST") {
        const raw = await body(request, 2048);
        if (!request.complete || response.destroyed) return true;
        const { role, label } = parseIssuePayload(raw);
        reply(201, commands.issue(script[1], label, role));
      } else if (script?.[1] && script[2] === "invitations" && method === "GET") {
        const list = commands.list(script[1]);
        if (!list) throw new RequestError(404);
        reply(200, list);
      } else if (invitation?.[1] && method === "DELETE") {
        reply(commands.revokeInvitation(invitation[1]) ? 204 : 404);
      } else if (creation?.[1] && method === "DELETE") {
        const outcome = commands.abandonCreation(creation[1]);
        reply(outcome === "deleted" ? 204 : outcome === "not-found" ? 404 : 409);
      } else {
        reply(404);
      }
    } catch (error) {
      reply(error instanceof RequestError ? error.status : error instanceof RelayError ? 409 : 500);
    }
    return true;
  };
}
