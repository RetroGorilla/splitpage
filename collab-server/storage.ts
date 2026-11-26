import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RelayError } from "./config.ts";

export const DB_NAME = "relay.sqlite";
export const BACKUP_LOCK_NAME = "relay-backup-lock.sqlite";
const APPLICATION_ID = 0x53504c54;
const STORAGE_VERSION = 9;
export const MAX_DEVICE_CREDENTIALS_PER_SCRIPT = 96;
const DOCUMENTS_SCHEMA = "CREATE TABLE documents (name TEXT PRIMARY KEY NOT NULL, state BLOB NOT NULL) STRICT";
const VERSION_GENERATION = "version_generation INTEGER NOT NULL DEFAULT 0 CHECK (version_generation >= 0)";
const V5_DOCUMENTS_SCHEMA = `CREATE TABLE documents (name TEXT PRIMARY KEY NOT NULL, state BLOB NOT NULL, ${VERSION_GENERATION}) STRICT`;
const V1_SCRIPTS_SCHEMA = "CREATE TABLE scripts (name TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'deleted'))) STRICT";
const V4_SCRIPTS_SCHEMA = "CREATE TABLE scripts (name TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'deleted')), untouched INTEGER NOT NULL DEFAULT 0 CHECK (untouched IN (0, 1))) STRICT";
const V1_INVITATIONS_SCHEMA = "CREATE TABLE invitations (id TEXT PRIMARY KEY NOT NULL, script TEXT NOT NULL REFERENCES scripts(name), label TEXT NOT NULL, token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32), revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))) STRICT";
const V4_INVITATIONS_SCHEMA = "CREATE TABLE invitations (id TEXT PRIMARY KEY NOT NULL, script TEXT NOT NULL REFERENCES scripts(name), label TEXT NOT NULL, token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32), revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)), role TEXT NOT NULL DEFAULT 'guest' CHECK (role IN ('owner', 'guest')), creation_id TEXT REFERENCES creations(id)) STRICT";
const V2_CREATIONS_SCHEMA = "CREATE TABLE creations (id TEXT PRIMARY KEY NOT NULL, script TEXT NOT NULL UNIQUE REFERENCES scripts(name)) STRICT";
const V4_CREATIONS_SCHEMA = "CREATE TABLE creations (id TEXT PRIMARY KEY NOT NULL, script TEXT NOT NULL UNIQUE REFERENCES scripts(name), content_hash BLOB CHECK (content_hash IS NULL OR length(content_hash) = 32)) STRICT";
const PICTURE_SCHEMA = "CREATE TABLE script_pictures (script TEXT NOT NULL REFERENCES scripts(name), sha TEXT NOT NULL, bytes INTEGER NOT NULL, mime TEXT NOT NULL, PRIMARY KEY (script, sha)) STRICT";
const CREATE_PICTURES = PICTURE_SCHEMA + "; CREATE INDEX script_pictures_sha ON script_pictures(sha)";
const V1_SCHEMAS = { documents: DOCUMENTS_SCHEMA, scripts: V1_SCRIPTS_SCHEMA, invitations: V1_INVITATIONS_SCHEMA };
const V2_SCHEMAS = { ...V1_SCHEMAS, creations: V2_CREATIONS_SCHEMA };
const V3_SCHEMAS = { ...V2_SCHEMAS, script_pictures: PICTURE_SCHEMA };
const V4_SCHEMAS = {
  documents: DOCUMENTS_SCHEMA,
  scripts: V4_SCRIPTS_SCHEMA,
  invitations: V4_INVITATIONS_SCHEMA,
  creations: V4_CREATIONS_SCHEMA,
  script_pictures: PICTURE_SCHEMA
};
export const VERSION_CHUNK_BYTES = 512 * 1024;
const VERSIONS_SCHEMA = "CREATE TABLE versions (id TEXT PRIMARY KEY NOT NULL, script TEXT NOT NULL REFERENCES scripts(name), generation INTEGER NOT NULL CHECK (generation > 0), created_at INTEGER NOT NULL, bytes INTEGER NOT NULL CHECK (bytes > 0), content_hash BLOB NOT NULL CHECK (length(content_hash) = 32), names TEXT NOT NULL DEFAULT '[]' CHECK (json_type(names) = 'array'), status TEXT NOT NULL CHECK (status IN ('staged', 'published', 'retired'))) STRICT";
const VERSION_CHUNKS_SCHEMA = `CREATE TABLE version_chunks (version_id TEXT NOT NULL REFERENCES versions(id), part INTEGER NOT NULL CHECK (part >= 0), payload BLOB NOT NULL CHECK (length(payload) BETWEEN 1 AND ${VERSION_CHUNK_BYTES}), PRIMARY KEY (version_id, part)) STRICT`;
const CREATE_VERSIONS = VERSIONS_SCHEMA + "; " + VERSION_CHUNKS_SCHEMA +
  "; CREATE INDEX published_versions ON versions(script, created_at DESC, id DESC) WHERE status = 'published'" +
  "; CREATE INDEX unpublished_versions ON versions(id) WHERE status <> 'published'";
