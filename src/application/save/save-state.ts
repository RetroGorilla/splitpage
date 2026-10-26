import type { AutoSaveChange, AutoSavePolicy } from "./autosave.ts";
import type { SaveStatusChange } from "./coordinator.ts";
import type { AutoSaveTarget } from "./status.ts";

export type SaveChange = SaveStatusChange | AutoSaveChange;

export interface SaveConfirmation {
  readonly confirmSavedNow: () => void;
}

export interface AutoSaveReads {
  readonly policy: () => AutoSavePolicy;
  readonly target: () => AutoSaveTarget;
}

export interface SaveState {
  readonly unsaved: () => boolean;
  readonly busy: () => boolean;
  readonly onChange: (listener: (change: SaveChange) => void) => () => void;
  readonly dueNow: () => void;
  readonly resume: () => void;
  readonly setAutoSaveEnabled: (on: boolean) => void;
}
