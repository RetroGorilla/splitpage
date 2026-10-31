import type { SessionMergeOwnerPorts } from "../../../application/session/session-merge-ports.ts";
import { heldDocument, holdMergeBase, noteAbsorbedDirty, noteDiskUpdate, noteMerged, noteRecovery } from "../session-owner.ts";
import { migrateRows, withDocumentPorts } from "../../document-ports.ts";
import { captureRestore, stillRestoring } from "../recovery-owners.ts";
import { autoSavePolicy, confirmBaseline, saveChanges } from "../save-owners.ts";
import { mergeUndo } from "../editor-owners.ts";
import { setHome } from "../location-owner.ts";
import { getEditorName } from "../preferences-owner.ts";
import { documentIdentityOwner } from "../document-identity.ts";
import { adoptRestoredState } from "../../startup/document-entry.js";
import { historyOwner } from "../history.ts";
import { documentReader } from "./document.ts";
import { text } from "./text.ts";
import { ids, clock } from "./identity.ts";
import { resetProductionPanel } from "./production.ts";

export function sessionMergeOwnerPorts(onRestored: SessionMergeOwnerPorts["onRestored"]): SessionMergeOwnerPorts {
  return {
    document: documentReader,
    session: { held: heldDocument, holdMergeBase, noteAbsorbedDirty, noteMerged, noteRecovery, noteDiskUpdate },
    entry: { migrate: migrateRows, withPorts: withDocumentPorts },
    text, ids, clock,
    preferences: { editorName: getEditorName },
    history: {
      captureSnapshot: (...args) => historyOwner().captureSnapshot(...args),
      getHistorySnapshot: (...args) => historyOwner().getHistorySnapshot(...args),
      protectHistorySnapshot: (...args) => historyOwner().protectHistorySnapshot(...args)
    },
    identity: { adoptRestoredState, noteMergedDocId: (previous) => { documentIdentityOwner().noteMergedDocId(previous); } },
    recovery: { capture: captureRestore, stillOwns: stillRestoring },
    saving: { changes: saveChanges, confirmBaseline },
    autoSave: { dueNow: () => { autoSavePolicy().dueNow(); } },
    location: { setHome },
    undo: { arm: (record) => { mergeUndo().arm(record); } },
    production: { reset: resetProductionPanel },
    onRestored
  };
}
