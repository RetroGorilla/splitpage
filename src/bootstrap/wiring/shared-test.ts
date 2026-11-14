import { exposeTestHook } from "../../features/common/test-hooks.ts";
import { mintDocId } from "../../adapters/identity/ids.ts";
import { startupReady } from "../../application/startup-signal.ts";
import { migrateRows } from "../document-ports.ts";
import { fromHtml } from "../richtext.ts";
import { currentCapabilities } from "./session-owner.ts";
import { enterSharedSession, joinSharedBindings, leaveSharedSession, sharedSessionParts } from "./shared-session.ts";
import { recoveryPanelBinding } from "./recovery-panel.ts";
import type { SharedSwitchPorts } from "./shared-session.ts";
import { sharedWriterBindings } from "./shared-writer.ts";
import { createSharedTestPeer } from "./shared-test-peer.ts";
import { sharedCommandRefusalNotice } from "./ports/shared-command-notices.ts";
import { notices } from "./ports/effects.ts";
import { documentReader } from "./ports/document.ts";
import { getEditorName } from "./preferences-owner.ts";
import { undoOwner } from "./undo.ts";
import { writerControls } from "./writer.ts";
import { draftResume } from "./recovery-owners.ts";
import { draftSource } from "./drafts.ts";
import { confirmSavedNow } from "./save-owners.ts";
import { documentLocation, setHome } from "./location-owner.ts";

function sharedEntryRefusal(ready: boolean, composing: boolean): string | null {
  return (!ready ? "startup-pending" : null)
    ?? (composing ? "buffer-composition" : null)
    ?? (draftResume().restorePending() ? "draft-restore-pending" : null);
}

export function mountSharedSessionFeature(): void {
  exposeTestHook("__sharedTest", () => {
    let ports: SharedSwitchPorts | null = null, peer: ReturnType<typeof createSharedTestPeer> | null = null;
    let switching = false, composing = false, detached = false;
    const counts = { recovered: 0, missingBase: 0, ownershipScans: 0 };
    const report = (error: unknown): void => { console.error(error); };
    const composition = (event: Event): void => { composing = event.type === "compositionstart"; };
    document.addEventListener("compositionstart", composition, true);
    document.addEventListener("compositionend", composition, true);
    const bindings = joinSharedBindings(sharedWriterBindings({
      recovered: () => { counts.recovered++; notices.show("Your writing was kept in recovery.", "warn"); },
      missingBase: () => { counts.missingBase++; notices.show("This line changed. Try writing again.", "warn"); },
      ownershipScan: () => { counts.ownershipScans++; }, report
    }), recoveryPanelBinding);
    return {
      enter: async () => {
        if (switching) return { ok: false, reason: "session-switching" };
        if (sharedSessionParts()) return { ok: false, reason: "already-shared" };
        switching = true;
        try {
          let ready = false;
          startupReady()?.then(() => { ready = true; }, report);
          await Promise.resolve();
          const standalone = currentCapabilities();
          const common = { edit: standalone.edit, comment: standalone.edit };
          ports = {
            refusal: () => sharedEntryRefusal(ready, composing),
            commandRefused: sharedCommandRefusalNotice(notices),
            settle: () => {
              if (writerControls()?.writerFlowControl()?.settle?.() === false) throw new Error("The Writer could not settle");
              undoOwner().flush();
            },
            detach: () => {
              draftSource.detachSource(); detached = true;
              setHome("none"); documentLocation().markWrittenOut(false); confirmSavedNow();
            },
            bindings, common, standalone, migrate: migrateRows, docId: mintDocId, editor: getEditorName,
            structure: { cells: html => fromHtml(html) }, report,
            timers: { now: () => Date.now(), start: (run, ms) => setTimeout(run, ms), stop: timer => { clearTimeout(timer as ReturnType<typeof setTimeout>); } },
            now: () => Date.now()
          };
          const result = await enterSharedSession(ports);
          const parts = sharedSessionParts();
          if (result.ok && parts) peer = createSharedTestPeer(parts, ports);
          else if (detached) { detached = false; draftSource.resumeWriting(); }
          return result;
        } finally { switching = false; }
      },
      leave: () => {
        if (switching) return { ok: false, reason: "session-switching" };
        if (!ports) return { ok: false, reason: "not-shared" };
        switching = true;
        try {
          const result = leaveSharedSession(ports);
          if (result.ok) {
            peer?.dispose(); peer = null; ports = null;
            if (detached) { detached = false; draftSource.resumeWriting(); }
          }
          return result;
        } finally { switching = false; }
      },
      peer: {
        type: (rowId: string, offset: number, text: string) => peer?.type(rowId, offset, text),
        remove: (rowId: string) => peer?.remove(rowId),
        hold: () => { peer?.hold(); },
        deliver: (order?: "forward" | "reverse" | "duplicate") => peer?.deliver(order),
        release: (order?: "forward" | "reverse" | "duplicate") => peer?.release(order)
      },
      read: () => ({ app: documentReader.read(doc => doc ? JSON.parse(JSON.stringify(doc)) as unknown : null), peer: peer?.read() ?? null }),
      counters: () => ({ ...counts, queued: peer?.queued() ?? 0 })
    };
  }, () => {});
}
