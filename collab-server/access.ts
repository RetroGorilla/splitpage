import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { RelayError } from "./config.ts";
import { MAX_DEVICE_CREDENTIALS_PER_SCRIPT } from "./storage.ts";

export type InvitationRole = "owner" | "guest";
type InvitationKind = "invitation" | "link" | "device";
type LinkPasswordKey = { salt: Uint8Array; key: Uint8Array };
const deriveKey = promisify(scrypt);

export interface IssuedInvitation {
  readonly id: string;
  readonly token: string;
  readonly role: InvitationRole;
}

export interface CreatedScript {
  readonly scriptId: string;
  readonly owner?: IssuedInvitation;
  readonly guest?: IssuedInvitation;
  readonly passwordRequired?: true;
}

export interface ScriptSummary {
  readonly id: string;
  readonly status: "pending" | "active" | "deleted";
  readonly untouched: boolean;
}

export interface AuthenticatedInvitation {
  readonly id: string;
  readonly role: InvitationRole;
  readonly parentLinkId?: string;
}

export interface CreationRecord {
  readonly script: string;
  readonly contentHash: Uint8Array | null;
}

export type AbandonResult = "deleted" | "not-found" | "refused";
export type OwnerAuthResult = "allowed" | "already-deleted" | "unknown" | "forbidden" | "inactive";

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function hashesMatch(stored: unknown, candidate: Uint8Array): boolean {
  return stored instanceof Uint8Array && Buffer.compare(stored, candidate) === 0;
}