const V5_SCHEMAS = { ...V4_SCHEMAS, documents: V5_DOCUMENTS_SCHEMA, versions: VERSIONS_SCHEMA, version_chunks: VERSION_CHUNKS_SCHEMA };
const PASSWORD_SCHEMA = "CREATE TABLE link_passwords (script TEXT PRIMARY KEY NOT NULL REFERENCES scripts(name), salt BLOB NOT NULL CHECK (length(salt) = 32), key BLOB NOT NULL CHECK (length(key) = 32)) STRICT";
const INVITATION_KIND = "kind TEXT NOT NULL DEFAULT 'invitation' CHECK (kind IN ('invitation', 'link', 'device'))";
const REVOCATION_REASON = "revocation_reason TEXT CHECK (revocation_reason IN ('password-changed', 'access-removed'))";
const V6_INVITATIONS_SCHEMA = V4_INVITATIONS_SCHEMA.replace(") STRICT", `, ${INVITATION_KIND}, ${REVOCATION_REASON}) STRICT`);
const V6_SCHEMAS = { ...V5_SCHEMAS, invitations: V6_INVITATIONS_SCHEMA, link_passwords: PASSWORD_SCHEMA };
const PARENT_LINK = "parent_link TEXT REFERENCES invitations(id)";
const V7_INVITATIONS_SCHEMA = V6_INVITATIONS_SCHEMA.replace(") STRICT", `, ${PARENT_LINK}) STRICT`);
const DEVICE_INDEX = "CREATE INDEX script_device_credentials ON invitations(script) WHERE kind = 'device'";
const V7_SCHEMAS = { ...V6_SCHEMAS, invitations: V7_INVITATIONS_SCHEMA };
const VERSION_EDITORS_SCHEMA = "CREATE TABLE version_editors (script TEXT NOT NULL REFERENCES documents(name) ON DELETE CASCADE, name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80), generation INTEGER NOT NULL CHECK (generation > 0), PRIMARY KEY (script, name)) STRICT";
const V8_SCHEMAS = { ...V7_SCHEMAS, version_editors: VERSION_EDITORS_SCHEMA };
const DEVICE_REVOCATIONS_SCHEMA = "CREATE TABLE device_revocations (token_hash BLOB PRIMARY KEY NOT NULL CHECK (length(token_hash) = 32), parent_link TEXT NOT NULL REFERENCES invitations(id)) STRICT";
const CREATE_DEVICE_REVOCATIONS = DEVICE_REVOCATIONS_SCHEMA + "; CREATE INDEX device_revocations_link ON device_revocations(parent_link)";
const CURRENT_SCHEMAS = { ...V8_SCHEMAS, device_revocations: DEVICE_REVOCATIONS_SCHEMA };

function schemasFor(version: number): Record<string, string> | undefined {
  if (version === 1) return V1_SCHEMAS;
  if (version === 2) return V2_SCHEMAS;
  if (version === 3) return V3_SCHEMAS;
  if (version === 4) return V4_SCHEMAS;
  if (version === 5) return V5_SCHEMAS;
  if (version === 6) return V6_SCHEMAS;
  if (version === 7) return V7_SCHEMAS;
  if (version === 8) return V8_SCHEMAS;
  if (version === STORAGE_VERSION) return CURRENT_SCHEMAS;
  return undefined;
}

