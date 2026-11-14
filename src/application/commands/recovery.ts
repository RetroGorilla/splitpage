import type { Command } from "../session/document-session.ts";
import type { SharedDocumentSession } from "../session/shared-session.ts";
import { WHOLE_DOCUMENT } from "../session/change-set.ts";
import type { SharedRecoveryName, SharedRestore, SharedOperation } from "../../core/collab/operations.ts";
import { sharedRecoveryDiscardOperation, sharedRecoveryEntryName, sharedRecoveryPersonRestore } from "../../core/collab/recovery.ts";
import { readSharedContentRef } from "../../core/collab/read-operation.ts";

export interface SharedRecoveryCommandPorts {
  readonly recovery: Pick<SharedDocumentSession, "recovery">;
  readonly author: () => Pick<SharedRestore, "id" | "by"> | null;
}

export function recoveryCommand(action: "restore" | "discard", name: SharedRecoveryName, ports: SharedRecoveryCommandPorts): Command {
  return { name: "recovery-" + action, needs: "edit", plan: doc => {
    const entry = ports.recovery.recovery().find(item => { const key = sharedRecoveryEntryName(item); return key.kind === name.kind && key.key === name.key; });
    if (!entry) return { refused: "recovery-entry-unavailable" };
    const removed = entry.kind === "removed-beat" || entry.kind === "removed-heading";
    const removals = removed ? entry.removal?.ids.map(readSharedContentRef) : null;
    if (removed && (!removals?.length || removals.some(id => id === null))) return { refused: "recovery-removal-unavailable" };
    const author = ports.author();
    if (!author) return { refused: "recovery-no-author" };
    let operation: SharedOperation | null = null;
    if (action === "discard") operation = sharedRecoveryDiscardOperation(entry, author);
    else if (entry.kind === "deleted-person") operation = sharedRecoveryPersonRestore(entry, doc.people, author);
    else if (removed) operation = { kind: "restore", ...author, removals: removals!.filter(id => id !== null) };
    if (!operation) return { refused: "recovery-" + action + "-unavailable" };
    return { changes: WHOLE_DOCUMENT, apply: () => { throw new Error("recovery-shared-only"); },
      shared: { operations: [operation], description: { label: "recovery-" + action, selection: null, typing: null } } };
  } };
}
