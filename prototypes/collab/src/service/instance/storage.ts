import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";

export type InstanceRecord = { id: string; operation: string; state: string; ownerHash: string; inviteHash: string; initialHash: string | null };
export type InstanceSnapshot = { document: string; sequence: number; payload: Uint8Array };

export function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkpointDigest(document: string, sequence: number, payload: Uint8Array): string {
  return createHash("sha256").update(JSON.stringify([document, sequence])).update(payload).digest("hex");
}

export class InstanceStorage {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY, operation TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
      ownerHash TEXT NOT NULL, inviteHash TEXT NOT NULL, initialHash TEXT);
      CREATE TABLE IF NOT EXISTS instance_uploads (document TEXT PRIMARY KEY, payload BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS instance_checkpoints (
        document TEXT NOT NULL, sequence INTEGER NOT NULL, payload BLOB NOT NULL, digest TEXT NOT NULL,
        PRIMARY KEY(document, sequence));
      CREATE TABLE IF NOT EXISTS instance_pruning (document TEXT PRIMARY KEY, sequence INTEGER NOT NULL);`);
  }

  record(operation: string): InstanceRecord | undefined {
    return this.db.prepare("SELECT * FROM instances WHERE operation = ?").get(operation) as InstanceRecord | undefined;
  }

  private transaction<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = body();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  run(action: string, data: Record<string, unknown>, pause: (phase: string) => void): unknown {
    const operation = String(data.operation ?? "");
    const id = String(data.id ?? "");
    if (action === "create") {
      const existing = this.record(operation);
      if (existing) {
        if (existing.ownerHash !== digest(String(data.owner)) || existing.inviteHash !== digest(String(data.invite))) throw new Error("Creation credentials changed");
        return existing;
      }
      pause("before-pending");
      const record: InstanceRecord = {
        id: `d${randomBytes(16).toString("hex")}`, operation, state: "pending",
        ownerHash: digest(String(data.owner)), inviteHash: digest(String(data.invite)),
        initialHash: null,
      };
      this.transaction(() => {
        this.db.prepare("INSERT INTO instances(id, operation, state, ownerHash, inviteHash) VALUES (?, ?, ?, ?, ?)")
          .run(record.id, operation, record.state, record.ownerHash, record.inviteHash);
        pause("pending-write");
      });
      pause("after-pending");
      return record;
    }
    if (action === "authorize" || action === "authorize-blob") {
      const record = this.db.prepare("SELECT * FROM instances WHERE id = ?").get(id) as InstanceRecord | undefined;
      if (!record) throw new Error("Instance unavailable");
      const hash = digest(String(data.token));
      if (record.state !== "committed" && !(action === "authorize-blob" && record.state === "pending" && hash === record.ownerHash)) {
        throw new Error("Instance unavailable");
      }
      if (hash !== record.inviteHash && hash !== record.ownerHash) throw new Error("Invalid invitation");
      return record;
    }
    if (action === "upload" || action === "commit" || action === "initial") {
      const record = this.record(operation);
      if (!record || record.ownerHash !== digest(String(data.owner))) throw new Error("Unknown creation");
      if (action === "initial") {
        if (record.state === "committed") return { id: record.id, payload: this.recover(record.id).payload };
        const row = this.db.prepare("SELECT payload FROM instance_uploads WHERE document = ?").get(record.id);
        if (!(row?.payload instanceof Uint8Array)) throw new Error("Initial generation not uploaded");
        return { id: record.id, payload: row.payload };
      }
      if (record.state === "committed") {
        if (action === "upload" && (!(data.payload instanceof Uint8Array) || digest(data.payload) !== record.initialHash)) {
          throw new Error("Creation generation changed");
        }
        return record;
      }
      if (action === "upload") {
        const payload = data.payload;
        if (!(payload instanceof Uint8Array)) throw new Error("Missing generation");
        Y.decodeUpdate(payload);
        this.transaction(() => {
          const prior = this.db.prepare("SELECT payload FROM instance_uploads WHERE document = ?").get(record.id);
          if (prior && (!(prior.payload instanceof Uint8Array) || !Buffer.from(prior.payload).equals(payload))) {
            throw new Error("Creation generation changed");
          }
          this.db.prepare("INSERT OR IGNORE INTO instance_uploads VALUES (?, ?)").run(record.id, payload);
          this.db.prepare("UPDATE instances SET initialHash = ? WHERE id = ?").run(digest(payload), record.id);
          pause("during-upload");
        });
      } else {
        this.transaction(() => {
          const row = this.db.prepare("SELECT payload FROM instance_uploads WHERE document = ?").get(record.id);
          if (!(row?.payload instanceof Uint8Array)) throw new Error("Initial generation not uploaded");
          const doc = new Y.Doc();
          try {
            Y.applyUpdate(doc, row.payload);
            doc.getMap("identity").set("docId", record.id);
            this.db.prepare("INSERT INTO updates(document, payload) VALUES (?, ?)").run(record.id, Y.encodeStateAsUpdate(doc));
          } finally { doc.destroy(); }
          this.db.prepare("UPDATE instances SET state = 'committed' WHERE id = ?").run(record.id);
          this.db.prepare("DELETE FROM instance_uploads WHERE document = ?").run(record.id);
          pause("commit-write");
        });
        pause("after-commit");
      }
      return this.record(operation);
    }
    if (action === "recover" || action === "capture") return this.recover(id);
    if (action === "checkpoint") {
      const sequence = Number(data.sequence);
      const payload = data.payload;
      if (!(payload instanceof Uint8Array) || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Invalid checkpoint");
      return this.transaction(() => {
        const current = this.newest(id);
        if (current && current.sequence >= sequence) return false;
        const expected = this.recover(id, sequence);
        if (expected.sequence !== sequence || !Buffer.from(expected.payload).equals(payload)) throw new Error("Checkpoint coverage mismatch");
        this.db.prepare("INSERT INTO instance_checkpoints VALUES (?, ?, ?, ?)").run(id, sequence, payload, checkpointDigest(id, sequence, payload));
        pause("checkpoint-write");
        return true;
      });
    }
    if (action === "prune") {
      return this.transaction(() => {
        const checkpoint = this.newest(id);
        if (!checkpoint) throw new Error("No durable checkpoint");
        this.db.prepare("DELETE FROM updates WHERE document = ? AND sequence <= ?").run(id, checkpoint.sequence);
        this.db.prepare(`INSERT INTO instance_pruning VALUES (?, ?)
          ON CONFLICT(document) DO UPDATE SET sequence = MAX(sequence, excluded.sequence)`).run(id, checkpoint.sequence);
        pause("pruning-write");
        return checkpoint.sequence;
      });
    }
    throw new Error("Unknown instance request");
  }

  private newest(document: string, through = Number.MAX_SAFE_INTEGER): InstanceSnapshot | undefined {
    const pruned = Number(this.db.prepare("SELECT sequence FROM instance_pruning WHERE document = ?").get(document)?.sequence ?? 0);
    for (const row of this.db.prepare(`SELECT sequence, payload, digest FROM instance_checkpoints
      WHERE document = ? AND sequence <= ? ORDER BY sequence DESC`).all(document, through)) {
      if (!(row.payload instanceof Uint8Array) || checkpointDigest(document, Number(row.sequence), row.payload) !== row.digest) continue;
      try { Y.decodeUpdate(row.payload); } catch { continue; }
      if (Number(row.sequence) < pruned) break;
      return { document, sequence: Number(row.sequence), payload: row.payload };
    }
    if (pruned > 0) throw new Error("No valid checkpoint covers pruned journal");
    return undefined;
  }

  private recover(document: string, through = Number.MAX_SAFE_INTEGER): InstanceSnapshot {
    const checkpoint = this.newest(document, through);
    const doc = new Y.Doc();
    let sequence = checkpoint?.sequence ?? 0;
    try {
      if (checkpoint) Y.applyUpdate(doc, checkpoint.payload);
      for (const row of this.db.prepare(`SELECT sequence, payload FROM updates
        WHERE document = ? AND sequence > ? AND sequence <= ? ORDER BY sequence`).all(document, sequence, through)) {
        if (!(row.payload instanceof Uint8Array)) throw new Error("Invalid journal row");
        Y.applyUpdate(doc, row.payload);
        sequence = Number(row.sequence);
      }
      return { document, sequence, payload: Y.encodeStateAsUpdate(doc) };
    } finally { doc.destroy(); }
  }
}
