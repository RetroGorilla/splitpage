import type { SaveOwnershipPort } from "../../../application/save/coordinator.ts";
import type { SaveState } from "../../../application/save/save-state.ts";
import { autoSavePolicy, onSaveChange, resumeAutoSave, saveBusy, setAutoSaveEnabled, unsavedChanges } from "../../../legacy/save-bridge.ts";
import { captureOperation, stillOwns } from "../../../legacy/transition-bridge.ts";

export const saves: SaveState = {
  unsaved: () => unsavedChanges(),
  busy: () => saveBusy(),
  onChange: (listener) => onSaveChange(listener),
  dueNow: () => { autoSavePolicy().dueNow(); },
  resume: () => { resumeAutoSave(); },
  setAutoSaveEnabled: (on) => { setAutoSaveEnabled(on); }
};

export const ownership: SaveOwnershipPort = { capture: captureOperation, stillOwns };
