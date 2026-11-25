import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";
import { isSha256Hex } from "../shared/blob-policy.ts";
import { LINK_PASSWORD_MAX, PASSWORD_SHARE_TYPE, validLinkPassword } from "../shared/link-password.ts";
import type { AbandonResult, InvitationRole, IssuedInvitation, scriptAccess } from "./access.ts";
import { RelayError } from "./config.ts";
import { managementAuthorizer } from "./management-auth.ts";

type Commands = Pick<
  ReturnType<typeof scriptAccess>,
  "findCreation" | "create" | "listScripts" | "issue" | "list" | "authorizeOwner" | "activeLink" | "hasPassword" | "readPassword" | "exchange"
> & {
  abandonCreation: (id: string) => AbandonResult;
  authenticate: (name: string, token: string) => unknown;
  resetGuests: (name: string) => IssuedInvitation | undefined;
  changePassword: (name: string, token: string | null, password: string | null) => Promise<boolean>;
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

async function readPasswordBody(request: IncomingMessage): Promise<string | null> {
  const raw = await body(request, 2048);
  let payload: { password?: unknown } | null;
  try { payload = JSON.parse(raw.toString("utf8")) as typeof payload; }
  catch { throw new RequestError(400); }
  const value = payload?.password;
  if (value !== null && !validLinkPassword(value)) throw new RequestError(400);
  return value;
}

async function creationBody(request: IncomingMessage, limit: number): Promise<{ bytes: Buffer; password?: string }> {
  const protectedShare = request.headers["content-type"] === PASSWORD_SHARE_TYPE;
  const maxPasswordBytes = LINK_PASSWORD_MAX * 3;
  const bodyLimit = protectedShare ? limit + maxPasswordBytes + 2 : limit;
  if (Number(request.headers["content-length"]) > bodyLimit) throw new RequestError(413);
  const raw = await body(request, bodyLimit);
  if (!protectedShare) return { bytes: raw };
  if (raw.length < 2) throw new RequestError(400);
  const length = raw.readUInt16BE();
  if (length > maxPasswordBytes || length + 2 >= raw.length) throw new RequestError(400);
  const password = raw.toString("utf8", 2, length + 2);
  if (!validLinkPassword(password)) throw new RequestError(400);
  const bytes = raw.subarray(length + 2);
  if (bytes.length > limit) throw new RequestError(413);
  return { bytes, password };
}

export function ownerRequests(secret: string | undefined, limit: number, commands: Commands, deployment?: string,
  origins: ReadonlySet<string> = new Set()) {
  const authorize = managementAuthorizer(secret);
  const attempts = new Map<string, { failures: number; until: number }>();
  let exchangesInFlight = 0;
  let nextSweep = 0;
  const attemptPeriod = 60_000;
  function attemptWindow(name: string) {
    const now = Date.now();
    if (now >= nextSweep) {
      for (const [script, record] of attempts) if (record.until <= now) attempts.delete(script);
      nextSweep = now + attemptPeriod;
    }
    let record = attempts.get(name);
    if (!record || record.until <= now) {
      record = { failures: 0, until: now + attemptPeriod };
      attempts.set(name, record);
    }
    return record;
  }
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = request.url?.split("?")[0] ?? "";
    const script = /^\/api\/scripts\/([a-zA-Z0-9_-]{1,128})(?:\/(invitations|reset|link|password|password-exchange))?$/.exec(path);
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
      const name = script?.[1];
      if (name && script[2] === "password-exchange") {
        const origin = request.headers.origin;
        response.setHeader("Vary", "Origin");
        if (origin !== undefined && !origins.has(origin)) throw new RequestError(403);
        if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
        if (method === "OPTIONS") {
          if (!origin || request.headers["access-control-request-method"] !== "POST") throw new RequestError(403);
          response.setHeader("Access-Control-Allow-Methods", "POST");
          response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
          reply(204);
          return true;
        }
        if (method !== "POST") throw new RequestError(405);
        const token = bearerToken(request);
        if (!token || !commands.activeLink(name, token)) throw new RequestError(403);
        const value = await readPasswordBody(request);
        if (!request.complete || response.destroyed) return true;
        if (!commands.activeLink(name, token)) throw new RequestError(403);
        const stored = commands.readPassword(name);
        const attempt = stored && value !== null ? attemptWindow(name) : undefined;
        if (!stored) reply(200, { token });
        else if (value === null) reply(428);
        else if (exchangesInFlight >= 8 || (attempt && attempt.failures >= 5)) {
          response.setHeader("Retry-After", "60");
          reply(429);
        } else {
          exchangesInFlight += 1;
          try {
            const result = await commands.exchange(name, token, value, stored);
            if (result.kind === "exchanged") reply(200, { token: result.token });
            else if (result.kind === "wrong-password") {
              if (attempt) attempt.failures += 1;
              reply(401);
            } else if (result.kind === "device-limit") {
              response.setHeader("Retry-After", "5");
              reply(429);
            } else reply(result.kind === "invalid-link" ? 403 : 409);
          } finally { exchangesInFlight -= 1; }
        }
        return true;
      }
      if (script?.[1] && script[2] === "link" && method === "HEAD") {
        if (deployment !== undefined) response.setHeader("Splitpage-Deployment", deployment);
        const token = bearerToken(request) ?? "";
        if (commands.hasPassword(script[1]) && commands.activeLink(script[1], token)) throw new RequestError(428);
        try { commands.authenticate(script[1], token); }
        catch { throw new RequestError(403); }
        reply(204);
        return true;
      }
      const isManager = authorize(request);
      if (name && script[2] === "password" && (method === "GET" || method === "PUT")) {
        const token = isManager ? null : bearerToken(request);
        if (!isManager) {
          if (!token) throw new RequestError(401);
          const check = commands.authorizeOwner(name, token, false);
          if (check !== "allowed") throw new RequestError(check === "unknown" ? 401 : check === "inactive" ? 409 : 403);
        }
        if (method === "GET") reply(200, { required: commands.hasPassword(name) });
        else {
          const value = await readPasswordBody(request);
          if (!request.complete || response.destroyed) return true;
          const changed = await commands.changePassword(name, token, value);
          if (changed) attempts.delete(name);
          reply(changed ? 204 : 409);
        }
        return true;
      }
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
        const { bytes, password } = await creationBody(request, limit);
        if (!request.complete || response.destroyed) return true;
        const actualHash = createHash("sha256").update(bytes).digest();
        if (Buffer.compare(actualHash, expectedHash) !== 0) throw new RequestError(422);
        if (existing === undefined) checkState(bytes, limit);
        const created = await commands.create(id, bytes, actualHash, password);
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
