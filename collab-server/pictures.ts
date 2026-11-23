import { createHash } from "node:crypto";
import { closeSync, createReadStream, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { imageDims, isSha256Hex, sniffImageMime } from "../shared/blob-policy.ts";
import type { scriptAccess } from "./access.ts";

const PICTURE_BYTES = 16 * 1024 * 1024;
const SCRIPT_BYTES = 200 * 1024 * 1024;
const UPLOAD_SLOTS = 4;
const UPLOAD_TIMEOUT_MS = 60_000;

function respond(response: ServerResponse, status: number): void {
  if (!response.destroyed) response.writeHead(status).end();
}

export function pictureApi(db: DatabaseSync, directory: string, access: ReturnType<typeof scriptAccess>, origins: ReadonlySet<string>) {
  const pictures = join(directory, "pictures");
  mkdirSync(pictures, { recursive: true, mode: 0o700 });
  const find = db.prepare("SELECT bytes, mime FROM script_pictures WHERE script = ? AND sha = ?");
  const total = db.prepare("SELECT coalesce(sum(bytes), 0) AS bytes FROM script_pictures WHERE script = ?");
  const referenced = db.prepare("SELECT 1 FROM script_pictures WHERE sha = ? LIMIT 1");
  const record = db.prepare("INSERT INTO script_pictures VALUES (?, ?, ?, ?)");
  for (const entry of readdirSync(pictures, { withFileTypes: true })) {
    if (entry.isFile() && (/^upload-[0-3]$/.test(entry.name) || (isSha256Hex(entry.name) && !referenced.get(entry.name)))) {
      rmSync(join(pictures, entry.name));
    }
  }
  const slots = Array.from({ length: UPLOAD_SLOTS }, (_, index) => ({
    path: join(pictures, "upload-" + index), active: false, needsCleanup: false
  }));
  const uploads = new Map<IncomingMessage, Promise<void>>();
  let closed = false;

  function cleanSlot(slot: (typeof slots)[number]): boolean {
    try {
      rmSync(slot.path, { force: true });
      slot.needsCleanup = false;
    } catch {
      slot.needsCleanup = true;
    }
    return !slot.needsCleanup;
  }

  async function upload(request: IncomingMessage, response: ServerResponse, script: string, sha: string, invitation: string) {
    if (Number(request.headers["content-length"]) > PICTURE_BYTES) return respond(response, 413);
    const slot = slots.find(slot => !slot.active && (!slot.needsCleanup || cleanSlot(slot)));
    if (!slot) return respond(response, 503);
    slot.active = true;
    const temporary = slot.path;
    const timeout = setTimeout(() => request.destroy(), UPLOAD_TIMEOUT_MS);
    try {
      const hash = createHash("sha256");
      let bytes = 0;
      {
        await using file = await open(temporary, "wx", 0o600);
        for await (const chunk of request.iterator({ destroyOnReturn: false })) {
          const data = chunk as Buffer;
          if (bytes + data.length > PICTURE_BYTES) return respond(response, 413);
          hash.update(data);
          let offset = 0;
          while (offset < data.length) {
            const { bytesWritten } = await file.write(data, offset, data.length - offset, bytes + offset);
            if (!bytesWritten) throw new Error();
            offset += bytesWritten;
          }
          bytes += data.length;
        }
        if (!request.complete || response.destroyed) return;
        if (hash.digest("hex") !== sha) return respond(response, 422);
        await file.sync();
      }
      const data = await readFile(temporary);
      if (response.destroyed) return;
      const mime = sniffImageMime(data);
      if (!mime || mime !== request.headers["content-type"] || !imageDims(data)) return respond(response, 415);
      if (!access.isValid(invitation)) return respond(response, 403);
      const existing = find.get(script, sha);
      if (!existing && Number(total.get(script)?.bytes) + bytes > SCRIPT_BYTES) return respond(response, 413);
      const destination = join(pictures, sha);
      const alreadyReferenced = existing || referenced.get(sha);
      const needsFile = !statSync(destination, { throwIfNoEntry: false });
      if (needsFile) renameSync(temporary, destination);
      try {
        if (process.platform !== "win32") {
          const folder = openSync(pictures, "r");
          try {
            fsyncSync(folder);
          } finally {
            closeSync(folder);
          }
        }
        if (!existing) record.run(script, sha, bytes, mime);
      } catch (error) {
        if (needsFile && !alreadyReferenced) rmSync(destination, { force: true });
        throw error;
      }
      respond(response, existing ? 204 : 201);
    } finally {
      clearTimeout(timeout);
      cleanSlot(slot);
      slot.active = false;
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const path = /^\/api\/scripts\/([^/?]+)\/pictures\/([^/?]+)$/.exec(request.url ?? "");
    if (!path) return false;
    const [, encodedScript = "", sha = ""] = path;
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "PUT") response.setHeader("Connection", "close");
    if (!isSha256Hex(sha)) {
      respond(response, 400);
      return true;
    }
    const origin = request.headers.origin;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Vary", "Origin");
    if (origin && origins.has(origin)) response.setHeader("Access-Control-Allow-Origin", origin);
    if (request.method === "OPTIONS") {
      const method = request.headers["access-control-request-method"];
      if (origin && origins.has(origin) && (method === "GET" || method === "PUT")) {
        response.setHeader("Access-Control-Allow-Methods", "GET, PUT");
        response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
        respond(response, 204);
      } else respond(response, 403);
      return true;
    }
    if (closed) {
      respond(response, 503);
      return true;
    }
    let script: string;
    let invitation: string;
    try {
      script = decodeURIComponent(encodedScript);
      invitation = access.authenticate(script, /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "");
    } catch {
      respond(response, 403);
      return true;
    }
    try {
      if (request.method === "PUT") {
        const pending = upload(request, response, script, sha, invitation);
        uploads.set(request, pending);
        try {
          await pending;
        } finally {
          uploads.delete(request);
        }
      } else if (request.method === "GET") {
        const picture = find.get(script, sha);
        if (!picture) respond(response, 404);
        else {
          response.setHeader("X-Content-Type-Options", "nosniff");
          response.setHeader("Content-Type", String(picture.mime));
          response.setHeader("Content-Length", Number(picture.bytes));
          await pipeline(createReadStream(join(pictures, sha)), response);
        }
      } else {
        response.setHeader("Allow", "GET, PUT");
        respond(response, 405);
      }
    } catch {
      if (!response.headersSent) respond(response, 500);
      else response.destroy();
    }
    return true;
  }

  return {
    handle,
    async close() {
      closed = true;
      for (const request of uploads.keys()) request.destroy();
      await Promise.allSettled(uploads.values());
    }
  };
}
