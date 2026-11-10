import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import type { Connection, Extension } from "@hocuspocus/server";
import * as Y from "yjs";

export async function initialImagesDurable(port: number, instance: string, token: string, state: Uint8Array): Promise<void> {
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, state);
    for (const item of document.getMap<{ ref: string }>("gallery").values()) {
      if (!/^[a-f0-9]{64}$/.test(item.ref)) throw new Error("Invalid initial image reference");
      const response = await fetch(`http://127.0.0.1:${port}/api/images/${instance}/${item.ref}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!response.ok || createHash("sha256").update(bytes).digest("hex") !== item.ref) throw new Error("Initial image is not durable");
    }
  } finally { document.destroy(); }
}

export async function imageService(path: string, authorize: (instance: string, token: string) => Promise<void> = async (instance, token) => {
  if (instance !== "fixture" || token !== "") throw new Error("Image access denied");
}): Promise<{
  extension: Extension; port: number; command: (message: Record<string, unknown>) => Promise<void>; close: () => Promise<void>;
}> {
  const folder = `${path}.images`;
  const worker = new Worker(new URL("./store-worker.ts", import.meta.url), { workerData: { path, folder } });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let next = 1;
  let terminal: Error | null = null;
  const ready = new Promise<unknown>((resolve, reject) => pending.set(0, { resolve, reject }));
  const fail = (error: Error): void => {
    terminal = error;
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  };
  worker.on("error", fail);
  worker.on("exit", code => fail(new Error(`Image worker exited (${code})`)));
  worker.on("message", (message: { id?: number; value?: unknown; error?: string; event?: string; sha?: string }) => {
    if (message.event) { process.send?.(message); return; }
    if (message.id === undefined) return;
    const item = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) item?.reject(new Error(message.error)); else item?.resolve(message.value);
  });
  const request = (command: string, data: Record<string, unknown> = {}): Promise<unknown> => {
    if (terminal) return Promise.reject(terminal);
    const id = next++;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ id, command, ...data }); });
  };
  try {
    const settings = await ready as { journalMode: string; synchronous: number };
    if (settings.journalMode !== "wal" || settings.synchronous !== 2) throw new Error("Image durability mismatch");
  } catch (error) { await worker.terminate(); throw error; }
  const database = new DatabaseSync(path, { readOnly: true });
  const has = (document: string, sha: string): boolean => Boolean(database.prepare("SELECT 1 FROM image_membership WHERE document=? AND sha=?").get(document, sha));
  const temporary = new WeakSet<Connection>();
  const extension: Extension = {
    async onStateless({ payload, connection }) {
      if (payload.startsWith('{"imageFence":')) connection.sendStateless(payload);
    },
    async beforeSync({ type, payload, connection, document, documentName }) {
      if (type !== 1 && type !== 2 || connection.readOnly || process.env.IMAGE_MISSING_RECEIPT) return;
      const candidate = new Y.Doc();
      try {
        Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document));
        Y.applyUpdate(candidate, payload);
        for (const entry of candidate.getMap<{ ref: string; pending: boolean }>("gallery").values()) {
          if (!entry.pending && !has(documentName, entry.ref)) {
            connection.readOnly = true;
            temporary.add(connection);
            connection.sendStateless(JSON.stringify({ retryAfter: entry.ref, permanent: false }));
            return;
          }
        }
      } finally { candidate.destroy(); }
    },
    async afterHandleMessage({ connection }) { if (temporary.delete(connection)) connection.readOnly = false; },
  };
  const http = createServer((req, res) => {
    void (async () => {
      const match = /^\/api\/images\/(fixture|d[0-9a-f]{32})\/([a-f0-9]{64})$/.exec(req.url ?? "");
      if (!match) { res.writeHead(404).end(); return; }
      const document = match[1] ?? "";
      const sha = match[2] ?? "";
      const authorization = req.headers.authorization;
      const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
      try { await authorize(document, token); }
      catch { res.writeHead(403).end(); req.resume(); return; }
      if (req.method === "GET") {
        if (!has(document, sha)) { res.writeHead(404).end(); return; }
        res.writeHead(200, { "content-type": "image/png" }).end(await readFile(join(folder, sha)));
        return;
      }
      if (req.method !== "PUT") { res.writeHead(405).end(); return; }
      if (Number(req.headers["content-length"]) > 16777216) { res.writeHead(413).end(); req.resume(); return; }
      if (req.headers["content-type"] !== "image/png") { res.writeHead(415).end(); req.resume(); return; }
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk as Uint8Array);
        size += bytes.length;
        if (size > 16777216) { res.writeHead(413).end(); req.resume(); return; }
        chunks.push(bytes);
      }
      await authorize(document, token);
      const result = await request("upload", { document, sha, bytes: Buffer.concat(chunks) });
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify(result));
    })().catch(error => { if (!res.headersSent) res.writeHead(422); res.end(error instanceof Error ? error.message : String(error)); });
  });
  http.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { http.once("listening", resolve); http.once("error", reject); });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("No image port");
  return {
    extension, port: address.port,
    async command(message) {
      if (message.command === "image-configure") {
        await request("configure", { hold: message.hold, early: message.early });
        process.send?.({ event: "image-configured" });
      } else if (message.command === "image-release") worker.postMessage({ command: "release" });
    },
    async close() {
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
      database.close(); await worker.terminate();
    },
  };
}
