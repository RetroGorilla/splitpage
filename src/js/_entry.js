import { __init as init_00_prelude } from "./00-prelude.js";
import { __init as init_01_scene_status } from "./01-scene-status.js";
import { __init as init_01b_hide_shot } from "./01b-hide-shot.js";
import { __init as init_02_state } from "./02-state.js";
import { __init as init_02b_doc_id } from "./02b-doc-id.js";
import { __init as init_02c_blobs } from "../adapters/storage/02c-blobs.js";
import { __init as init_02d_gallery } from "../adapters/storage/02d-gallery.js";
import { __init as init_03_sync } from "./03-sync.js";
import { __init as init_03a_history_store } from "./03a-history-store.js";
import { __init as init_03b_side_panels } from "./03b-side-panels.js";
import { __init as init_04_richtext } from "./04-richtext.js";
import { __init as init_04c_doc_model } from "./04c-doc-model.js";
import { __init as init_05_render } from "./05-render.js";
import { __init as init_05c_clipboard } from "./05c-clipboard.js";
import { __init as init_05d_draft_edit } from "./05d-draft-edit.js";
import { __init as init_05e_gallery_overlay } from "./05e-gallery-overlay.js";
import { __init as init_05f_rundown } from "./05f-rundown.js";
import { __init as init_05g_scene_clip } from "./05g-scene-clip.js";
import { __init as init_05h_scene_select } from "./05h-scene-select.js";
import { __init as init_05p_rundown_presence } from "./05p-rundown-presence.js";
import { __init as init_05r_read_time } from "./05r-read-time.js";
import { __init as init_05s_script_zoom } from "../features/script-zoom/script-zoom.js";
import { __init as init_05t_target } from "./05t-target.js";
import { __init as init_05v_video } from "./05v-video.js";
import { __init as init_05w_annotate } from "./05w-annotate.js";
import { __init as init_06_rows } from "./06-rows.js";
import { __init as init_07_production_tags } from "./07-production-tags.js";
import { __init as init_07b_plain_tags } from "./07b-plain-tags.js";
import { __init as init_08_production_panels } from "./08-production-panels.js";
import { __init as init_08c_broll } from "./08c-broll.js";
import { __init as init_08d_broll_panel } from "./08d-broll-panel.js";
import { __init as init_09_find_replace } from "./09-find-replace.js";
import { __init as init_10_comments } from "./10-comments.js";
import { __init as init_11_import } from "./11-import.js";
import { __init as init_12_dirty_toast } from "./12-dirty-toast.js";
import { __init as init_12a_undo } from "./12a-undo.js";
import { __init as init_13_hosted } from "./13-hosted.js";
import { __init as init_13a_presence } from "./13a-presence.js";
import { __init as init_13b_collaborate } from "./13b-collaborate.js";
import { __init as init_14_export } from "./14-export.js";
import { __init as init_14b_export_kit } from "./14b-export-kit.js";
import { __init as init_18_local_files } from "./18-local-files.js";
import { __init as init_18a_local_merge } from "./18a-local-merge.js";
import { __init as init_18b_file_menu } from "./18b-file-menu.js";
import { __init as init_18c_export_dialog } from "./18c-export-dialog.js";
import { __init as init_18d_command_menu } from "./18d-command-menu.js";
import { __init as init_19_writer } from "./19-writer.js";
import { __init as init_20_teleprompter } from "./20-teleprompter.js";
import { __init as init_20a_update } from "./20a-update.js";
import { __init as init_20b_onboarding } from "./20b-onboarding.js";
import { __init as init_20c_help } from "./20c-help.js";
import { __init as init_20d_formats } from "./20d-formats.js";
import { __init as init_20e_connect } from "./20e-connect.js";
import { __init as init_20f_desktop } from "./20f-desktop.js";
import { __init as init_20g_drafts } from "./20g-drafts.js";
import { __init as init_20h_appdata } from "./20h-appdata.js";
import { __init as init_20j_newtab } from "./20j-newtab.js";
import { __init as init_20s_settings } from "./20s-settings.js";
import { migrateRows } from "./02-state.js";
import { documentIdentityPort } from "./02b-doc-id.js";
import { documentDestinationPort, getEditorName, stampRow } from "./03-sync.js";
import { bulkTagCell, runIdleRefresh } from "./07-production-tags.js";
import { derivedRecordsPlan } from "./08c-broll.js";
import { legacySessionEffects } from "./12-dirty-toast.js";
import { legacyFileDestination, legacySavePorts } from "./14-export.js";
import { serverSaveDestination } from "./13-hosted.js";
import { draftRecoveryPorts } from "./20g-drafts.js";
import { wireApp } from "../bootstrap/wiring.ts";
import { startAppWhenReady } from "../bootstrap/app.ts";

var wiring = null;
try {
  wiring = wireApp({
    entry: migrateRows,
    effects: legacySessionEffects(),
    editorName: getEditorName,
    refresh: runIdleRefresh,
    records: derivedRecordsPlan,
    bulkTags: { cell: bulkTagCell, stamp: stampRow },
    saves: legacySavePorts,
    destinations: function () { return [legacyFileDestination(), serverSaveDestination()]; },
    transitions: { destination: documentDestinationPort, identity: documentIdentityPort },
    recovery: draftRecoveryPorts,
    keyTarget: window
  });
} catch (error) {
  console.error(error);
}
if (wiring) {
  init_00_prelude();
  init_01_scene_status();
  init_01b_hide_shot();
  init_02_state();
  init_02b_doc_id();
  init_02c_blobs();
  init_02d_gallery();
  init_03_sync();
  init_03a_history_store();
  init_03b_side_panels();
  init_04_richtext();
  init_04c_doc_model();
  init_05_render();
  init_05c_clipboard();
  init_05d_draft_edit();
  init_05e_gallery_overlay();
  init_05f_rundown();
  init_05g_scene_clip();
  init_05h_scene_select();
  init_05p_rundown_presence();
  init_05r_read_time();
  init_05s_script_zoom();
  init_05t_target();
  init_05v_video();
  init_05w_annotate();
  init_06_rows();
  init_07_production_tags();
  init_07b_plain_tags();
  init_08_production_panels();
  init_08c_broll();
  init_08d_broll_panel();
  init_09_find_replace();
  init_10_comments();
  init_11_import();
  init_12_dirty_toast();
  init_12a_undo();
  init_13_hosted();
  init_13a_presence();
  init_13b_collaborate();
  init_14_export();
  init_14b_export_kit();
  init_18_local_files();
  init_18a_local_merge();
  init_18b_file_menu();
  init_18c_export_dialog();
  init_18d_command_menu();
  init_19_writer();
  init_20_teleprompter();
  init_20a_update();
  init_20b_onboarding();
  init_20c_help();
  init_20d_formats();
  init_20e_connect();
  init_20f_desktop();
  init_20g_drafts();
  init_20h_appdata();
  init_20j_newtab();
  init_20s_settings();
  startAppWhenReady(document, wiring);
}
