import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RelayError } from "./config.ts";

export type InvitationRole = "owner" | "guest";

export interface IssuedInvitation {
  readonly id: string;
  readonly token: string;
  readonly role: InvitationRole;
}

export interface CreatedScript {
  readonly scriptId: string;
  readonly owner?: IssuedInvitation;
  readonly guest?: IssuedInvitation;
}

export interface ScriptSummary {
  readonly id: string;
  readonly status: "pending" | "active" | "deleted";
  readonly untouched: boolean;
}

export interface AuthenticatedInvitation {
  readonly id: string;
  readonly role: InvitationRole;
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

export function scriptAccess(db: DatabaseSync) {
  const state = db.prepare("SELECT status, untouched FROM scripts WHERE name = ?");
  const match = db.prepare("SELECT id, revoked, role FROM invitations WHERE token_hash = ? AND script = ?");
  const valid = db.prepare(`SELECT 1 FROM invitations JOIN scripts ON scripts.name = invitations.script
    WHERE invitations.id = ? AND revoked = 0 AND status = 'active'`);
  const register = db.prepare("INSERT INTO scripts (name, status, untouched) VALUES (?, ?, ?)");
  const issueRow = db.prepare("INSERT INTO invitations (id, script, label, token_hash, role, creation_id) VALUES (?, ?, ?, ?, ?, ?)");
  const revoke = db.prepare("UPDATE invitations SET revoked = 1 WHERE id = ?");
  const revokeCreation = db.prepare("UPDATE invitations SET revoked = 1 WHERE script = ? AND creation_id = ? AND revoked = 0");
  const revokeGuests = db.prepare("UPDATE invitations SET revoked = 1 WHERE script = ? AND role = 'guest' AND revoked = 0");
  const revokeAll = db.prepare("UPDATE invitations SET revoked = 1 WHERE script = ? AND revoked = 0");
  const clearUntouched = db.prepare("UPDATE scripts SET untouched = 0 WHERE name = ? AND untouched = 1");
  const remove = db.prepare("UPDATE scripts SET status = 'deleted', untouched = 0 WHERE name = ?");
  const removeUntouched = db.prepare("UPDATE scripts SET status = 'deleted', untouched = 0 WHERE name = ? AND status = 'active' AND untouched = 1");
  const removeDocument = db.prepare("DELETE FROM documents WHERE name = ?");
  const creation = db.prepare(`SELECT c.script, c.content_hash, s.status, s.untouched
    FROM creations c JOIN scripts s ON s.name = c.script WHERE c.id = ?`);
  const recordCreation = db.prepare("INSERT INTO creations (id, script, content_hash) VALUES (?, ?, ?)");
  const initialize = db.prepare("INSERT INTO documents (name, state, version_generation) VALUES (?, ?, 1)");
  const activate = db.prepare("UPDATE scripts SET status = 'active' WHERE name = ?");
  const list = db.prepare("SELECT id, label, role, revoked FROM invitations WHERE script = ? ORDER BY id");
  const listScriptsQuery = db.prepare("SELECT name, status, untouched FROM scripts ORDER BY name");

  function mintInvitation(name: string, label: string, role: InvitationRole, creationId: string | null): IssuedInvitation {
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    issueRow.run(id, name, label, tokenHash(token), role, creationId);
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

  return {
    findCreation,
    create(creationId: string, bytes: Uint8Array, contentHash: Uint8Array): CreatedScript {
      const name = randomUUID();
      let result: CreatedScript | undefined;
      let conflict = false;
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = creation.get(creationId);
        if (existing && typeof existing.script === "string") {
          if (!hashesMatch(existing.content_hash, contentHash)) {
            conflict = true;
          } else if (existing.status === "active" && existing.untouched === 1) {
            revokeCreation.run(existing.script, creationId);
            const owner = mintInvitation(existing.script, "Owner", "owner", creationId);
            const guest = mintInvitation(existing.script, "Guest", "guest", creationId);
            result = { scriptId: existing.script, owner, guest };
          } else {
            result = { scriptId: existing.script };
          }
          db.exec("COMMIT");
        } else {
          register.run(name, "pending", 1);
          recordCreation.run(creationId, name, contentHash);
          initialize.run(name, bytes);
          activate.run(name);
          const owner = mintInvitation(name, "Owner", "owner", creationId);
          const guest = mintInvitation(name, "Guest", "guest", creationId);
          db.exec("COMMIT");
          result = { scriptId: name, owner, guest };
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
          revokeAll.run(row.script);
          removeDocument.run(row.script);
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
          else if (invitation.revoked) failure = { reason: "invitation-revoked" };
          else {
            clearUntouched.run(name);
            result = { id: String(invitation.id), role: invitation.role as InvitationRole };
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
    isValid(id: string): boolean {
      return valid.get(id) !== undefined;
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
            issued = mintInvitation(name, "Guest", "guest", null);
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
      return revoke.run(id).changes !== 0;
    },
    deleteScript(name: string): boolean {
      return remove.run(name).changes !== 0;
    }
  };
}
