import type { DatabaseSync } from "node:sqlite";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function retentionBucket(createdAt: number, now: number): string | undefined {
  const age = now - createdAt;
  if (age <= 6 * HOUR) return;
  if (age <= 7 * DAY) return `hour:${Math.floor(createdAt / HOUR)}`;
  if (age <= 30 * DAY) return `day:${Math.floor(createdAt / DAY)}`;
  if (age <= 90 * DAY) return `week:${Math.floor((createdAt + 3 * DAY) / (7 * DAY))}`;
  return "expired";
}

function transaction(db: DatabaseSync, write: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    write();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function versionStorage(db: DatabaseSync) {
  const writeDocument = db.prepare(`INSERT INTO documents (name, state, version_generation) VALUES (?, ?, 1)
    ON CONFLICT(name) DO UPDATE SET state = excluded.state, version_generation = documents.version_generation + 1`);
  const markEditor = db.prepare(`INSERT INTO version_editors (script, name, generation)
    SELECT name, ?, version_generation FROM documents WHERE name = ?
    ON CONFLICT(script, name) DO UPDATE SET generation = excluded.generation`);
  const readEditors = db.prepare("SELECT name FROM version_editors WHERE script = ?");
  const clearEditors = db.prepare(`DELETE FROM version_editors WHERE script = ?
    AND generation <= (SELECT generation FROM versions WHERE id = ?)`);
  const pending = db.prepare(`SELECT name FROM documents JOIN scripts USING (name)
    WHERE status = 'active' AND version_generation > coalesce(
      (SELECT generation FROM versions WHERE script = name AND versions.status = 'published'
        ORDER BY created_at DESC, id DESC LIMIT 1), 0)`);
  const current = db.prepare(`SELECT state, version_generation FROM documents JOIN scripts USING (name)
    WHERE name = ? AND version_generation > 0 AND status = 'active'`);
  const active = db.prepare("SELECT 1 FROM scripts WHERE name = ? AND status = 'active'");
  const stage = db.prepare(`INSERT INTO versions (id, script, generation, created_at, bytes, content_hash, names, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'staged')`);
  const append = db.prepare("INSERT INTO version_chunks (version_id, part, payload) VALUES (?, ?, ?)");
  const publish = db.prepare("UPDATE versions SET created_at = ?, status = 'published' WHERE id = ?");
  const retire = db.prepare("UPDATE versions SET status = 'retired' WHERE id = ?");
  const scripts = db.prepare("SELECT DISTINCT script FROM versions WHERE status = 'published' ORDER BY script");
  const newestFirst = "FROM versions WHERE script = ? AND status = 'published' ORDER BY created_at DESC, id DESC";
  const latest = db.prepare(`SELECT created_at, content_hash ${newestFirst} LIMIT 1`);
  const list = db.prepare(`SELECT id, created_at, bytes, names ${newestFirst}`);
  const candidates = db.prepare(`SELECT id, created_at, bytes ${newestFirst}`);
  const find = db.prepare("SELECT bytes, content_hash FROM versions WHERE script = ? AND id = ? AND status = 'published'");
  const chunks = db.prepare("SELECT payload FROM version_chunks WHERE version_id = ? ORDER BY part");
  const unpublished = db.prepare("SELECT id FROM versions WHERE status <> 'published' ORDER BY id LIMIT 1");
  const removeChunk = db.prepare(`DELETE FROM version_chunks WHERE version_id = ? AND part =
    (SELECT min(part) FROM version_chunks WHERE version_id = ?)`);
  const removeVersion = db.prepare("DELETE FROM versions WHERE id = ?");
  const total = db.prepare("SELECT coalesce(sum(bytes), 0) AS bytes FROM versions WHERE status = 'published'");

  function retain(script: string, now: number, budget: number): void {
    const buckets = new Set<string>();
    let remaining = budget;
    for (const [index, row] of candidates.all(script).entries()) {
      const bytes = Number(row.bytes);
      const bucket = retentionBucket(Number(row.created_at), now);
      const outsideRetention = bucket === "expired" || (bucket !== undefined && buckets.has(bucket));
      if (index > 0 && (outsideRetention || bytes > remaining)) {
        retire.run(String(row.id));
        if (!outsideRetention) remaining = 0;
      } else {
        remaining -= bytes;
      }
      if (bucket !== undefined) buckets.add(bucket);
    }
  }

  return {
    storeDocument(script: string, state: Uint8Array, names: ReadonlySet<string> | undefined): void {
      if (!names?.size) { writeDocument.run(script, state); return; }
      transaction(db, () => {
        writeDocument.run(script, state);
        for (const name of names) markEditor.run(name, script);
      });
    },
    editorNames: (script: string) => readEditors.all(script).map(row => String(row.name)).sort(),
    pending: () => pending.all().map(row => String(row.name)),
    current(script: string) {
      const row = current.get(script);
      if (!row) return;
      return { state: row.state as Uint8Array, generation: Number(row.version_generation) };
    },
    latest(script: string) {
      const row = latest.get(script);
      if (!row) return;
      return { createdAt: Number(row.created_at), hash: row.content_hash as Uint8Array };
    },
    stage: (id: string, script: string, generation: number, now: number, bytes: number, hash: Buffer, names: readonly string[] = []) =>
      stage.run(id, script, generation, now, bytes, hash, JSON.stringify(names)),
    append: (id: string, part: number, bytes: Buffer) => append.run(id, part, bytes),
    publish(id: string, script: string, now: number, budget: number): void {
      if (!active.get(script)) return;
      transaction(db, () => {
        publish.run(now, id);
        clearEditors.run(script, id);
        retain(script, now, budget);
      });
    },
    scripts: () => scripts.all().map(row => String(row.script)),
    thin(script: string, now: number, budget: number): void {
      transaction(db, () => retain(script, now, budget));
    },
    reclaim(): boolean {
      const id = unpublished.get()?.id;
      if (typeof id !== "string") return false;
      if (removeChunk.run(id, id).changes === 0) removeVersion.run(id);
      return true;
    },
    list(script: string) {
      return list.all(script).map(row => ({
        id: String(row.id), createdAt: Number(row.created_at), bytes: Number(row.bytes), names: JSON.parse(String(row.names)) as string[]
      }));
    },
    read(script: string, id: string) {
      const row = find.get(script, id);
      if (!row) return;
      const parts = chunks.all(id).map(chunk => chunk.payload as Uint8Array);
      if (parts.reduce((sum, part) => sum + part.length, 0) !== row.bytes) throw new Error("Version payload size differs.");
      return { compressed: Buffer.concat(parts), hash: row.content_hash as Uint8Array };
    },
    total: () => Number(total.get()?.bytes ?? 0)
  };
}
