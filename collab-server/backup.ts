import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";
import { dataDirectory, RelayError, retentionCount } from "./config.ts";
import { DB_NAME, verifyDatabase } from "./storage.ts";

const BACKUP_NAME = /^relay-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z-[a-f0-9-]{36}\.sqlite$/;

function requireDatabaseOnlyBackup(source: DatabaseSync): void {
  if (source.prepare("SELECT 1 FROM script_pictures LIMIT 1").get()) {
    throw new RelayError("Relay backup requires picture files. Keep existing backups and wait for picture backup support.");
  }
}

export function verifyCopy(source: DatabaseSync, copy: DatabaseSync): void {
  requireDatabaseOnlyBackup(source);
  verifyDatabase(copy);
  verifyRows(source, copy, "documents", "SELECT name, state FROM documents ORDER BY name");
  verifyRows(source, copy, "scripts", "SELECT name, status FROM scripts ORDER BY name");
  verifyRows(source, copy, "script pictures", "SELECT script, sha, bytes, mime FROM script_pictures ORDER BY script, sha");
  verifyRows(source, copy, "invitations", "SELECT id, script, label, token_hash, revoked FROM invitations ORDER BY id");
}

function valuesMatch(left: SQLOutputValue, right: SQLOutputValue | undefined): boolean {
  return left instanceof Uint8Array && right instanceof Uint8Array ? Buffer.compare(left, right) === 0 : left === right;
}

function verifyRows(source: DatabaseSync, copy: DatabaseSync, table: string, query: string): void {
  const expected = source.prepare(query).iterate();
  try {
    for (const row of copy.prepare(query).iterate()) {
      const original = expected.next().value;
      if (!original || Object.entries(row).some(([column, value]) => !valuesMatch(value, original[column]))) {
        throw new RelayError(`Relay backup ${table} differ from the source snapshot.`);
      }
    }
    if (!expected.next().done) throw new RelayError(`Relay backup is missing ${table} from the source snapshot.`);
  } finally {
    expected.return?.();
  }
}

export async function backupRelay(env: NodeJS.ProcessEnv, copyDatabase = backup): Promise<string> {
  const directory = dataDirectory(env);
  const keep = retentionCount(env);
  const destination = join(directory, "backups");
  using source = new DatabaseSync(join(directory, DB_NAME), { readOnly: true, timeout: 5000 });
  source.exec("BEGIN");
  verifyDatabase(source);
  requireDatabaseOnlyBackup(source);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(destination, ".backup-"));
  const pending = join(staging, DB_NAME);
  try {
    const date = new Date().toISOString().replaceAll(":", "-");
    await copyDatabase(source, pending);
    {
      using copy = new DatabaseSync(pending, { readOnly: true });
      verifyCopy(source, copy);
    }
    source.exec("COMMIT");
    const name = `relay-${date}-${randomUUID()}.sqlite`;
    renameSync(pending, join(destination, name));
    const older = readdirSync(destination, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name !== name && BACKUP_NAME.test(entry.name));
    for (const { name: expired } of older.sort((a, b) => b.name.localeCompare(a.name)).slice(keep - 1)) {
      rmSync(join(destination, expired), { force: true });
    }
    return name;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