function backfillCreationHashes(db: DatabaseSync): void {
  const rows = db.prepare("SELECT c.id, d.state FROM creations c JOIN documents d ON d.name = c.script").all();
  const update = db.prepare("UPDATE creations SET content_hash = ? WHERE id = ?");
  for (const row of rows) {
    if (typeof row.id === "string" && row.state instanceof Uint8Array) {
      update.run(createHash("sha256").update(row.state).digest(), row.id);
    }
  }
}

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
  const schemas = schemasFor(version);
  if (db.prepare("PRAGMA application_id").get()?.application_id !== APPLICATION_ID ||
      !schemas ||
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
    if (created) {
      db.exec(`BEGIN; PRAGMA application_id=${APPLICATION_ID}; ${V5_DOCUMENTS_SCHEMA}; ${V4_SCRIPTS_SCHEMA}; ${V4_CREATIONS_SCHEMA}; ${V7_INVITATIONS_SCHEMA}; ${CREATE_PICTURES}; ${CREATE_VERSIONS}; ${PASSWORD_SCHEMA}; ${DEVICE_INDEX}; ${VERSION_EDITORS_SCHEMA}; ${CREATE_DEVICE_REVOCATIONS}; PRAGMA user_version=${STORAGE_VERSION}; COMMIT`);
    } else if (version < STORAGE_VERSION) {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (version < 4) {
          if (version === 1) db.exec(V4_CREATIONS_SCHEMA);
          if (version < 3) db.exec(CREATE_PICTURES);
          db.exec("ALTER TABLE scripts ADD COLUMN untouched INTEGER NOT NULL DEFAULT 0 CHECK (untouched IN (0, 1))");
          if (version >= 2) {
            db.exec("ALTER TABLE creations ADD COLUMN content_hash BLOB CHECK (content_hash IS NULL OR length(content_hash) = 32)");
            backfillCreationHashes(db);
          }
          db.exec("ALTER TABLE invitations ADD COLUMN role TEXT NOT NULL DEFAULT 'guest' CHECK (role IN ('owner', 'guest'))");
          db.exec("ALTER TABLE invitations ADD COLUMN creation_id TEXT REFERENCES creations(id)");
        }
        if (version < 5) db.exec(`ALTER TABLE documents ADD COLUMN ${VERSION_GENERATION}; ${CREATE_VERSIONS}`);
        if (version < 6) db.exec(`ALTER TABLE invitations ADD COLUMN ${INVITATION_KIND};
          ALTER TABLE invitations ADD COLUMN ${REVOCATION_REASON};
          UPDATE invitations SET kind = 'link' WHERE role = 'guest' AND label = 'Guest';
          ${PASSWORD_SCHEMA}`);
        if (version < 7) db.exec(`ALTER TABLE invitations ADD COLUMN ${PARENT_LINK}; ${DEVICE_INDEX}`);
        if (version === 6) {
          db.exec(`DELETE FROM invitations WHERE rowid IN (
            SELECT rowid FROM (
              SELECT rowid, row_number() OVER (PARTITION BY script ORDER BY revoked ASC, rowid DESC) AS position
              FROM invitations WHERE kind = 'device'
            ) WHERE position > ${MAX_DEVICE_CREDENTIALS_PER_SCRIPT}
          );
          UPDATE invitations AS device SET parent_link = (
            SELECT link.id FROM invitations AS link
            WHERE link.script = device.script AND link.kind = 'link' AND link.revoked = 0
            ORDER BY link.rowid DESC LIMIT 1
          ) WHERE device.kind = 'device' AND (device.revoked = 0 OR device.revocation_reason = 'password-changed');
          UPDATE invitations SET revoked = 1, revocation_reason = 'access-removed'
            WHERE kind = 'device' AND parent_link IS NULL AND (revoked = 0 OR revocation_reason = 'password-changed')`);
        }
        if (version < 8) db.exec(VERSION_EDITORS_SCHEMA);
        db.exec(`${CREATE_DEVICE_REVOCATIONS}; PRAGMA user_version=${STORAGE_VERSION}; COMMIT`);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    return db;
  } catch (error) {
    db?.close();
    if (error instanceof RelayError) throw error;
    throw new RelayError("Relay database could not be opened or initialized. Check its integrity and data volume permissions.");
  }
}
