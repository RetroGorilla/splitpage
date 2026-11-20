import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RelayError } from "./config.ts";

export const DB_NAME = "relay.sqlite";
const APPLICATION_ID = 0x53504c54;
const SCHEMA = "CREATE TABLE documents (name TEXT PRIMARY KEY NOT NULL, state BLOB NOT NULL) STRICT";

export function verifyDatabase(db: DatabaseSync): void {
  if (db.prepare("PRAGMA application_id").get()?.application_id !== APPLICATION_ID ||
      db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'documents' AND type = 'table'").get()?.sql !== SCHEMA) {
    throw new RelayError("Relay database has an unrecognized identity or schema.");
  }
  if (db.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok") {
    throw new RelayError("Relay database failed its integrity check.");
  }
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
    if (!created) {
      using existing = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
      verifyDatabase(existing);
    }
    db = new DatabaseSync(path, { timeout: 5000 });
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
    verifyDurability(db);
    if (created) db.exec(`BEGIN; PRAGMA application_id=${APPLICATION_ID}; ${SCHEMA}; COMMIT`);
    return db;
  } catch (error) {
    db?.close();
    if (error instanceof RelayError) throw error;
    throw new RelayError("Relay database could not be opened or initialized. Check its integrity and data volume permissions.");
  }
}
