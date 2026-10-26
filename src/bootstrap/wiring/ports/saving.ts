import type { Operations } from "../../../application/session/operation.ts";
import type { SaveConfirmation, SaveState } from "../../../application/save/save-state.ts";
import { autoSavePolicy, confirmSavedNow, onSaveChange, resumeAutoSave, saveBusy, setAutoSaveEnabled, unsavedChanges } from "../../../legacy/save-bridge.ts";
import { captureOperation, stillOwns } from "../../../legacy/transition-bridge.ts";

export const saves: SaveState = {
  unsaved: () => unsavedChanges(),
  busy: () => saveBusy(),
  onChange: (listener) => onSaveChange(listener),
  dueNow: () => { autoSavePolicy().dueNow(); },
  resume: () => { resumeAutoSave(); },
  setAutoSaveEnabled: (on) => { setAutoSaveEnabled(on); }
};

export const ownership: Operations = { capture: captureOperation, stillOwns };

export const confirmation: SaveConfirmation = { confirmSavedNow: () => { confirmSavedNow(); } };
