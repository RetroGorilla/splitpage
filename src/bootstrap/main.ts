import { wireLegacyApp } from "./wiring.ts";
import { startAppWhenReady } from "./app.ts";
import { migrateRows } from "./document-ports.ts";
import { mountBlobStore } from "./wiring/blobs.ts";
import { startGalleryStore } from "../adapters/storage/02d-gallery.ts";
import { mountPageEntry } from "./startup/page-entry.ts";
import { mountDocumentIdentityOwner } from "./wiring/document-identity.ts";
import { mountSessionMergeOwner } from "./wiring/session-merge.ts";
import { mountHistoryOwner } from "./wiring/history.ts";
import { mountScreenStateOwner } from "./wiring/screen-state.ts";
import { mountBeatStatusFeature } from "./wiring/beat-status.ts";
import { mountHideShotFeature } from "./wiring/hide-shot.ts";
import { mountScriptPlaceFeature } from "./wiring/side-panels.ts";
import { mountRowsRenderFeature } from "./wiring/render.ts";
import { mountDraftEditFeature } from "./wiring/draft-edit.ts";
import { mountGalleryFeature, mountGalleryOverlayFeature, mountGalleryVideoFeature } from "./wiring/gallery.ts";
import { mountRundownFeature, mountTargetFeature } from "./wiring/rundown.ts";
import { mountCopyPasteFeature } from "./wiring/clipboard.ts";
import { mountReadTimeFeature } from "./wiring/read-time.ts";
import { mountScriptZoomFeature } from "./wiring/script-zoom.ts";
import { mountVideoFilesFeature } from "./wiring/video-files.ts";
import { mountBeatsFeature, mountBeatMediaFeature } from "./wiring/rows.ts";
import { mountProductionTagsFeature } from "./wiring/production-tags.ts";
import { mountPlainTagsFeature } from "./wiring/plain-tags.ts";
import { mountWhoListFeature } from "./wiring/who-list.ts";
import { mountTagPanelsFeature } from "./wiring/production.ts";
import { derivedRecordsPlan, mountBrollFeature, mountBrollPanelStateFeature } from "./wiring/broll.ts";
import { mountFindFeature } from "./wiring/find.ts";
import { mountCommentsLogicFeature } from "./wiring/comments.ts";
import { mountImportDialogFeature } from "./wiring/imports.ts";
import { mountSaveStatusFeature } from "./wiring/save-status.ts";
import { mountFileSavingFeature } from "./wiring/file-saving.ts";
import { mountLocalFilesFeature } from "./wiring/local-files.ts";
import { mountMergeReviewFeature } from "./wiring/merge-review.ts";
import { mountFileMenuDropdownFeature } from "./wiring/file-menu.ts";
import { mountFileMenuExportFeature } from "./wiring/file-menu-export.ts";
import { mountCommandMenuFeature } from "./wiring/command-menu.ts";
import { mountWriterRuntimeFeature } from "./wiring/writer.ts";
import { mountPrompterRuntimeFeature } from "./wiring/prompter.ts";
import { mountUpdateFeature } from "./wiring/update.ts";
import { mountOnboardingFeature } from "./wiring/onboarding.ts";
import { mountHelpFeature } from "./wiring/help.ts";
import { mountProjectFiles } from "./wiring/project-files.ts";
import { mountDesktopFeature } from "./wiring/desktop.ts";
import { draftRecoveryPorts, mountDraftsFeature } from "./wiring/drafts.ts";
import { mountSettingsFeature, mountAppDataFeature } from "./wiring/settings.ts";
import { mountNewTabFeature } from "./wiring/newtab.ts";
import { showStartupFailure } from "./startup/failure-screen.ts";

function failStartup(error: unknown): void {
  console.error(error);
  showStartupFailure(error);
}

let wiring: ReturnType<typeof wireLegacyApp> | null = null;
try {
  wiring = wireLegacyApp({
    entry: migrateRows,
    records: derivedRecordsPlan,
    recovery: draftRecoveryPorts,
    keyTarget: window
  });
} catch (error) {
  failStartup(error);
}
if (wiring) {
  try {
    mountAndStart(wiring);
  } catch (error) {
    failStartup(error);
  }
}

function mountAndStart(wiring: ReturnType<typeof wireLegacyApp>): void {
  mountScreenStateOwner();
  mountPageEntry();
  mountBeatStatusFeature();
  mountHideShotFeature();
  mountDocumentIdentityOwner();
  mountBlobStore();
  startGalleryStore();
  const sessionMerge = mountSessionMergeOwner();
  mountHistoryOwner();
  mountScriptPlaceFeature();
  mountRowsRenderFeature();
  mountDraftEditFeature();
  mountGalleryOverlayFeature();
  mountRundownFeature();
  mountCopyPasteFeature();
  mountReadTimeFeature();
  mountScriptZoomFeature();
  mountTargetFeature();
  mountGalleryVideoFeature();
  mountGalleryFeature();
  mountVideoFilesFeature();
  mountBeatsFeature();
  mountBeatMediaFeature();
  mountProductionTagsFeature();
  mountPlainTagsFeature();
  mountWhoListFeature();
  mountTagPanelsFeature();
  mountBrollFeature();
  mountBrollPanelStateFeature();
  mountFindFeature();
  mountCommentsLogicFeature();
  mountImportDialogFeature({ stampRow: sessionMerge.stampRow });
  mountSaveStatusFeature();
  mountFileSavingFeature();
  mountLocalFilesFeature();
  mountMergeReviewFeature();
  mountFileMenuDropdownFeature();
  mountFileMenuExportFeature(wiring.captureExportDocument);
  mountCommandMenuFeature();
  mountWriterRuntimeFeature();
  mountPrompterRuntimeFeature();
  mountUpdateFeature();
  mountOnboardingFeature();
  mountHelpFeature();
  mountProjectFiles();
  mountDesktopFeature();
  mountDraftsFeature();
  mountAppDataFeature();
  mountNewTabFeature();
  mountSettingsFeature();
  mountRecoveryPanelFeature();
  startAppWhenReady(document, wiring, failStartup);
}
import { mountRecoveryPanelFeature } from "./wiring/recovery-panel.ts";
