import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RelayError } from "./config.ts";

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function scriptAccess(db: DatabaseSync) {
  const state = db.prepare("SELECT status FROM scripts WHERE name = ?");
  const match = db.prepare("SELECT id, revoked FROM invitations WHERE token_hash = ? AND script = ?");
  const valid = db.prepare(`SELECT 1 FROM invitations JOIN scripts ON scripts.name = invitations.script
    WHERE invitations.id = ? AND revoked = 0 AND status = 'active'`);
  const register = db.prepare("INSERT INTO scripts VALUES (?, ?)");
  const issue = db.prepare("INSERT INTO invitations (id, script, label, token_hash) VALUES (?, ?, ?, ?)");
  const revoke = db.prepare("UPDATE invitations SET revoked = 1 WHERE id = ?");
  const remove = db.prepare("UPDATE scripts SET status = 'deleted' WHERE name = ?");
  return {
    register(name: string, status: "pending" | "active"): void {
      register.run(name, status);
    },
    authenticate(name: string, token: string): string {
      const status = state.get(name)?.status;
      if (status !== "active") {
        throw { reason: status === "pending" ? "script-pending" : status === "deleted" ? "script-deleted" : "script-unknown" };
      }
      const invitation = match.get(tokenHash(token), name);
      if (!invitation) throw { reason: "permission-denied" };
      if (invitation.revoked) throw { reason: "invitation-revoked" };
      return String(invitation.id);
    },
    isValid(id: string): boolean {
      return valid.get(id) !== undefined;
    },
    issue(name: string, label: string) {
      if (state.get(name)?.status !== "active") throw new RelayError("Script is not active.");
      const id = randomUUID();
      const token = randomBytes(32).toString("base64url");
      issue.run(id, name, label, tokenHash(token));
      return { id, token };
    },
    revoke(id: string): void {
      revoke.run(id);
    },
    deleteScript(name: string): void {
      remove.run(name);
    }
  };
}
