import type { DocumentReader } from "./document-reader.ts";
import type { DocumentMergePorts } from "./document-merge.ts";
import type { OperationContext, Operations } from "./operation.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { Clock, IdSource } from "../../core/document/ports.ts";
import type { StateField } from "../../core/document/fields.ts";
import type { MigratePorts } from "../../core/migrate.ts";
import type { LineShotIds } from "../../core/production/broll.ts";
import type { TextMergeContext } from "../../core/merge/text-field.ts";
import type { HistoryOwner, HistorySnapshotReply } from "../recovery/history-ports.ts";
import type { DocumentLocation } from "../location/document-location.ts";
import type { TextServices } from "../text/services.ts";
import type { SaveCoordinator } from "../save/coordinator.ts";
import type { AutoSavePolicy } from "../save/autosave.ts";
import type { DestinationPort, DocumentDestination, HistoryPort } from "../transitions/ports.ts";
import type { MergeUndo } from "./merge-undo.ts";
import type { DocumentIdentityOwner, IdentityEntry } from "../identity/ports.ts";
import type { DocumentSession } from "./document-session.ts";

export type SessionMergePorts = Omit<DocumentMergePorts<OperationContext>, "view">;

export interface SnapshotRestoreRequest {
  readonly older?: boolean;
  readonly force?: boolean;
  readonly local?: boolean;
  readonly restoredText?: string | undefined;
}

export type SnapshotRestoreResult = "busy" | "missing" | "changed" | "corrupt" | "no-backup" | "restored";

export interface SessionMergeSession {
  readonly held: () => ValidatedDocument | null;
  readonly holdMergeBase: (next: ValidatedDocument | null) => void;
  readonly noteMerged: DocumentSession["absorbMerged"];
  readonly noteRecovery: DocumentSession["absorbRecovery"];
  readonly noteDiskUpdate: DocumentSession["absorbDisk"];
  readonly noteAbsorbedDirty: DocumentSession["settle"];
}

export interface SessionMergeOwnerPorts {
  readonly document: Pick<DocumentReader, "current">;
  readonly session: SessionMergeSession;
  readonly entry: {
    readonly migrate: (raw: unknown, lines?: LineShotIds) => ValidatedDocument;
    readonly withPorts: <T>(fields: readonly StateField[], run: (ports: MigratePorts) => T) => T;
  };
  readonly text: Pick<TextServices, "fromHtml">;
  readonly ids: IdSource;
  readonly clock: Clock;
  readonly preferences: { readonly editorName: () => string };
  readonly history: Pick<HistoryOwner, "captureSnapshot" | "getHistorySnapshot" | "protectHistorySnapshot">;
  readonly identity: Pick<DocumentIdentityOwner, "noteMergedDocId"> & Pick<IdentityEntry, "adoptRestoredState">;
  readonly recovery: Operations;
  readonly saving: Pick<SaveCoordinator<unknown, unknown>, "changes" | "confirmBaseline">;
  readonly autoSave: Pick<AutoSavePolicy, "dueNow">;
  readonly location: Pick<DocumentLocation, "setHome">;
  readonly undo: Pick<MergeUndo, "arm">;
  readonly production: { readonly reset: () => void };
  readonly onRestored: (snapshot: HistorySnapshotReply, request: SnapshotRestoreRequest) => void;
}

export interface SessionMergeOwner {
  readonly startSessionMerge: (ports: SessionMergeOwnerPorts) => () => void;
  readonly stampRow: (row: object) => void;
  readonly sessionMergePorts: () => SessionMergePorts;
  readonly setBaseState: (next: unknown, why: string) => unknown;
  readonly baseStateReason: () => string;
  readonly textMergeContext: (base: unknown, mine: unknown, theirs: unknown, mergedTags?: unknown) => TextMergeContext;
  readonly restoreMergeSnapshot: (id: string, request?: SnapshotRestoreRequest) => Promise<SnapshotRestoreResult>;
  readonly documentDestinationPort: DestinationPort<DocumentDestination>;
  readonly documentHistoryPort: HistoryPort;
}