export function scriptAccess(db: DatabaseSync, isConnected: (id: string) => boolean = () => false) {
  const state = db.prepare("SELECT status, untouched FROM scripts WHERE name = ?");
  const match = db.prepare("SELECT id, revoked, role, kind, revocation_reason, parent_link FROM invitations WHERE token_hash = ? AND script = ?");
  const connection = db.prepare(`SELECT status, revoked, kind, revocation_reason, link_passwords.script AS protected
    FROM invitations JOIN scripts ON scripts.name = invitations.script
    LEFT JOIN link_passwords ON link_passwords.script = scripts.name WHERE invitations.id = ?`);
  const password = db.prepare("SELECT salt, key FROM link_passwords WHERE script = ?");
  const writePassword = db.prepare(`INSERT INTO link_passwords(script, salt, key) VALUES (?, ?, ?)
    ON CONFLICT(script) DO UPDATE SET salt = excluded.salt, key = excluded.key`);
  const erasePassword = db.prepare("DELETE FROM link_passwords WHERE script = ?");
  const register = db.prepare("INSERT INTO scripts (name, status, untouched) VALUES (?, ?, ?)");
  const issueRow = db.prepare(`INSERT INTO invitations (id, script, label, token_hash, role, creation_id, kind, parent_link)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const revoke = db.prepare(`UPDATE invitations SET revoked = 1,
    revocation_reason = CASE WHEN kind = 'device' THEN 'access-removed' END
    WHERE id = ? OR parent_link = ?`);
  const revokeCreation = db.prepare("UPDATE invitations SET revoked = 1 WHERE script = ? AND creation_id = ? AND revoked = 0");
  const revokeGuests = db.prepare(`UPDATE invitations SET revoked = 1,
    revocation_reason = CASE WHEN kind IN ('link', 'device') THEN 'access-removed' ELSE NULL END
    WHERE script = ? AND role = 'guest' AND (revoked = 0 OR revocation_reason = 'password-changed')`);
  const revokeDevices = db.prepare(`UPDATE invitations SET revoked = 1, revocation_reason = 'password-changed'
    WHERE script = ? AND kind = 'device' AND revoked = 0`);
  const deviceRows = db.prepare(`SELECT id FROM invitations WHERE script = ? AND kind = 'device'
    ORDER BY CASE WHEN revoked = 0 THEN 2 WHEN revocation_reason = 'password-changed' THEN 1 ELSE 0 END, rowid`);
  const pruneDevice = db.prepare("DELETE FROM invitations WHERE id = ? AND kind = 'device'");
  const revokeAll = db.prepare("UPDATE invitations SET revoked = 1 WHERE script = ? AND revoked = 0");
  const clearUntouched = db.prepare("UPDATE scripts SET untouched = 0 WHERE name = ? AND untouched = 1");
  const remove = db.prepare("UPDATE scripts SET status = 'deleted', untouched = 0 WHERE name = ?");
  const removeUntouched = db.prepare("UPDATE scripts SET status = 'deleted', untouched = 0 WHERE name = ? AND status = 'active' AND untouched = 1");
  const removeDocument = db.prepare("DELETE FROM documents WHERE name = ?");
  const retireVersions = db.prepare("UPDATE versions SET status = 'retired' WHERE script = ? AND status <> 'retired'");
  const creation = db.prepare(`SELECT c.script, c.content_hash, s.status, s.untouched
    FROM creations c JOIN scripts s ON s.name = c.script WHERE c.id = ?`);
  const recordCreation = db.prepare("INSERT INTO creations (id, script, content_hash) VALUES (?, ?, ?)");
  const initialize = db.prepare("INSERT INTO documents (name, state, version_generation) VALUES (?, ?, 1)");
  const activate = db.prepare("UPDATE scripts SET status = 'active' WHERE name = ?");
  const list = db.prepare("SELECT id, label, role, revoked FROM invitations WHERE script = ? ORDER BY id");
  const listScriptsQuery = db.prepare("SELECT name, status, untouched FROM scripts ORDER BY name");

  function mintInvitation(name: string, label: string, role: InvitationRole, creationId: string | null,
    kind: InvitationKind = "invitation", parentLink: string | null = null): IssuedInvitation {
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    issueRow.run(id, name, label, tokenHash(token), role, creationId, kind, parentLink);
    return { id, token, role };
  }

  function findCreation(creationId: string): CreationRecord | undefined {
    const row = creation.get(creationId);
    if (!row || typeof row.script !== "string") return undefined;
    return {
      script: row.script,
      contentHash: row.content_hash instanceof Uint8Array ? row.content_hash : null
    };
  }

  function readPassword(name: string): LinkPasswordKey | undefined {
    const row = password.get(name);
    if (row?.salt instanceof Uint8Array && row.key instanceof Uint8Array) return { salt: row.salt, key: row.key };
    return undefined;
  }

  async function passwordKey(value: string, salt: Uint8Array): Promise<Uint8Array> {
    return await deriveKey(value, salt, 32) as Buffer;
  }

  function refusal(id: string): "access-removed" | "password-changed" | null {
    const row = connection.get(id);
    if (!row || row.status !== "active") return "access-removed";
    if (row.revoked) return row.revocation_reason === "password-changed" ? "password-changed" : "access-removed";
    return row.kind === "link" && row.protected ? "password-changed" : null;
  }

  function activeLinkId(name: string, token: string): string | null {
    const invitation = match.get(tokenHash(token), name);
    return invitation?.kind === "link" && invitation.revoked === 0 && state.get(name)?.status === "active"
      ? String(invitation.id) : null;
  }

  return {
    findCreation,
    async create(creationId: string, bytes: Uint8Array, contentHash: Uint8Array, value?: string): Promise<CreatedScript> {
      const known = findCreation(creationId);
      let salt = (known && readPassword(known.script)?.salt) ?? randomBytes(32);
      let key = value === undefined ? undefined : await passwordKey(value, salt);
      if (value !== undefined && !known) {
        const concurrent = findCreation(creationId);
        const saved = concurrent && readPassword(concurrent.script);
        if (saved) {
          salt = saved.salt;
          key = await passwordKey(value, salt);
        }
      }
      const name = randomUUID();
      let result: CreatedScript | undefined;
      let conflict = false;
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = creation.get(creationId);
        if (existing && typeof existing.script === "string") {
          const stored = readPassword(existing.script);
          const samePassword = stored && key ? timingSafeEqual(stored.key, key) : !stored && !key;
          if (!hashesMatch(existing.content_hash, contentHash) || !samePassword) {
            conflict = true;
          } else if (existing.status === "active" && existing.untouched === 1) {
            revokeCreation.run(existing.script, creationId);
            const owner = mintInvitation(existing.script, "Owner", "owner", creationId);
            const guest = mintInvitation(existing.script, "Guest", "guest", creationId, "link");
            result = { scriptId: existing.script, owner, guest, ...(stored && { passwordRequired: true }) };
          } else {
            result = { scriptId: existing.script };
          }
          db.exec("COMMIT");
        } else {
          register.run(name, "pending", 1);
          recordCreation.run(creationId, name, contentHash);
          initialize.run(name, bytes);
          if (key) writePassword.run(name, salt, key);
          activate.run(name);
          const owner = mintInvitation(name, "Owner", "owner", creationId);
          const guest = mintInvitation(name, "Guest", "guest", creationId, "link");
          db.exec("COMMIT");
          result = { scriptId: name, owner, guest, ...(key && { passwordRequired: true }) };
        }
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      if (conflict || !result) throw new RelayError("Creation id was already used with different content.");
      return result;
    },
    abandon(creationId: string): AbandonResult {
      let outcome: AbandonResult;
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = creation.get(creationId);
        if (!row || typeof row.script !== "string") {
          outcome = "not-found";
        } else if (row.status !== "active" || row.untouched !== 1) {
          outcome = "refused";
        } else {
          removeUntouched.run(row.script);
          erasePassword.run(row.script);
          revokeAll.run(row.script);
          removeDocument.run(row.script);
          retireVersions.run(row.script);
          outcome = "deleted";
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return outcome;
    },
    listScripts(): ScriptSummary[] {
      return listScriptsQuery.all().map(({ name, status, untouched }) => ({
        id: String(name),
        status: status as ScriptSummary["status"],
        untouched: untouched === 1
      }));
    },
    list(name: string) {
      if (!state.get(name)) return undefined;
      return list.all(name).map(({ id, label, role, revoked }) => ({
        id: String(id),
        label: String(label),
        role: role as InvitationRole,
        state: revoked ? "revoked" : "active"
      }));
    },
    register(name: string, status: "pending" | "active"): void {
      register.run(name, status, 0);
    },
    authenticate(name: string, token: string): AuthenticatedInvitation {
      let result: AuthenticatedInvitation | undefined;
      let failure: { reason: string } | undefined;
      db.exec("BEGIN IMMEDIATE");
      try {
        const status = state.get(name)?.status;
        if (status !== "active") {
          failure = { reason: status === "pending" ? "script-pending" : status === "deleted" ? "script-deleted" : "script-unknown" };
        } else {
          const invitation = match.get(tokenHash(token), name);
          if (!invitation) failure = { reason: "permission-denied" };
          else if (invitation.revoked) failure = { reason: String(invitation.revocation_reason ?? "invitation-revoked") };
          else if (invitation.kind === "link" && password.get(name)) failure = { reason: "password-changed" };
          else {
            clearUntouched.run(name);
            result = {
              id: String(invitation.id), role: invitation.role as InvitationRole,
              ...(typeof invitation.parent_link === "string" && { parentLinkId: invitation.parent_link })
            };
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      if (failure || !result) throw failure ?? { reason: "permission-denied" };
      return result;
    },
    authorizeOwner(name: string, token: string, allowDeleted: boolean): OwnerAuthResult {
      let outcome: OwnerAuthResult;
      db.exec("BEGIN IMMEDIATE");
      try {
        const invitation = match.get(tokenHash(token), name);
        if (!invitation) {
          outcome = "unknown";
        } else if (invitation.revoked) {
          outcome = "forbidden";
        } else {
          const status = state.get(name)?.status;
          if (status === "active") {
            if (invitation.role === "owner") {
              clearUntouched.run(name);
              outcome = "allowed";
            } else {
              outcome = "forbidden";
            }
          } else if (invitation.role !== "owner") {
            outcome = "forbidden";
          } else if (allowDeleted && status === "deleted") {
            outcome = "already-deleted";
          } else {
            outcome = "inactive";
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return outcome;
    },
    refusal,
    isValid(id: string): boolean {
      return refusal(id) === null;
    },
    activeLink(name: string, token: string): boolean {
      return activeLinkId(name, token) !== null;
    },
    hasPassword(name: string): boolean {
      return password.get(name) !== undefined;
    },
    async exchange(name: string, token: string, value: string, stored: LinkPasswordKey) {
      const key = await passwordKey(value, stored.salt);
      db.exec("BEGIN IMMEDIATE");
      try {
        const parent = activeLinkId(name, token);
        const samePassword = parent && hashesMatch(readPassword(name)?.salt, stored.salt);
        if (!samePassword || !timingSafeEqual(stored.key, key)) {
          db.exec("COMMIT");
          return { kind: parent ? samePassword ? "wrong-password" : "stale-password" : "invalid-link" } as const;
        }
        const devices = deviceRows.all(name);
        const excess = devices.length - MAX_DEVICE_CREDENTIALS_PER_SCRIPT + 1;
        if (excess > 0) {
          const evictable = devices.map(row => String(row.id)).filter(id => !isConnected(id)).slice(0, excess);
          if (evictable.length < excess) {
            db.exec("COMMIT");
            return { kind: "device-limit" } as const;
          }
          for (const id of evictable) pruneDevice.run(id);
        }
        clearUntouched.run(name);
        const device = mintInvitation(name, "Guest device", "guest", null, "device", parent);
        db.exec("COMMIT");
        return { kind: "exchanged", token: device.token } as const;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    readPassword,
    async changePassword(name: string, token: string | null, value: string | null): Promise<boolean> {
      const salt = randomBytes(32);
      const key = value === null ? null : await passwordKey(value, salt);
      db.exec("BEGIN IMMEDIATE");
      try {
        const invitation = token === null ? null : match.get(tokenHash(token), name);
        const allowed = state.get(name)?.status === "active"
          && (token === null || (invitation?.role === "owner" && !invitation.revoked));
        if (allowed) {
          if (key) writePassword.run(name, salt, key);
          else erasePassword.run(name);
          revokeDevices.run(name);
          clearUntouched.run(name);
        }
        db.exec("COMMIT");
        return allowed;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    issue(name: string, label: string, role: InvitationRole): IssuedInvitation {
      let issued: IssuedInvitation | undefined;
      let inactive = false;
      db.exec("BEGIN IMMEDIATE");
      try {
        if (state.get(name)?.status !== "active") {
          inactive = true;
        } else {
          clearUntouched.run(name);
          issued = mintInvitation(name, label, role, null);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      if (inactive || !issued) throw new RelayError("Script is not active.");
      return issued;
    },
    resetGuests(name: string): IssuedInvitation | undefined {
      let issued: IssuedInvitation | undefined;
      let inactive = false;
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = state.get(name);
        if (row) {
          if (row.status !== "active") {
            inactive = true;
          } else {
            revokeGuests.run(name);
            clearUntouched.run(name);
            issued = mintInvitation(name, "Guest", "guest", null, "link");
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      if (inactive) throw new RelayError("Script is not active.");
      return issued;
    },
    revoke(id: string): boolean {
      return revoke.run(id, id).changes !== 0;
    },
    deleteScript(name: string): boolean {
      db.exec("BEGIN IMMEDIATE");
      try {
        const deleted = remove.run(name).changes !== 0;
        if (deleted) {
          erasePassword.run(name);
          retireVersions.run(name);
        }
        db.exec("COMMIT");
        return deleted;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  };
}
