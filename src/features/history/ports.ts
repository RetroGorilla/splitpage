import type { IdSource } from "../../core/document/ports.ts";
import type { HistoryOwner, HistorySnapshotRead } from "../../application/recovery/history-ports.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { SessionMergeOwner, SnapshotRestoreRequest, SnapshotRestoreResult } from "../../application/session/session-merge-ports.ts";
import type { SidePanels } from "../../application/side-panels.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { Preferences } from "../../application/preferences/preferences.ts";
import type { Presence } from "../../application/collaboration/presence.ts";

export interface HistoryPanelPorts {
  readonly ids: Pick<IdSource, "id">;
  readonly history: Pick<HistoryOwner, "listDocHistory">;
  readonly document: Pick<DocumentReader, "current">;
  readonly merge: Pick<SessionMergeOwner, "restoreMergeSnapshot">;
  readonly panels: Pick<SidePanels, "open" | "close">;
  readonly effects: Pick<NoticePort, "show">;
  readonly preferences: Pick<Preferences, "clock"> & { readonly editorName: () => string };
  readonly presence: Pick<Presence, "personColor">;
}

export interface HistoryPanelControl {
  readonly openHistoryPanel: () => void;
  readonly renderHistory: () => Promise<void>;
  readonly restoreSnapshotFromCard: (button: Element | null) => Promise<SnapshotRestoreResult> | undefined;
  readonly toastLastEditor: (loaded: Readonly<Record<string, unknown>>) => void;
  readonly restored: (snapshot: HistorySnapshotRead, request: SnapshotRestoreRequest) => void;
  readonly dispose: () => void;
}
