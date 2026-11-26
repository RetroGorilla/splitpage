import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, copyFileSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";
import { isSha256Hex } from "../shared/blob-policy.ts";
import { dataDirectory, RelayError, retentionCount } from "./config.ts";
import { BACKUP_LOCK_NAME, DB_NAME, verifyDatabase } from "./storage.ts";

const BACKUP_NAME = /^relay-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z-[a-f0-9-]{36}\.(sqlite|backup)$/;
const LAST_BACKUP_FILE = "last-backup.json";
const ISO_TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function recordLastBackup(directory: string, completedAt: string, syncDirectory: ((path: string) => void) | null): void {
  const pending = join(directory, `.last-backup-${randomUUID()}.tmp`);
  try {
    const fd = openSync(pending, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify({ completedAt }) + "\n", undefined, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(pending, join(directory, LAST_BACKUP_FILE));
    syncDirectory?.(directory);
  } catch (error) {
    rmSync(pending, { force: true });
    throw error;
  }
}

export function lastBackupTime(directory: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(directory, LAST_BACKUP_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !("completedAt" in parsed)) return null;
  const { completedAt } = parsed as { completedAt: unknown };
  return typeof completedAt === "string" && ISO_TIMESTAMP.test(completedAt) ? completedAt : null;
}

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
  if (version >= 4) {
    verifyRows(source, copy, "creations", "SELECT id, script, content_hash FROM creations ORDER BY id");
  } else if (version >= 2) {
    verifyRows(source, copy, "creations", "SELECT id, script FROM creations ORDER BY id");
  }
  verifyRows(source, copy, "documents", version >= 5
    ? "SELECT name, state, version_generation FROM documents ORDER BY name"
    : "SELECT name, state FROM documents ORDER BY name");
  verifyRows(source, copy, "scripts", version >= 4
    ? "SELECT name, status, untouched FROM scripts ORDER BY name"
    : "SELECT name, status FROM scripts ORDER BY name");
  if (version >= 3) verifyRows(source, copy, "script pictures", "SELECT script, sha, bytes, mime FROM script_pictures ORDER BY script, sha");
  verifyRows(source, copy, "invitations", version >= 7
    ? "SELECT id, script, label, token_hash, revoked, role, creation_id, kind, revocation_reason, parent_link FROM invitations ORDER BY id"
    : version >= 6
    ? "SELECT id, script, label, token_hash, revoked, role, creation_id, kind, revocation_reason FROM invitations ORDER BY id"
    : version >= 4
    ? "SELECT id, script, label, token_hash, revoked, role, creation_id FROM invitations ORDER BY id"
    : "SELECT id, script, label, token_hash, revoked FROM invitations ORDER BY id");
  if (version >= 6) verifyRows(source, copy, "link passwords", "SELECT script, salt, key FROM link_passwords ORDER BY script");
  if (version >= 8) {
    verifyRows(source, copy, "pending version editors", "SELECT script, name, generation FROM version_editors ORDER BY script, name");
    if (copy.prepare("PRAGMA foreign_key_check(version_editors)").get()) {
      throw new RelayError("Relay backup contains an orphaned version editor.");
    }
  }
  if (version >= 5) {
    verifyRows(source, copy, "versions",
      "SELECT id, script, generation, created_at, bytes, content_hash, names, status FROM versions ORDER BY id");
    verifyRows(source, copy, "version chunks", "SELECT version_id, part, payload FROM version_chunks ORDER BY version_id, part");
    if (copy.prepare(`SELECT 1 FROM versions v LEFT JOIN version_chunks c ON c.version_id = v.id
      WHERE v.status = 'published' GROUP BY v.id
      HAVING coalesce(sum(length(c.payload)), 0) <> v.bytes OR min(c.part) <> 0 OR max(c.part) <> count(c.part) - 1
      LIMIT 1`).get()) throw new RelayError("Relay backup contains an incomplete published version.");
    if (copy.prepare("PRAGMA foreign_key_check(versions)").get() ||
        copy.prepare("PRAGMA foreign_key_check(version_chunks)").get()) {
      throw new RelayError("Relay backup contains an orphaned version or chunk.");
    }
  }
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
  using ownership = new DatabaseSync(join(directory, BACKUP_LOCK_NAME), { timeout: 1000 });
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
    if (!syncDirectory) {
      recordLastBackup(directory, new Date().toISOString(), null);
      return name;
    }
    try {
      syncDirectory(destination);
      syncDirectory(directory);
    } catch (error) {
      renameSync(published, staging);
      throw error;
    }
    recordLastBackup(directory, new Date().toISOString(), syncDirectory);
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
      if (version >= 6) copy.exec("UPDATE invitations SET revocation_reason = 'access-removed' WHERE revocation_reason = 'password-changed'");
    }
    requireUnusedTarget(directory);
    renameSync(staging, directory);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
