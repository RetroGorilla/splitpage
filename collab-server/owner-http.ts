import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";
import type { scriptAccess } from "./access.ts";
import { RelayError } from "./config.ts";

type Commands = Pick<ReturnType<typeof scriptAccess>, "create" | "issue" | "list"> & {
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

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
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

export function ownerRequests(secret: string | undefined, limit: number, commands: Commands) {
  const expected = secret?.trim() ? digest(`Bearer ${secret}`) : undefined;
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = request.url?.split("?")[0] ?? "";
    const script = /^\/api\/scripts\/([a-zA-Z0-9_-]{1,128})(\/invitations)?$/.exec(path);
    const invitation = /^\/api\/invitations\/([a-zA-Z0-9_-]{1,128})$/.exec(path);
    if (path !== "/api/scripts" && !script && !invitation) return false;
    function reply(status: number, data?: unknown): void {
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(data === undefined ? undefined : JSON.stringify(data));
    }
    try {
      if (!expected || !timingSafeEqual(digest(request.headers.authorization ?? ""), expected)) {
        throw new RequestError(401);
      }
      const method = request.method;
      if (method === "POST" && path === "/api/scripts") {
        const id = request.headers["idempotency-key"];
        if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new RequestError(400);
        const bytes = await body(request, limit);
        checkState(bytes, limit);
        reply(200, { scriptId: commands.create(id, bytes) });
        return true;
      }
      if (script?.[1] && script[2] && method === "POST") {
        const label = (await body(request, 1024)).toString("utf8").trim();
        if (!label) throw new RequestError(400);
        reply(201, commands.issue(script[1], label));
      } else if (script?.[1] && script[2] && method === "GET") {
        const list = commands.list(script[1]);
        if (!list) throw new RequestError(404);
        reply(200, list);
      } else if (script?.[1] && !script[2] && method === "DELETE") {
        reply(commands.deleteScript(script[1]) ? 204 : 404);
      } else if (invitation?.[1] && method === "DELETE") {
        reply(commands.revokeInvitation(invitation[1]) ? 204 : 404);
      } else {
        reply(404);
      }
    } catch (error) {
      if (!request.complete) response.setHeader("Connection", "close");
      reply(error instanceof RequestError ? error.status : error instanceof RelayError ? 409 : 500);
    }
    return true;
  };
}
