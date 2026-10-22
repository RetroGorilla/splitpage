import type { Startup, StartupPorts } from "../startup.ts";
import type { StashResult } from "../startup/initial-document.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import { documentTransitions } from "../../legacy/transition-bridge.ts";
import { setInitialStateReady, suppressUnloadWarning } from "../../js/00-prelude.js";
import { updateHideShotMenu } from "../../js/01b-hide-shot.js";
import { initDocIdentityChannel, liveDocumentPort, loadInitialDocument, syncDocIdentity } from "../../js/02b-doc-id.js";
import { cloneState } from "../../core/document/clone.ts";
import { LEGACY_SNAPSHOTS_KEY } from "../../application/recovery/legacy-snapshots.ts";
import {
  reportMerge,
  toastLastEditor,
  updateIdentityChip
} from "../../js/03-sync.js";
import { startHistoryMigration } from "../../js/03a-history-store.js";
import { renderFirstDraw } from "../../js/05-render.js";
import { hasUnsavedChanges, updateSaveStatus } from "../../js/12-dirty-toast.js";
import { detectServer } from "../../js/13-hosted.js";
import { applyStashedWork, updateAutoSaveMenu } from "../../js/14-export.js";
import { tryResumeLastProject } from "../../js/18-local-files.js";
import { seedCheckPasses } from "../../js/20b-onboarding.js";
import { desktopBridge, initDesktop, notifyDesktopDocumentState } from "../../js/20f-desktop.js";
import { applyTakenDraft, armServerDraftResume, desktopDraftTaker } from "../../js/20g-drafts.js";

export function startupPorts(): StartupPorts<unknown, ValidatedDocument, ValidatedDocument, unknown> {
  return {
    desktop: !!desktopBridge(),
    draft: {
      taker: desktopDraftTaker(),
      detectServer: detectServer,
      armServerResume: armServerDraftResume,
      applyDraft: applyTakenDraft
    },
    document: {
      pristine: seedCheckPasses,
      load: loadInitialDocument,
      clone: cloneState,
      applyStash: function (loaded, options) {
        const applied: StashResult<ValidatedDocument, unknown> = applyStashedWork(loaded, null, options);
        return applied;
      },
      liveDocument: function () { return liveDocumentPort.current(); },
      open: function (doc, reason) { documentTransitions().open({ from: { document: doc }, reason: reason }); },
      firstDraw: renderFirstDraw,
      refreshChrome: [updateIdentityChip, updateAutoSaveMenu, updateHideShotMenu, updateSaveStatus],
      reportRecovery: function (report) { reportMerge(report, { kind: "recovery" }); },
      toastLastEditor: toastLastEditor,
      resumeLastProject: tryResumeLastProject,
      syncIdentity: syncDocIdentity,
      openIdentityChannel: function () { initDocIdentityChannel(); },
      notifyDesktop: notifyDesktopDocumentState,
      startHistoryMigration: startHistoryMigration
    },
    page: {
      window: window,
      snapshotKey: LEGACY_SNAPSHOTS_KEY,
      unsaved: function () { return hasUnsavedChanges() && !suppressUnloadWarning; }
    },
    startDesktop: initDesktop
  };
}

export function openInitialDocument(startup: Startup): void {
  setInitialStateReady(startup.openDocument());
}
