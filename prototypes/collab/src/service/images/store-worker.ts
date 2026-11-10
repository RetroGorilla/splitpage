import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

const port = parentPort;
if (!port) throw new Error("Image worker requires a parent");
const { path, folder } = workerData as { path: string; folder: string };
const database = new DatabaseSync(path, { timeout: 15000 });
database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
database.exec("CREATE TABLE IF NOT EXISTS image_membership (document TEXT NOT NULL, sha TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(document, sha))");
await mkdir(folder, { recursive: true });
let hold = false;
let early = false;
const gates = new Map<number, () => void>();
port.postMessage({ id: 0, value: { journalMode: database.prepare("PRAGMA journal_mode").get()?.journal_mode,
  synchronous: database.prepare("PRAGMA synchronous").get()?.synchronous } });

port.on("message", (request: { id: number; command: string; document: string; sha: string; bytes: Uint8Array; hold?: boolean; early?: boolean }) => {
  if (request.command === "release") { for (const release of gates.values()) release(); gates.clear(); return; }
  if (request.command === "configure") {
    hold = request.hold === true; early = request.early === true;
    port.postMessage({ id: request.id, value: null });
    return;
  }
  void upload(request).catch(error => port.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) }));
});

async function upload(request: { id: number; document: string; sha: string; bytes: Uint8Array }): Promise<void> {
  const { id, document, sha, bytes } = request;
  if (!/^[a-f0-9]{64}$/.test(sha) || createHash("sha256").update(bytes).digest("hex") !== sha) throw new Error("hash-mismatch");
  if (bytes.length > 16777216) throw new Error("image-too-large");
  if (bytes.length < 24 || Buffer.from(bytes.subarray(0, 8)).toString("hex") !== "89504e470d0a1a0a"
    || Buffer.from(bytes.subarray(12, 16)).toString() !== "IHDR"
    || !Buffer.from(bytes).readUInt32BE(16) || !Buffer.from(bytes).readUInt32BE(20)) throw new Error("invalid-png-header");
  const target = join(folder, sha);
  const temporary = join(folder, `${sha}.${id}.tmp`);
  try {
    const file = await open(temporary, "wx");
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary, target);
    const verified = await readFile(target);
    if (createHash("sha256").update(verified).digest("hex") !== sha) throw new Error("stored-hash-mismatch");
    const blocked = hold;
    const premature = early;
    if (premature) port?.postMessage({ id, value: { sha, size: bytes.length } });
    if (blocked) await new Promise<void>(resolve => {
      gates.set(id, resolve);
      port?.postMessage({ event: "image-staged", sha });
    });
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("INSERT OR IGNORE INTO image_membership(document, sha, size) VALUES (?, ?, ?)").run(document, sha, bytes.length);
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
    if (!premature) port?.postMessage({ id, value: { sha, size: bytes.length } });
  } finally { await rm(temporary, { force: true }); }
}
