import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, copyFileSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";
import { isSha256Hex } from "../shared/blob-policy.ts";
import { dataDirectory, RelayError, retentionCount } from "./config.ts";
import { DB_NAME, verifyDatabase } from "./storage.ts";

const BACKUP_NAME = /^relay-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z-[a-f0-9-]{36}\.(sqlite|backup)$/;

function claimBackup(lock: DatabaseSync): void {
  try {
    lock.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    if ((error as { errcode?: number }).errcode === 5) {
      throw new RelayError("A relay backup is already running. Retry once it finishes.");
    }
    throw error;
  }
}

function existingBackups(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => BACKUP_NAME.test(entry.name) && (
      entry.isFile() && entry.name.endsWith(".sqlite") ||
      entry.isDirectory() && entry.name.endsWith(".backup") &&
      lstatSync(join(directory, entry.name, DB_NAME), { throwIfNoEntry: false })?.isFile()
    ))
    .map(entry => entry.name)
    .sort((a, b) => b.localeCompare(a));
}

function syncPath(path: string, flags = "r"): void {
  const fd = openSync(path, flags);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncBundle(directory: string, syncDirectory: ((path: string) => void) | null): void {
  const pictures = join(directory, "pictures");
  if (lstatSync(pictures, { throwIfNoEntry: false })) {
    for (const name of readdirSync(pictures)) syncPath(join(pictures, name), "r+");
    syncDirectory?.(pictures);
  }
  syncPath(join(directory, DB_NAME), "r+");
  syncDirectory?.(directory);
}

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

export async function backupRelay(
  env: NodeJS.ProcessEnv,
  copyDatabase = backup,
  syncDirectory = process.platform === "win32" ? null : syncPath
): Promise<string> {
  const directory = dataDirectory(env);
  const keep = retentionCount(env);
  const destination = join(directory, "backups");
  using source = new DatabaseSync(join(directory, DB_NAME), { readOnly: true, timeout: 5000 });
  using ownership = new DatabaseSync(join(directory, "relay-backup-lock.sqlite"));
  claimBackup(ownership);
  source.exec("BEGIN");
  const version = verifyDatabase(source);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(destination, { withFileTypes: true })) {
    if (entry.isDirectory() && /^\.backup-[a-zA-Z0-9]{6}$/.test(entry.name)) {
      rmSync(join(destination, entry.name), { recursive: true, force: true });
    }
  }
  const older = existingBackups(destination);
  if (!syncDirectory && older.length >= keep) {
    throw new RelayError("Relay backup retention is full and directory sync is unavailable. Verify an off-machine copy and move an archived backup out of local retention, then retry.");
  }
  const staging = mkdtempSync(join(destination, ".backup-"));
  const pending = join(staging, DB_NAME);
  try {
    const date = new Date().toISOString().replaceAll(":", "-");
    await copyDatabase(source, pending);
    {
      using copy = new DatabaseSync(pending);
      copy.exec("PRAGMA journal_mode=DELETE");
      verifyCopy(source, copy);
      copyPictures(copy, version, directory, staging);
    }
    source.exec("COMMIT");
    const name = `relay-${date}-${randomUUID()}.backup`;
    syncBundle(staging, syncDirectory);
    const published = join(destination, name);
    renameSync(staging, published);
    if (!syncDirectory) return name;
    try {
      syncDirectory(destination);
      syncDirectory(directory);
    } catch (error) {
      renameSync(published, staging);
      throw error;
    }
    for (const expired of older.slice(keep - 1)) {
      rmSync(join(destination, expired), { recursive: true, force: true });
    }
    return name;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function requireUnusedTarget(directory: string): void {
  if (lstatSync(directory, { throwIfNoEntry: false })) {
    throw new RelayError("Relay restore requires a new data directory.");
  }
}

export async function restoreRelay(archive: string, target: string, copyDatabase = backup): Promise<void> {
  const directory = resolve(target);
  requireUnusedTarget(directory);
  const bundled = lstatSync(archive).isDirectory();
  using source = new DatabaseSync(bundled ? join(archive, DB_NAME) : archive, { readOnly: true, timeout: 5000 });
  source.exec("BEGIN");
  const version = verifyDatabase(source);
  if (!bundled && version >= 3 && source.prepare("SELECT 1 FROM script_pictures LIMIT 1").get()) {
    throw new RelayError("Relay restore requires a backup directory with picture files.");
  }
  const staging = mkdtempSync(join(dirname(directory), ".restore-"));
  try {
    const pending = join(staging, DB_NAME);
    await copyDatabase(source, pending);
    {
      using copy = new DatabaseSync(pending);
      verifyCopy(source, copy);
      copyPictures(copy, version, archive, staging);
      copy.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; UPDATE invitations SET revoked = 1 WHERE revoked = 0");
    }
    requireUnusedTarget(directory);
    renameSync(staging, directory);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
