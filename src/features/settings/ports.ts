import type { ActionRegistry } from "../../application/actions.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { PreferenceChanges, PreferenceName, Preferences } from "../../application/preferences/preferences.ts";
import type { ScreenState } from "../../application/screen.ts";

export interface SettingsControls {
  readonly openSettings: (input?: unknown) => void;
}

export interface SettingsMount extends SettingsControls {
  readonly dispose: () => void;
}

export interface SettingsActionPorts {
  readonly screen: () => ScreenState;
}

export interface SettingsPorts {
  readonly actions: Pick<ActionRegistry, "invoke" | "view">;
  readonly notices: Pick<NoticePort, "show">;
  readonly changes: PreferenceChanges;
  readonly elsewhere: (listener: (name: PreferenceName | null) => void) => () => void;
  readonly preferences: Pick<Preferences,
    "theme" | "setTheme" | "clock" | "setClock" | "scriptScale" | "setScriptScale" |
    "rundownMin" | "setRundownMin" | "tagIcons" | "setTagIcons" | "hideShot" |
    "autosave" | "videoThumbs" | "setVideoThumbs" | "defaultWpm" | "setDefaultWpm" |
    "prompterFlag" | "setMyColor" | "setCommentAuthor" | "setCollabServer" |
    "announceTaggingHelp" | "resetTour" | "resetDesktopNotice">;
  readonly editor: {
    readonly writerSize: () => number | null;
    readonly setWriterSize: (size: number, persist: boolean) => void;
    readonly hideShot: (on: boolean) => void;
    readonly autoSave: (on: boolean) => void;
  };
  readonly identity: {
    readonly name: () => string;
    readonly swatchesHtml: (name: string, group: string, label: string) => string;
  };
  readonly prompter: {
    readonly mirror: (on: boolean) => void;
    readonly flip: (on: boolean) => void;
    readonly sceneMode: (on: boolean) => void;
  };
  readonly collaboration: {
    readonly defaultServer: string;
    readonly view: () => { servedHere: boolean; label: string; signedIn: boolean; isDefault: boolean };
    readonly normalize: (address: string) => string | null;
    readonly address: () => string;
    readonly signOut: () => void;
  };
  readonly desktop: {
    readonly running: () => boolean;
    readonly renderNotice: () => void;
  };
}
