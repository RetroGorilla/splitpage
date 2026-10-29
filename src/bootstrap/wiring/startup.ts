import { documentIdentityOwner } from "./document-identity.ts";
import type { Startup, StartupPorts } from "../startup.ts";
import type { StashResult } from "../startup/initial-document.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { MergedStates } from "../../core/merge-states.ts";
import { connectStartup } from "../../application/startup-signal.ts";
import { documentTransitions } from "./transition-owners.ts";
import { suppressUnloadWarning } from "../startup/page-entry.ts";
import { updateHideShotMenu } from "./hide-shot.ts";
import { documentIdentity } from "./ports/document-identity-controls.ts";
import { loadInitialState } from "../startup/document-entry.js";
import { heldDocument } from "./session-owner.ts";
import { cloneState } from "../../core/document/clone.ts";
import { LEGACY_SNAPSHOTS_KEY } from "../../application/recovery/legacy-snapshots.ts";
import { toastLastEditor } from "./history-panel.ts";
import { reportMerge } from "./document-merge.ts";
import { historyOwner } from "./history.ts";
import { currentRowsRender } from "./render.ts";
import { updateSaveStatus } from "./save-status.ts";
import { saves } from "./ports/saving.ts";
import { updateAutoSaveMenu } from "./file-saving.ts";
import { applyStashedWork } from "./recovery-owners.ts";
import { localFilesOwner } from "./local-files.ts";
import { seedCheckPasses } from "../../adapters/page/seed-check.ts";
import { startDesktopShell } from "./desktop.ts";
import { notifyDesktopDocumentState } from "./desktop-owners.ts";
import { runningOnDesktop } from "../../application/desktop-presence.ts";
import { applyTakenDraft, draftTaker } from "./drafts.ts";

export function startupPorts(): StartupPorts<unknown, ValidatedDocument, ValidatedDocument | null, MergedStates> {
  return {
    desktop: runningOnDesktop(),
    draft: {
      taker: draftTaker(),
      applyDraft: applyTakenDraft
    },
    document: {
      pristine: seedCheckPasses,
      load: loadInitialState,
      clone: cloneState,
      applyStash: function (loaded, options) {
        const applied = applyStashedWork(loaded, null, { ...options });
        if (applied instanceof Promise) throw new Error("The stashed work opened at startup must merge without waiting for an undo point");
        const result: StashResult<ValidatedDocument | null, MergedStates> = applied;
        return result;
      },
      liveDocument: function () { return heldDocument(); },
      open: function (doc, reason) {
        if (doc === null) throw new Error("The stashed work opened at startup left no document to open");
        documentTransitions().open({ from: { document: doc }, reason: reason });
      },
      firstDraw: () => {
        const render = currentRowsRender();
        if (!render) throw new Error("Rows rendering is not started yet");
        return render.renderFirstDraw();
      },
      refreshChrome: [updateAutoSaveMenu, updateHideShotMenu, updateSaveStatus],
      reportRecovery: function (report) { reportMerge(report, { kind: "recovery" }); },
      toastLastEditor: toastLastEditor,
      resumeLastProject: (...args: Parameters<ReturnType<typeof localFilesOwner>["tryResumeLastProject"]>) => localFilesOwner().tryResumeLastProject(...args),
      syncIdentity: documentIdentity.syncDocIdentity,
      openIdentityChannel: function () { documentIdentityOwner().initDocIdentityChannel(); },
      notifyDesktop: notifyDesktopDocumentState,
      startHistoryMigration: () => { void historyOwner().startHistoryMigration(); }
    },
    page: {
      window: window,
      snapshotKey: LEGACY_SNAPSHOTS_KEY,
      unsaved: function () { return saves.unsaved() && !suppressUnloadWarning; }
    },
    startDesktop: startDesktopShell
  };
}

export function openInitialDocument(startup: Startup): () => void {
  const disconnect = connectStartup(startup);
  void startup.openDocument();
  return disconnect;
}
