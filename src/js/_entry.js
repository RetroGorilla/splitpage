import { __init as init_00_prelude } from "./00-prelude.js";
import { __init as init_02_state } from "./02-state.js";
import { __init as init_02b_doc_id } from "./02b-doc-id.js";
import { __init as init_02c_blobs } from "../adapters/storage/02c-blobs.js";
import { __init as init_02d_gallery } from "../adapters/storage/02d-gallery.js";
import { __init as init_03_sync } from "./03-sync.js";
import { __init as init_03a_history_store } from "./03a-history-store.js";
import { __init as init_03b_side_panels } from "./03b-side-panels.js";
import { __init as init_04_richtext } from "./04-richtext.js";
import { __init as init_05_render } from "./05-render.js";
import { __init as init_07_production_tags } from "./07-production-tags.js";
import { __init as init_07b_plain_tags } from "./07b-plain-tags.js";
import { __init as init_08_production_panels } from "./08-production-panels.js";
import { mountFindFeature } from "../bootstrap/wiring.ts";
import { __init as init_11_import } from "./11-import.js";
import { __init as init_12_dirty_toast } from "./12-dirty-toast.js";
import { __init as init_13_hosted } from "./13-hosted.js";
import { __init as init_13a_presence } from "./13a-presence.js";
import { __init as init_13b_collaborate } from "./13b-collaborate.js";
import { __init as init_14_export } from "./14-export.js";
import { __init as init_14b_export_kit } from "./14b-export-kit.js";
import { __init as init_18_local_files } from "./18-local-files.js";
import { __init as init_18a_local_merge } from "./18a-local-merge.js";
import { __init as init_18b_file_menu } from "./18b-file-menu.js";
import { __init as init_18d_command_menu } from "./18d-command-menu.js";
import { __init as init_19_writer } from "./19-writer.js";
import { __init as init_20_teleprompter } from "./20-teleprompter.js";
import { __init as init_20a_update } from "./20a-update.js";
import { __init as init_20d_formats } from "./20d-formats.js";
import { __init as init_20e_connect } from "./20e-connect.js";
import { migrateRows } from "./02-state.js";
import { documentIdentityPort } from "./02b-doc-id.js";
import { documentDestinationPort, documentHistoryPort, legacyMergePorts, stampRow } from "./03-sync.js";
import { bulkTagCell, runIdleRefresh } from "./07-production-tags.js";
import { legacySessionEffects } from "./12-dirty-toast.js";
import { legacyFileDestination, legacySavePorts } from "./14-export.js";
import { importDocumentSource } from "./11-import.js";
import { serverDocumentSource, serverSaveDestination } from "./13-hosted.js";
import { importSaveDestination, projectFileSource } from "./18-local-files.js";
import { legacyProjectFileServices } from "./20d-formats.js";
import { wireLegacyApp, mountNewTabFeature, mountCommentsLogicFeature, mountReadTimeFeature, mountRundownFeature, mountRundownPresenceFeature, mountTargetFeature, mountScriptZoomFeature, mountDraftEditFeature, mountHelpFeature, mountGalleryFeature, mountGalleryOverlayFeature, mountGalleryVideoFeature, mountCopyPasteFeature, mountSettingsFeature, mountAppDataFeature, mountHideShotFeature, mountFileMenuExportFeature, mountSceneStatusFeature, mountBrollFeature, mountBrollPanelStateFeature, mountScenesFeature, mountSceneMediaFeature, derivedRecordsPlan, mountOnboardingFeature, mountVideoFilesFeature, mountDesktopFeature, mountDraftsFeature, draftRecoveryPorts } from "../bootstrap/wiring.ts";
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
  init_00_prelude();
  mountSceneStatusFeature();
  mountHideShotFeature();
  init_02_state();
  init_02b_doc_id();
  init_02c_blobs();
  init_02d_gallery();
  init_03_sync();
  init_03a_history_store();
  init_03b_side_panels();
  init_04_richtext();
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
  init_08_production_panels();
  mountBrollFeature();
  mountBrollPanelStateFeature();
  mountFindFeature();
  mountCommentsLogicFeature();
  init_11_import();
  init_12_dirty_toast();
  init_13_hosted();
  init_13a_presence();
  init_13b_collaborate();
  init_14_export();
  init_14b_export_kit();
  init_18_local_files();
  init_18a_local_merge();
  init_18b_file_menu();
  mountFileMenuExportFeature();
  init_18d_command_menu();
  init_19_writer();
  init_20_teleprompter();
  init_20a_update();
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
