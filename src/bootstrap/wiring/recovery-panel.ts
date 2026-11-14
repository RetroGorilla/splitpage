import { recoveryCommand } from "../../application/commands/recovery.ts";
import { readSharedContentRef } from "../../core/collab/read-operation.ts";
import type { SharedRecoveryName } from "../../core/collab/operations.ts";
import { readSharedRecords } from "../../adapters/collab/record-reader.ts";
import { createRecoveryPanel } from "../../features/recovery-panel/mount.ts";
import { startRecoveryPanelActions } from "../../features/recovery-panel/actions.ts";
import type { ActionRegistry } from "../../application/actions.ts";
import type { CommonDocumentSession } from "../../application/session/document-session.ts";
import type { RecoveryPanelControl, RecoveryPanelPorts } from "../../features/recovery-panel/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { onDocumentReplaced, runCommand, sharedRecoverySession } from "./session-owner.ts";
import { sharedSessionParts } from "./shared-session.ts";
import type { SharedSessionParts } from "./shared-session.ts";
import { documentReader } from "./ports/document.ts";
import { notices } from "./ports/effects.ts";
import { text } from "./ports/text.ts";

declare const SPLITPAGE_TEST_HOOKS: boolean | undefined;

const panel = owned<RecoveryPanelControl>();
const session: RecoveryPanelPorts["session"] = { current: sharedRecoverySession, onChange: onDocumentReplaced };

export interface RecoveryPanelWiringPorts extends Pick<RecoveryPanelPorts, "host" | "session" | "document" | "text" | "notices"> {
  readonly parts: () => Pick<SharedSessionParts, "handle" | "author"> | null;
  readonly run: CommonDocumentSession["run"];
}

export function recoveryPanelPorts(source: RecoveryPanelWiringPorts): RecoveryPanelPorts {
  function change(action: "restore" | "discard", entry: SharedRecoveryName) {
    const reader = source.session.current();
    if (!reader) return { kind: "rejected" as const, reason: "recovery-no-session" };
    return source.run(recoveryCommand(action, entry, { recovery: reader, author: () => {
      const author = source.parts()?.author.next(), id = author && readSharedContentRef(author.id);
      return author && id ? { id, by: author.by } : null;
    } }));
  }
  return { host: source.host, session: source.session, document: source.document, text: source.text, notices: source.notices,
    reply: key => { const parts = source.parts(); return parts ? readSharedRecords(parts.handle, "replies").find(reply => reply.key === key)?.fields ?? null : null; },
    restore: entry => change("restore", entry), discard: entry => change("discard", entry) };
}

export function mountRecoveryPanelFeature(): RecoveryPanelControl {
  if (typeof SPLITPAGE_TEST_HOOKS !== "undefined" && !SPLITPAGE_TEST_HOOKS) return { open: () => {}, dispose: () => {} };
  return panel.replace(() => createRecoveryPanel(recoveryPanelPorts({ host: document.body, session, document: documentReader, text, notices,
    parts: sharedSessionParts, run: runCommand })));
}

export const stopRecoveryPanelFeature = panel.stop;
export function registerRecoveryPanelActions(registry: Pick<ActionRegistry, "register">): () => void {
  if (typeof SPLITPAGE_TEST_HOOKS !== "undefined" && !SPLITPAGE_TEST_HOOKS) return () => {};
  return startRecoveryPanelActions({ registry, current: panel.owner, session });
}
