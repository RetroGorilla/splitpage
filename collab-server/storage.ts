import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RelayError } from "./config.ts";

export const DB_NAME = "relay.sqlite";
const APPLICATION_ID = 0x53504c54;
const STORAGE_VERSION = 2;
const CREATIONS = "CREATE TABLE creations (id TEXT PRIMARY KEY NOT NULL, script TEXT NOT NULL UNIQUE REFERENCES scripts(name)) STRICT";
const SCHEMAS = {
  documents: "CREATE TABLE documents (name TEXT PRIMARY KEY NOT NULL, state BLOB NOT NULL) STRICT",
  scripts: "CREATE TABLE scripts (name TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'deleted'))) STRICT",
  invitations: "CREATE TABLE invitations (id TEXT PRIMARY KEY NOT NULL, script TEXT NOT NULL REFERENCES scripts(name), label TEXT NOT NULL, token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32), revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))) STRICT"
};

export function claimWriter(directory: string): DatabaseSync {
  let lock: DatabaseSync | undefined;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    lock = new DatabaseSync(join(directory, "relay-writer.sqlite"));
    lock.exec("BEGIN EXCLUSIVE");
    return lock;
  } catch (error) {
    lock?.close();
    if ((error as { errcode?: number }).errcode === 5) {
      throw new RelayError("Another relay already owns this data directory.");
    }
    throw new RelayError("Relay could not acquire the writer lock. Check data volume permissions.");
  }
}

export function verifyDatabase(db: DatabaseSync): number {
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
  const schemas = version === 1 ? SCHEMAS : { ...SCHEMAS, creations: CREATIONS };
  if (db.prepare("PRAGMA application_id").get()?.application_id !== APPLICATION_ID ||
      (version !== 1 && version !== STORAGE_VERSION) ||
      Object.entries(schemas).some(([name, schema]) =>
        db.prepare("SELECT sql FROM sqlite_schema WHERE name = ? AND type = 'table'").get(name)?.sql !== schema)) {
    throw new RelayError("Relay database has an unrecognized identity or schema.");
  }
  if (db.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok") {
    throw new RelayError("Relay database failed its integrity check.");
  }
  return version;
}

export function verifyDurability(db: DatabaseSync): void {
  const journalMode = db.prepare("PRAGMA journal_mode").get()?.journal_mode;
  const synchronous = db.prepare("PRAGMA synchronous").get()?.synchronous;
  if (journalMode !== "wal" || synchronous !== 2) {
    throw new RelayError("Relay database requires WAL and synchronous=FULL.");
  }
}

function reserveDatabase(path: string): boolean {
  try {
    closeSync(openSync(path, "wx", 0o600));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export function openWriter(directory: string): DatabaseSync {
  let db: DatabaseSync | undefined;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, DB_NAME);
    const created = reserveDatabase(path);
    let version = STORAGE_VERSION;
    if (!created) {
      using existing = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
      version = verifyDatabase(existing);
    }
    db = new DatabaseSync(path, { timeout: 5000 });
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
    verifyDurability(db);
    if (created) db.exec(`BEGIN; PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${STORAGE_VERSION}; ${Object.values(SCHEMAS).join("; ")}; ${CREATIONS}; COMMIT`);
    if (version === 1) db.exec(`BEGIN; ${CREATIONS}; PRAGMA user_version=${STORAGE_VERSION}; COMMIT`);
    return db;
  } catch (error) {
    db?.close();
    if (error instanceof RelayError) throw error;
    throw new RelayError("Relay database could not be opened or initialized. Check its integrity and data volume permissions.");
  }
}
