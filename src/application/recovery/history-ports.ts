import type { DocumentReader } from "../session/document-reader.ts";
import type { DocumentLocation } from "../location/document-location.ts";
import type { SaveCoordinator } from "../save/coordinator.ts";
import type { NoticePort } from "../effects/ports.ts";
import type { PictureStore } from "../media/picture-store.ts";
import type { IdSource } from "../../core/document/ports.ts";
import type { SeedCheck } from "../preferences/seed-check.ts";
import type { LegacySnapshots } from "./legacy-snapshots.ts";
import type { sanitizeHistoryMeta } from "../../../shared/history-policy.js";

export type HistorySnapshotMeta = NonNullable<ReturnType<typeof sanitizeHistoryMeta>> & { docId?: string; status?: string };

export interface HistoryWriteResult {
  readonly stored: boolean;
  readonly code?: string;
  readonly duplicate?: boolean;
}

export interface HistorySnapshotRead {
  readonly meta: HistorySnapshotMeta;
  readonly stateJson: string;
}

export interface HistoryBundleData {
  readonly docs: readonly unknown[];
  readonly older: readonly unknown[];
  readonly blobs?: Record<string, unknown>;
  readonly missingBlobs?: readonly string[];
  readonly truncated?: boolean;
}

export interface HistoryImportResult {
  readonly docs: number;
  readonly added: number;
  readonly skipped: number;
  readonly failed: number;
  readonly older: number;
  readonly capped: number;
  readonly code?: string;
  readonly blobs: { stored: number; refused: string[]; failed: string[]; ignored: number };
}

export interface HistoryTestControls {
  readonly idle: () => Promise<unknown>;
  readonly forceBackend: (name: string | null) => Promise<string>;
  readonly injectFault: (name: string | null) => string | null;
  readonly releaseDelayedPut: () => void;
  readonly releaseDelayedImport: () => void;
  readonly importGateHit: () => boolean;
  readonly setNow: (ms: number | null) => number;
  readonly setCapOverride: (bytes: number | null) => number | null;
  readonly pending: (docId?: string) => readonly { docId: string; id: string; label: string; status: string }[];
  readonly resetForTest: () => Promise<boolean>;
}

export interface HistoryOwner {
  readonly startHistory: (ports: HistoryOwnerPorts) => () => Promise<void> | undefined;
  readonly isPristineSeedDocument: () => boolean;
  readonly onHistoryChange: (listener: () => void) => () => void;
  readonly captureSnapshot: (label: string, src: unknown, opts?: { allowSeedSkip?: boolean }) => { id: string; docId: string; done: Promise<HistoryWriteResult> } | null;
  readonly protectHistorySnapshot: (query: { id?: string; docId?: string; older?: boolean }) => () => void;
  readonly listDocHistory: (docId?: string | null) => Promise<{ entries: HistorySnapshotMeta[]; older: HistorySnapshotMeta[]; olderExpiresAt: number | null; backend: string | null; persistent: boolean; usage: unknown; notice: string | null }>;
  readonly getHistorySnapshot: (query: { id?: string; docId?: string; older?: boolean }) => Promise<HistorySnapshotRead | null>;
  readonly historyDocumentChanged: () => void;
  readonly copyHistory: (from: string, to: string) => Promise<{ ok: boolean; copied: number; code?: string }>;
  readonly exportHistoryAll: () => Promise<HistoryBundleData>;
  readonly importHistoryBundle: (bundle: unknown) => Promise<HistoryImportResult>;
  readonly normalizeLegacySnapshots: (raw: unknown) => HistorySnapshotRead[] | null;
  readonly startHistoryMigration: () => Promise<{ migrated: number; removedKey: boolean }>;
  readonly testControls: () => HistoryTestControls;
}

export interface DesktopHistoryOptions {
  readonly protect?: readonly { docId: string; id: string }[];
  readonly older?: boolean;
}

export interface HistoryDesktopPort {
  readonly historyPut: (docId: string | null, meta: unknown, stateJson: string, opts?: DesktopHistoryOptions) => Promise<unknown>;
  readonly historyList: (docId: string | null) => Promise<unknown>;
  readonly historyGet: (query: unknown, snapshotId: string) => Promise<unknown>;
  readonly historyCopy: (fromDocId: string, toDocId: string) => Promise<unknown>;
  readonly historyTouch: (docId: string, title: string) => Promise<unknown>;
  readonly historyListDocs: () => Promise<unknown>;
}

export interface HistoryDesktopAccess {
  readonly history: () => HistoryDesktopPort | null;
  readonly running: () => boolean;
}

export interface HistoryBackendOptions {
  readonly desktop: HistoryDesktopAccess["history"];
  readonly runningOnDesktop: HistoryDesktopAccess["running"];
  readonly now: () => number;
  readonly holds: () => { docId: string; id: string }[];
}

export interface HistoryOwnerPorts {
  readonly document: Pick<DocumentReader, "current">;
  readonly location: Pick<DocumentLocation, "home">;
  readonly preferences: { readonly editorName: () => string };
  readonly saving: Pick<SaveCoordinator<unknown, unknown>, "changes" | "unsaved">;
  readonly recovery: Pick<LegacySnapshots, "readRaw" | "remove">;
  readonly effects: Pick<NoticePort, "show">;
  readonly pictures: Pick<PictureStore, "intern" | "persist" | "recordFor" | "ensureBytes" | "dataUrlFor">;
  readonly inlinePictures: (json: string, shas: readonly string[]) => string;
  readonly ids: Pick<IdSource, "id" | "docId">;
  readonly seed: SeedCheck;
  readonly logger: { readonly error: (...values: unknown[]) => void; readonly warn: (...values: unknown[]) => void };
  readonly now: () => number;
  readonly decodeBase64: (text: string) => string;
  readonly yield: () => Promise<void>;
  readonly desktop: HistoryDesktopAccess;
  readonly storage: (options: HistoryBackendOptions) => HistoryStorage;
}

export interface HistoryStorage {
  readonly resolveHistoryBackend: () => Promise<unknown>;
  readonly historyIdbNotice: () => { kind: string; text: string } | null;
  readonly backendName: () => string | null;
  readonly close: () => Promise<unknown>;
  readonly prepareResetForTest: () => void;
  readonly reset: () => Promise<unknown>;
  readonly controls: Pick<HistoryTestControls, "forceBackend" | "injectFault" | "releaseDelayedPut" | "releaseDelayedImport" | "importGateHit" | "setCapOverride">;
}
