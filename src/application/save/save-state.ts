import type { AutoSaveChange } from "./autosave.ts";
import type { SaveStatusChange } from "./coordinator.ts";

export type SaveChange = SaveStatusChange | AutoSaveChange;

export interface SaveState {
  readonly unsaved: () => boolean;
  readonly busy: () => boolean;
  readonly onChange: (listener: (change: SaveChange) => void) => () => void;
  readonly dueNow: () => void;
  readonly resume: () => void;
  readonly setAutoSaveEnabled: (on: boolean) => void;
}
