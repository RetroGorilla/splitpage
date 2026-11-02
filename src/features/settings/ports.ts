import type { CommentSorting } from "../../application/comment-sort.ts";
import type { LaunchFacts } from "../../application/desktop-presence.ts";
import type { FileDelivery } from "../../application/files/file-delivery.ts";
import type { ActionRegistry } from "../../application/actions.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { PreferenceChanges, PreferenceName, Preferences } from "../../application/preferences/preferences.ts";
import type { ScreenState } from "../../application/screen.ts";
import type { SettingsControls } from "../../application/settings-actions.ts";

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
    "prompterFlag" | "setMyColor" | "commentAuthor" | "setCommentAuthor" |
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
  readonly desktop: {
    readonly running: () => boolean;
    readonly renderNotice: () => void;
  };
}

export interface AppDataMount {
  readonly exportAppData: () => Promise<void> | undefined;
  readonly openImportAppData: () => void;
  readonly dispose: () => void;
}

interface AppDataHistoryExport {
  readonly omittedSnapshots?: number;
  readonly docs: readonly unknown[];
  readonly older: readonly unknown[];
  readonly blobs?: Record<string, unknown>;
  readonly missingBlobs?: readonly string[];
  readonly truncated?: boolean;
}

interface AppDataHistoryImport {
  readonly docs: number;
  readonly added: number;
  readonly older: number;
  readonly skipped: number;
  readonly failed: number;
  readonly code?: string;
  readonly blobs: {
    readonly stored: number;
    readonly refused: readonly unknown[];
    readonly failed: readonly unknown[];
  };
}

export interface AppDataPorts {
  readonly notices: Pick<NoticePort, "show" | "showAction">;
  readonly fileDelivery: FileDelivery;
  readonly preferences: Pick<Preferences, "appDataExport" | "appDataImport" | "commentsSort">;
  readonly desktop: () => boolean;
  readonly launchFacts: Pick<LaunchFacts, "appVersion">;
  readonly commentSorting: Pick<CommentSorting, "choose">;
  readonly history: {
    readonly exportAll: () => Promise<AppDataHistoryExport>;
    readonly importBundle: (bundle: { readonly docs: readonly unknown[]; readonly older: readonly unknown[]; readonly blobs: Record<string, unknown> | null }) => Promise<AppDataHistoryImport>;
    readonly normalizeSnapshots: (raw: string) => unknown[] | null;
  };
  readonly writer: {
    readonly size: () => number | null;
    readonly setSize: (size: number | null, persist: boolean) => void;
  };
  readonly embeddedVersion: () => string | null;
  readonly useBlobBackend: (backend: {
    readonly name?: string;
    readonly persistent?: boolean;
    readonly get: (sha: string) => Promise<{ bytes: Uint8Array; mime: string } | null>;
    readonly put: (sha: string, bytes: Uint8Array, mime: string) => Promise<unknown>;
    readonly missing: (shas: string[]) => Promise<string[]>;
  } | null) => void;
}

export interface AppDataActionPorts extends SettingsActionPorts {
  readonly importShown: () => boolean;
}
