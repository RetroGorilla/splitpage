import type { IdSource } from "../../core/document/ports.ts";
import type { HistoryOwner, HistorySnapshotReply } from "../../application/recovery/history-ports.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { SessionMergeOwner, SnapshotRestoreRequest, SnapshotRestoreResult } from "../../application/session/session-merge-ports.ts";
import type { SidePanels } from "../../application/side-panels.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { Preferences } from "../../application/preferences/preferences.ts";
import type { PersonColorLookup } from "../../core/document/person-colors.ts";
import type { CapabilityPort } from "../../application/session/ports.ts";
import type { OfflineSavedBeat } from "../../application/collaboration/offline-clashes.ts";

export interface SharedHistoryVersion {
  readonly id: string;
  readonly at: number;
  readonly names: readonly string[];
}

export interface SharedHistoryPreview {
  readonly title: string;
  readonly outline: readonly ({ readonly heading: string } | { readonly beat: OfflineSavedBeat })[];
  readonly loadPictures: (signal: AbortSignal) => Promise<void>;
  readonly saveCopy: (signal: AbortSignal) => Promise<boolean>;
}

export interface SharedHistorySource {
  readonly online: () => boolean;
  readonly list: (signal: AbortSignal) => Promise<readonly SharedHistoryVersion[]>;
  readonly read: (id: string, signal: AbortSignal) => Promise<SharedHistoryPreview>;
  readonly putBack: (beat: OfflineSavedBeat) => boolean;
}

export interface SharedHistoryPanelPort {
  readonly active: () => boolean;
  readonly current: () => SharedHistorySource | null;
  readonly onChange: (listener: () => void) => () => void;
}

export interface HistoryPanelPorts {
  readonly capability: Pick<CapabilityPort, "history">;
  readonly ids: Pick<IdSource, "id">;
  readonly history: Pick<HistoryOwner, "listDocHistory">;
  readonly document: Pick<DocumentReader, "current">;
  readonly merge: Pick<SessionMergeOwner, "restoreMergeSnapshot">;
  readonly panels: Pick<SidePanels, "open" | "close">;
  readonly effects: Pick<NoticePort, "show">;
  readonly preferences: Pick<Preferences, "clock"> & { readonly editorName: () => string };
  readonly personColors: PersonColorLookup;
  readonly shared: SharedHistoryPanelPort | null;
}

export interface HistoryPanelControl {
  readonly openHistoryPanel: () => void;
  readonly closeHistoryPanel: () => void;
  readonly renderHistory: () => Promise<void>;
  readonly restoreSnapshotFromCard: (button: Element | null) => Promise<SnapshotRestoreResult> | undefined;
  readonly handleSharedClick: (event: MouseEvent) => boolean;
  readonly toastLastEditor: (loaded: Readonly<Record<string, unknown>>) => void;
  readonly restored: (snapshot: HistorySnapshotReply, request: SnapshotRestoreRequest) => void;
  readonly dispose: () => void;
}
