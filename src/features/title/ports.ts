import type { NoticePort } from "../../application/effects/ports.ts";
import type { DocumentPlace } from "../../application/location/document-place.ts";
import type { PreferenceChange, Preferences } from "../../application/preferences/preferences.ts";
import type { DraftsMount } from "../../application/recovery/drafts-ports.ts";
import type { AutoSavePolicy } from "../../application/save/autosave.ts";
import type { SaveChange, SaveState } from "../../application/save/save-state.ts";
import type { AutoSaveTarget } from "../../application/save/status.ts";
import type { LocationChange } from "../../application/location/document-location.ts";
import type { ServerStatusChange } from "../../application/location/server-status.ts";

export interface SaveStatusAutoSave {
  readonly policy: () => Pick<AutoSavePolicy, "halted" | "enabled">;
  readonly target: () => AutoSaveTarget;
}

export interface DocumentIdentitySync {
  readonly sync: () => void;
}

export interface SaveStatusPorts {
  readonly saves: Pick<SaveState, "busy" | "unsaved">;
  readonly autoSave: SaveStatusAutoSave;
  readonly place: Pick<DocumentPlace, "home" | "sessionExpired" | "linkTurnedOff">;
  readonly preferences: Pick<Preferences, "clock" | "nameOf">;
  readonly notices: Pick<NoticePort, "show">;
  readonly drafts: Pick<DraftsMount, "noteChange">;
  readonly identity: DocumentIdentitySync;
}

export interface SaveStatusListeners {
  readonly paint: () => void;
  readonly save: (change: SaveChange) => void;
  readonly location: (change: LocationChange) => void;
  readonly status: (change: ServerStatusChange) => void;
  readonly preference: (change: PreferenceChange) => void;
}

export interface SaveStatusMount {
  readonly refresh: () => void;
  readonly listeners: () => SaveStatusListeners;
  readonly dispose: () => void;
}
