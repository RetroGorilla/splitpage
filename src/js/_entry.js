import { mountPageEntry } from "../bootstrap/wiring.ts";
import { __init as init_02b_doc_id } from "./02b-doc-id.js";
import { __init as init_02c_blobs } from "../adapters/storage/02c-blobs.js";
import { __init as init_02d_gallery } from "../adapters/storage/02d-gallery.js";
import { __init as init_03_sync } from "./03-sync.js";
import { __init as init_03a_history_store } from "./03a-history-store.js";
import { __init as init_05_render } from "./05-render.js";
import { __init as init_07_production_tags } from "./07-production-tags.js";
import { __init as init_07b_plain_tags } from "./07b-plain-tags.js";
import { mountScriptPlaceFeature, mountFindFeature, mountTagPanelsFeature } from "../bootstrap/wiring.ts";
import { __init as init_11_import } from "./11-import.js";
import { __init as init_12_dirty_toast } from "./12-dirty-toast.js";
import { mountHostedFeature } from "../bootstrap/wiring.ts";
import { __init as init_13a_presence } from "./13a-presence.js";
import { __init as init_13b_collaborate } from "./13b-collaborate.js";
import { __init as init_14_export } from "./14-export.js";
import { __init as init_18_local_files } from "./18-local-files.js";
import { __init as init_18a_local_merge } from "./18a-local-merge.js";
import { mountFileMenuDropdownFeature, mountCommandMenuFeature } from "../bootstrap/wiring.ts";
import { __init as init_19_writer } from "./19-writer.js";
import { __init as init_20_teleprompter } from "./20-teleprompter.js";
import { __init as init_20d_formats } from "./20d-formats.js";
import { __init as init_20e_connect } from "./20e-connect.js";
import { migrateRows } from "../legacy/document-ports.ts";
import { documentIdentityPort } from "./02b-doc-id.js";
import { documentDestinationPort, documentHistoryPort, legacyMergePorts, stampRow } from "./03-sync.js";
import { bulkTagCell, runIdleRefresh } from "./07-production-tags.js";
import { legacySessionEffects } from "./12-dirty-toast.js";
import { legacyFileDestination, legacySavePorts } from "./14-export.js";
import { importDocumentSource } from "./11-import.js";
import { serverDocumentSource, serverSaveDestination } from "./13-hosted.js";
import { importSaveDestination, projectFileSource } from "./18-local-files.js";
import { legacyProjectFileServices } from "./20d-formats.js";
import { wireLegacyApp, mountUpdateFeature, mountNewTabFeature, mountCommentsLogicFeature, mountReadTimeFeature, mountRundownFeature, mountRundownPresenceFeature, mountTargetFeature, mountScriptZoomFeature, mountDraftEditFeature, mountHelpFeature, mountGalleryFeature, mountGalleryOverlayFeature, mountGalleryVideoFeature, mountCopyPasteFeature, mountSettingsFeature, mountAppDataFeature, mountHideShotFeature, mountFileMenuExportFeature, mountSceneStatusFeature, mountBrollFeature, mountBrollPanelStateFeature, mountScenesFeature, mountSceneMediaFeature, derivedRecordsPlan, mountOnboardingFeature, mountVideoFilesFeature, mountDesktopFeature, mountDraftsFeature, draftRecoveryPorts } from "../bootstrap/wiring.ts";
import { startAppWhenReady } from "../bootstrap/app.ts";

var wiring = null;
try {
  wiring = wireLegacyApp({
    entry: migrateRows,
    effects: legacySessionEffects(),
    refresh: runIdleRefresh,
    records: derivedRecordsPlan,
    bulkTags: { cell: bulkTagCell, stamp: stampRow },
    saves: legacySavePorts,
    destinations: function () { return [legacyFileDestination(), importSaveDestination(), serverSaveDestination()]; },
    transitions: { destination: documentDestinationPort, identity: documentIdentityPort, history: documentHistoryPort },
    sources: function () { return [projectFileSource(), importDocumentSource(), serverDocumentSource()]; },
    merge: legacyMergePorts,
    recovery: draftRecoveryPorts,
    projectFiles: legacyProjectFileServices,
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
  init_05_render();
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
  init_07_production_tags();
  init_07b_plain_tags();
  mountTagPanelsFeature();
  mountBrollFeature();
  mountBrollPanelStateFeature();
  mountFindFeature();
  mountCommentsLogicFeature();
  init_11_import();
  init_12_dirty_toast();
  mountHostedFeature();
  init_13a_presence();
  init_13b_collaborate();
  init_14_export();
  init_18_local_files();
  init_18a_local_merge();
  mountFileMenuDropdownFeature();
  mountFileMenuExportFeature(wiring.captureExportDocument);
  mountCommandMenuFeature();
  init_19_writer();
  init_20_teleprompter();
  mountUpdateFeature();
  mountOnboardingFeature();
  mountHelpFeature();
  init_20d_formats();
  init_20e_connect();
  mountDesktopFeature();
  mountDraftsFeature();
  mountAppDataFeature();
  mountNewTabFeature();
  mountSettingsFeature();
  startAppWhenReady(document, wiring);
}
