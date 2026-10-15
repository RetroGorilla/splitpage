import { S } from "./_state.js";
import { documentTransitions } from "../legacy/transition-bridge.ts";
import { suppressUnloadWarning } from "./00-prelude.js";
import { updateHideShotMenu } from "./01b-hide-shot.js";
import { initDocIdentityChannel, loadInitialDocument, syncDocIdentity } from "./02b-doc-id.js";
import {
  SNAPSHOT_KEY,
  cloneState,
  reportMerge,
  toastLastEditor,
  updateIdentityChip
} from "./03-sync.js";
import { startHistoryMigration } from "./03a-history-store.js";
import { renderFirstDraw } from "./05-render.js";
import { updateSaveStatus } from "./12-dirty-toast.js";
import { detectServer } from "./13-hosted.js";
import { applyStashedWork, updateAutoSaveMenu } from "./14-export.js";
import { tryResumeLastProject } from "./18-local-files.js";
import { initDesktop, notifyDesktopDocumentState } from "./20f-desktop.js";
import { applyTakenDraft, armServerDraftResume, desktopDraftTaker } from "./20g-drafts.js";

export function startupPorts() {
  return {
    desktop: !!S.DESKTOP,
    draft: {
      taker: desktopDraftTaker(),
      detectServer: detectServer,
      armServerResume: armServerDraftResume,
      applyDraft: applyTakenDraft
    },
    document: {
      load: function () { return loadInitialDocument(); },
      clone: cloneState,
      applyStash: function (loaded, options) { return applyStashedWork(loaded, null, options); },
      liveDocument: function () { return S.state; },
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
      snapshotKey: SNAPSHOT_KEY,
      unsaved: function () { return !!S.dirty && !suppressUnloadWarning; }
    },
    startDesktop: initDesktop
  };
}

export function openInitialDocument(startup) {
  S.initialStateReady = startup.openDocument();
}
