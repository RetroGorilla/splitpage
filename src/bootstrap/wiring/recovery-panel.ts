import { recoveryCommand } from "../../application/commands/recovery.ts";
import { readSharedContentRef } from "../../core/collab/read-operation.ts";
import type { SharedRecoveryName } from "../../core/collab/operations.ts";
import { readSharedRecords } from "../../adapters/collab/record-reader.ts";
import { createRecoveryPanel } from "../../features/recovery-panel/mount.ts";
import { startRecoveryPanelActions } from "../../features/recovery-panel/actions.ts";
import type { ActionRegistry } from "../../application/actions.ts";
import type { RecoveryPanelControl, RecoveryPanelPorts } from "../../features/recovery-panel/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { onDocumentReplaced, runCommand, sharedRecoverySession } from "./session-owner.ts";
import { sharedSessionParts } from "./shared-session.ts";
import { documentReader } from "./ports/document.ts";
import { notices } from "./ports/effects.ts";
import { text } from "./ports/text.ts";

declare const SPLITPAGE_TEST_HOOKS: boolean | undefined;

const mount = typeof SPLITPAGE_TEST_HOOKS === "undefined" || SPLITPAGE_TEST_HOOKS ? createRecoveryPanel : null;
const actions = typeof SPLITPAGE_TEST_HOOKS === "undefined" || SPLITPAGE_TEST_HOOKS ? startRecoveryPanelActions : null;
const panel = owned<RecoveryPanelControl>();
const session: RecoveryPanelPorts["session"] = { current: sharedRecoverySession, onChange: onDocumentReplaced };

function change(action: "restore" | "discard", entry: SharedRecoveryName) {
  const reader = sharedRecoverySession();
  if (!reader) return { kind: "rejected" as const, reason: "recovery-no-session" };
  return runCommand(recoveryCommand(action, entry, { recovery: reader, author: () => {
    const author = sharedSessionParts()?.author.next(), id = author && readSharedContentRef(author.id);
    return author && id ? { id, by: author.by } : null;
  } }));
}

export function mountRecoveryPanelFeature(): RecoveryPanelControl {
  return panel.replace(() => mount ? mount({ host: document.body, session, document: documentReader, text, notices,
    reply: key => { const parts = sharedSessionParts(); return parts ? readSharedRecords(parts.handle, "replies").find(reply => reply.key === key)?.fields ?? null : null; },
    restore: entry => change("restore", entry), discard: entry => change("discard", entry)
  }) : { open: () => {}, dispose: () => {} });
}

export const stopRecoveryPanelFeature = panel.stop;
export const registerRecoveryPanelActions = (registry: Pick<ActionRegistry, "register">): (() => void) => actions?.({ registry, current: panel.owner, session }) ?? (() => {});
