import { createHash, randomUUID } from "node:crypto";
import { constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";
import { isSha256Hex } from "../shared/blob-policy.ts";
import { dataDirectory, RelayError, retentionCount } from "./config.ts";
import { DB_NAME, verifyDatabase } from "./storage.ts";

const BACKUP_NAME = /^relay-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z-[a-f0-9-]{36}\.(sqlite|backup)$/;

function copyPictures(db: DatabaseSync, version: number, source: string, destination: string): void {
  if (version < 3) return;
  const rows = db.prepare("SELECT sha, min(bytes) AS smallest, max(bytes) AS largest FROM script_pictures GROUP BY sha");
  const pictures = join(destination, "pictures");
  mkdirSync(pictures, { mode: 0o700 });
  for (const { sha, smallest, largest } of rows.iterate()) {
    if (typeof sha !== "string" || !isSha256Hex(sha)) throw new RelayError("Relay backup has an invalid picture hash.");
    const path = join(source, "pictures", sha);
    const file = lstatSync(path, { throwIfNoEntry: false });
    if (!file?.isFile()) throw new RelayError("Relay backup is missing a picture.");
    if (file.size !== smallest || smallest !== largest) throw new RelayError("Relay backup picture size differs.");
    const copied = join(pictures, sha);
    copyFileSync(path, copied, constants.COPYFILE_EXCL);
    const bytes = readFileSync(copied);
    if (bytes.length !== smallest || createHash("sha256").update(bytes).digest("hex") !== sha) {
      throw new RelayError("Relay backup picture failed verification.");
    }
  }
}

export function verifyCopy(source: DatabaseSync, copy: DatabaseSync): void {
  const version = verifyDatabase(copy);
  if (version !== verifyDatabase(source)) throw new RelayError("Relay backup storage version differs.");
  if (version >= 2) verifyRows(source, copy, "creations", "SELECT id, script FROM creations ORDER BY id");
  verifyRows(source, copy, "documents", "SELECT name, state FROM documents ORDER BY name");
  verifyRows(source, copy, "scripts", "SELECT name, status FROM scripts ORDER BY name");
  if (version >= 3) verifyRows(source, copy, "script pictures", "SELECT script, sha, bytes, mime FROM script_pictures ORDER BY script, sha");
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
  const version = verifyDatabase(source);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(destination, ".backup-"));
  const pending = join(staging, DB_NAME);
  try {
    const date = new Date().toISOString().replaceAll(":", "-");
    await copyDatabase(source, pending);
    {
      using copy = new DatabaseSync(pending, { readOnly: true });
      verifyCopy(source, copy);
      copyPictures(copy, version, directory, staging);
    }
    source.exec("COMMIT");
    const name = `relay-${date}-${randomUUID()}.backup`;
    renameSync(staging, join(destination, name));
    const older = readdirSync(destination, { withFileTypes: true })
      .filter(entry => entry.name !== name && BACKUP_NAME.test(entry.name) && (
        entry.isFile() && entry.name.endsWith(".sqlite") ||
        entry.isDirectory() && entry.name.endsWith(".backup") &&
        lstatSync(join(destination, entry.name, DB_NAME), { throwIfNoEntry: false })?.isFile()
      ));
    for (const { name: expired } of older.sort((a, b) => b.name.localeCompare(a.name)).slice(keep - 1)) {
      rmSync(join(destination, expired), { recursive: true, force: true });
    }
    return name;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function restoreRelay(archive: string, target: string): Promise<void> {
  const directory = resolve(target);
  const bundled = lstatSync(archive).isDirectory();
  using source = new DatabaseSync(bundled ? join(archive, DB_NAME) : archive, { readOnly: true, timeout: 5000 });
  source.exec("BEGIN");
  const version = verifyDatabase(source);
  if (!bundled && version >= 3 && source.prepare("SELECT 1 FROM script_pictures LIMIT 1").get()) {
    throw new RelayError("Relay restore requires a backup directory with picture files.");
  }
  mkdirSync(directory, { mode: 0o700 });
  let completed = false;
  try {
    const pending = join(directory, ".restore.sqlite");
    await backup(source, pending);
    {
      using copy = new DatabaseSync(pending);
      verifyCopy(source, copy);
      copyPictures(copy, version, archive, directory);
      copy.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; UPDATE invitations SET revoked = 1 WHERE revoked = 0");
    }
    renameSync(pending, join(directory, DB_NAME));
    completed = true;
  } finally {
    if (!completed) rmSync(directory, { recursive: true, force: true });
  }
}
