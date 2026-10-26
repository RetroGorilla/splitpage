import type { Operations } from "../../../application/session/operation.ts";
import type { AutoSaveReads, SaveConfirmation, SaveState } from "../../../application/save/save-state.ts";
import type { SaveChangeNotes } from "../../../application/save/session-effects.ts";
import { autoSavePolicy, autoSaveTarget, confirmSavedNow, noteSaveChange, onSaveChange, resumeAutoSave, saveBusy, scheduleAutoSave, setAutoSaveEnabled, unsavedChanges } from "../../../legacy/save-bridge.ts";
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

export const saveChangeNotes: SaveChangeNotes = {
  noteChange: () => { noteSaveChange(); },
  scheduleAutoSave: () => { scheduleAutoSave(); }
};

export const autoSaves: AutoSaveReads = {
  policy: () => autoSavePolicy(),
  target: () => autoSaveTarget()
};
