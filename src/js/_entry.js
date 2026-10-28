import { mountPageEntry } from "../bootstrap/wiring.ts";
import { mountDocumentIdentityOwner } from "../bootstrap/wiring.ts";
import { startBlobs as init_02c_blobs } from "../adapters/storage/02c-blobs.js";
import { startGalleryStore as init_02d_gallery } from "../adapters/storage/02d-gallery.js";
import { mountSessionMergeOwner } from "../bootstrap/wiring.ts";
import { mountHistoryOwner } from "../bootstrap/wiring.ts";
import { mountRowsRenderFeature } from "../bootstrap/wiring.ts";
import { mountProductionTagsFeature } from "../bootstrap/wiring.ts";
import { mountPlainTagsFeature } from "../bootstrap/wiring.ts";
import { mountScriptPlaceFeature, mountFindFeature, mountTagPanelsFeature } from "../bootstrap/wiring.ts";
import { mountImportDialogFeature } from "../bootstrap/wiring.ts";
import { mountSaveStatusFeature } from "../bootstrap/wiring.ts";
import { mountFileSavingFeature } from "../bootstrap/wiring.ts";
import { mountLocalFilesFeature } from "../bootstrap/wiring.ts";
import { mountMergeReviewFeature } from "../bootstrap/wiring.ts";
import { mountFileMenuDropdownFeature, mountCommandMenuFeature } from "../bootstrap/wiring.ts";
import { mountWriterRuntimeFeature } from "../bootstrap/wiring.ts";
import { mountPrompterRuntimeFeature } from "../bootstrap/wiring.ts";
import { migrateRows } from "../legacy/document-ports.ts";
import { mountProjectFiles } from "../bootstrap/wiring.ts";
import { wireLegacyApp, mountUpdateFeature, mountNewTabFeature, mountCommentsLogicFeature, mountReadTimeFeature, mountRundownFeature, mountTargetFeature, mountScriptZoomFeature, mountDraftEditFeature, mountHelpFeature, mountGalleryFeature, mountGalleryOverlayFeature, mountGalleryVideoFeature, mountCopyPasteFeature, mountSettingsFeature, mountAppDataFeature, mountHideShotFeature, mountFileMenuExportFeature, mountSceneStatusFeature, mountBrollFeature, mountBrollPanelStateFeature, mountScenesFeature, mountSceneMediaFeature, derivedRecordsPlan, mountOnboardingFeature, mountVideoFilesFeature, mountDesktopFeature, mountDraftsFeature, draftRecoveryPorts } from "../bootstrap/wiring.ts";
import { startAppWhenReady } from "../bootstrap/app.ts";

var wiring = null;
try {
  wiring = wireLegacyApp({
    entry: migrateRows,
    records: derivedRecordsPlan,
    recovery: draftRecoveryPorts,
    keyTarget: window
  });
} catch (error) {
  console.error(error);
}
if (wiring) {
  mountPageEntry();
  mountSceneStatusFeature();
  mountHideShotFeature();
  mountDocumentIdentityOwner();
  init_02c_blobs();
  init_02d_gallery();
  var sessionMerge = mountSessionMergeOwner();
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
  mountScenesFeature();
  mountSceneMediaFeature();
  mountProductionTagsFeature();
  mountPlainTagsFeature();
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
  startAppWhenReady(document, wiring);
}
