import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";

export function inspectInstance(path: string, id?: string): {
  instances: { id: string; operation: string; state: string }[];
  checkpoint: { sequence: number; payload: Uint8Array } | null;
  rows: { sequence: number; payload: Uint8Array }[];
  pruned: number;
} {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'instances'").all();
    if (!tables.length) return { instances: [], checkpoint: null, rows: [], pruned: 0 };
    const instances = db.prepare("SELECT id, operation, state FROM instances ORDER BY id").all()
      .map(row => ({ id: String(row.id), operation: String(row.operation), state: String(row.state) }));
    const document = id ?? instances[0]?.id ?? "";
    const checkpoint = db.prepare("SELECT sequence, payload, digest FROM instance_checkpoints WHERE document = ? ORDER BY sequence DESC LIMIT 1").get(document);
    if (checkpoint) {
      assert.ok(checkpoint.payload instanceof Uint8Array);
      assert.equal(createHash("sha256").update(JSON.stringify([document, Number(checkpoint.sequence)])).update(checkpoint.payload).digest("hex"), checkpoint.digest);
    }
    return {
      instances,
      checkpoint: checkpoint ? { sequence: Number(checkpoint.sequence), payload: checkpoint.payload as Uint8Array } : null,
      rows: db.prepare("SELECT sequence, payload FROM updates WHERE document = ? ORDER BY sequence").all(document).map(row => {
        assert.ok(row.payload instanceof Uint8Array);
        return { sequence: Number(row.sequence), payload: row.payload };
      }),
      pruned: Number(db.prepare("SELECT sequence FROM instance_pruning WHERE document = ?").get(document)?.sequence ?? 0),
    };
  } finally { db.close(); }
}

export function recoverIndependently(path: string, id: string, acknowledged: readonly Uint8Array[] = []): Y.Doc {
  const { checkpoint, rows, pruned } = inspectInstance(path, id);
  assert.ok(pruned <= (checkpoint?.sequence ?? 0), "Pruning exceeded durable checkpoint");
  const doc = new Y.Doc();
  try {
    if (checkpoint) Y.applyUpdate(doc, checkpoint.payload);
    for (const row of rows) if (row.sequence > (checkpoint?.sequence ?? 0)) Y.applyUpdate(doc, row.payload);
    const recovered = Y.decodeUpdate(Y.encodeStateAsUpdate(doc));
    for (const update of acknowledged) {
      const required = Y.decodeUpdate(update);
      for (const struct of required.structs) {
        if (struct instanceof Y.Skip) continue;
        const intervals = recovered.structs.filter(item => !(item instanceof Y.Skip) && item.id.client === struct.id.client)
          .map(item => [item.id.clock, item.id.clock + item.length] as const);
        cover(intervals, struct.id.clock, struct.id.clock + struct.length, "Acknowledged insertion missing");
      }
      for (const [client, ranges] of required.ds.clients) for (const range of ranges) {
        cover((recovered.ds.clients.get(client) ?? []).map(item => [item.clock, item.clock + item.len]),
          range.clock, range.clock + range.len, "Acknowledged deletion missing");
      }
    }
    return doc;
  } catch (error) { doc.destroy(); throw error; }
}

function cover(intervals: readonly (readonly [number, number])[], start: number, end: number, message: string): void {
  let cursor = start;
  for (const [from, to] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (from > cursor) break;
    cursor = Math.max(cursor, to);
  }
  assert.ok(cursor >= end, message);
}

export function assertSingleCreation(path: string, returned: readonly string[]): void {
  const { instances } = inspectInstance(path);
  assert.equal(instances.length, 1, "Retry created a second instance");
  for (const id of returned) assert.equal(id, instances[0]?.id);
}

export function assertInvitation(path: string, id: string, shown: string | null, localMembership: string | null): void {
  if (!shown) return;
  const record = inspectInstance(path, id).instances.find(row => row.id === id);
  assert.equal(record?.state, "committed", "Invitation preceded server commit");
  assert.equal(localMembership, id, "Invitation preceded local commit");
}

export function assertNoCredentials(doc: Y.Doc, secrets: readonly string[]): void {
  for (const key of doc.share.keys()) assert.ok(key === "R1" || key === "identity", `Unexpected document root: ${key}`);
  doc.getText("R1");
  doc.getMap("identity");
  const forbidden = secrets.flatMap(secret => [secret, createHash("sha256").update(secret).digest("hex")]);
  const walk = (value: unknown): void => {
    if (typeof value === "string") for (const secret of forbidden) assert.equal(value.includes(secret), false);
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
      assert.equal(/token|api[-_]?key|client[-_]?id|secret|password|\bpin\b/i.test(key), false);
      walk(key);
      walk(item);
    }
  };
  for (const [key, type] of doc.share) {
    walk(key);
    walk(type.toJSON());
  }
  const bytes = Buffer.from(Y.encodeStateAsUpdate(doc));
  for (const secret of forbidden) assert.equal(bytes.includes(Buffer.from(secret)), false);
}
