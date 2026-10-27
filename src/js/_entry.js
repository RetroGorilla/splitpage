import { mountPageEntry } from "../bootstrap/wiring.ts";
import { __init as init_02b_doc_id } from "./02b-doc-id.js";
import { startBlobs as init_02c_blobs } from "../adapters/storage/02c-blobs.js";
import { startGalleryStore as init_02d_gallery } from "../adapters/storage/02d-gallery.js";
import { __init as init_03_sync } from "./03-sync.js";
import { __init as init_03a_history_store } from "./03a-history-store.js";
import { mountRowsRenderFeature } from "../bootstrap/wiring.ts";
import { mountProductionTagsFeature } from "../bootstrap/wiring.ts";
import { mountPlainTagsFeature } from "../bootstrap/wiring.ts";
import { mountScriptPlaceFeature, mountFindFeature, mountTagPanelsFeature } from "../bootstrap/wiring.ts";
import { mountImportDialogFeature } from "../bootstrap/wiring.ts";
import { mountSaveStatusFeature } from "../bootstrap/wiring.ts";
import { mountHostedFeature } from "../bootstrap/wiring.ts";
import { __init as init_13a_presence } from "./13a-presence.js";
import { __init as init_13b_collaborate } from "./13b-collaborate.js";
import { mountFileSavingFeature } from "../bootstrap/wiring.ts";
import { __init as init_18_local_files } from "./18-local-files.js";
import { mountMergeReviewFeature } from "../bootstrap/wiring.ts";
import { mountFileMenuDropdownFeature, mountCommandMenuFeature } from "../bootstrap/wiring.ts";
import { __init as init_19_writer } from "./19-writer.js";
import { mountPrompterRuntimeFeature } from "../bootstrap/wiring.ts";
import { __init as init_20e_connect } from "./20e-connect.js";
import { migrateRows } from "../legacy/document-ports.ts";
import { documentIdentityPort, adoptRestoredState, copyDocHistorySafe, docIdEvents, initDocIdentityChannel, migrateDocument, reassignDocId, standaloneHtmlFor, syncDocIdentity } from "./02b-doc-id.js";
import { documentDestinationPort, documentHistoryPort, legacyMergePorts, stampRow, setBaseState } from "./03-sync.js";
import { serverDocumentSource, serverSaveDestination } from "./13-hosted.js";
import { importSaveDestination, projectFileSource } from "./18-local-files.js";
import { mountProjectFiles } from "../bootstrap/wiring.ts";
import { wireLegacyApp, mountUpdateFeature, mountNewTabFeature, mountCommentsLogicFeature, mountReadTimeFeature, mountRundownFeature, mountRundownPresenceFeature, mountTargetFeature, mountScriptZoomFeature, mountDraftEditFeature, mountHelpFeature, mountGalleryFeature, mountGalleryOverlayFeature, mountGalleryVideoFeature, mountCopyPasteFeature, mountSettingsFeature, mountAppDataFeature, mountHideShotFeature, mountFileMenuExportFeature, mountSceneStatusFeature, mountBrollFeature, mountBrollPanelStateFeature, mountScenesFeature, mountSceneMediaFeature, derivedRecordsPlan, mountOnboardingFeature, mountVideoFilesFeature, mountDesktopFeature, mountDraftsFeature, draftRecoveryPorts } from "../bootstrap/wiring.ts";
import { startAppWhenReady } from "../bootstrap/app.ts";

var wiring = null;
try {
  wiring = wireLegacyApp({
    entry: migrateRows,
    records: derivedRecordsPlan,
    bulkTags: { stamp: stampRow },
    fileSaving: { copyHistory: copyDocHistorySafe, syncIdentity: syncDocIdentity, setBaseline: setBaseState },
    destinations: function () { return [importSaveDestination(), serverSaveDestination()]; },
    transitions: { destination: documentDestinationPort, identity: documentIdentityPort, history: documentHistoryPort },
    sources: function () { return [projectFileSource(), serverDocumentSource()]; },
    merge: legacyMergePorts,
    recovery: draftRecoveryPorts,
    projectFiles: {
      prepareDocument: migrateDocument,
      restoreDocument: adoptRestoredState,
      changeDocumentId: reassignDocId,
      identityEvents: docIdEvents,
      connectIdentity: initDocIdentityChannel,
      standaloneHtml: standaloneHtmlFor,
      replaceSyncBase: setBaseState,
    },
    keyTarget: window
  });
} catch (error) {
  console.error(error);
}
if (wiring) {
  mountPageEntry();
  mountSceneStatusFeature();
  mountHideShotFeature();
  init_02b_doc_id();
  init_02c_blobs();
  init_02d_gallery();
  init_03_sync();
  init_03a_history_store();
  mountScriptPlaceFeature();
  mountRowsRenderFeature();
  mountDraftEditFeature();
  mountGalleryOverlayFeature();
  mountRundownFeature();
  mountCopyPasteFeature();
  mountRundownPresenceFeature();
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
  mountImportDialogFeature({ stampRow });
  mountSaveStatusFeature({ sync: syncDocIdentity });
  mountHostedFeature();
  init_13a_presence();
  init_13b_collaborate();
  mountFileSavingFeature();
  init_18_local_files();
  mountMergeReviewFeature();
  mountFileMenuDropdownFeature();
  mountFileMenuExportFeature(wiring.captureExportDocument);
  mountCommandMenuFeature();
  init_19_writer();
  mountPrompterRuntimeFeature();
  mountUpdateFeature();
  mountOnboardingFeature();
  mountHelpFeature();
  mountProjectFiles();
  init_20e_connect();
  mountDesktopFeature();
  mountDraftsFeature();
  mountAppDataFeature();
  mountNewTabFeature();
  mountSettingsFeature();
  startAppWhenReady(document, wiring);
}
