import type { DesktopIpcArgs, DesktopIpcResult } from "../../../shared/desktop-contract.d.ts";
import type { DocumentReader } from "../session/document-reader.ts";
import type { DocumentLocation } from "../location/document-location.ts";
import type { SaveCoordinator } from "../save/coordinator.ts";
import type { NoticePort } from "../effects/ports.ts";
import type { PictureStore } from "../media/picture-store.ts";
import type { IdSource } from "../../core/document/ports.ts";
import type { SeedCheck } from "../preferences/seed-check.ts";
import type { LegacySnapshots } from "./legacy-snapshots.ts";
import type { sanitizeHistoryMeta } from "../../../shared/history-policy.ts";
import type { createHistoryStore } from "../../../shared/history-store.ts";

export type HistorySnapshotMeta = Omit<NonNullable<ReturnType<typeof sanitizeHistoryMeta>>, "id"> & { id: string; docId?: string; status?: string };

export interface HistoryWriteResult {
  readonly stored: boolean;
  readonly code?: string;
  readonly duplicate?: boolean;
}

export interface HistorySnapshotRead {
  readonly meta: HistorySnapshotMeta;
  readonly stateJson: string;
}
export type HistorySnapshotReply = Omit<NonNullable<Awaited<ReturnType<ReturnType<typeof createHistoryStore>["get"]>>>, "meta"> & {
  readonly meta?: HistorySnapshotMeta | null | undefined;
};

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
  readonly captureSnapshot: (label: string | undefined, src: unknown, opts?: { allowSeedSkip?: boolean }) => { id: string; docId: string; done: Promise<HistoryWriteResult> } | null;
  readonly protectHistorySnapshot: (query: { id?: string; docId?: string | null; older?: boolean }) => () => void;
  readonly listDocHistory: (docId?: string | null) => Promise<{ entries: HistorySnapshotMeta[]; older: HistorySnapshotMeta[]; olderExpiresAt: number | null; damaged?: number; olderDamaged?: number; backend: string | null; persistent: boolean; usage: unknown; notice: string | null }>;
  readonly getHistorySnapshot: (query: { id?: string; docId?: string | null; older?: boolean }) => Promise<HistorySnapshotReply | null>;
  readonly historyDocumentChanged: () => void;
  readonly copyHistory: (from: string, to: string) => Promise<{ ok: boolean; copied: number; code?: string }>;
  readonly exportHistoryAll: () => Promise<HistoryBundleData>;
  readonly importHistoryBundle: (bundle: unknown) => Promise<HistoryImportResult>;
  readonly normalizeLegacySnapshots: (raw: unknown) => HistorySnapshotRead[] | null;
  readonly startHistoryMigration: () => Promise<{ migrated: number; removedKey: boolean }>;
}

export interface DesktopHistoryOptions {
  readonly protect?: readonly { docId: string; id: string }[];
  readonly older?: boolean;
}

export interface HistoryDesktopPort {
  readonly historyPut: (docId: string | null, meta: unknown, stateJson: string, opts?: DesktopHistoryOptions) => Promise<DesktopIpcResult<"splitpage:history-put">>;
  readonly historyList: (docId: string | null) => Promise<DesktopIpcResult<"splitpage:history-list">>;
  readonly historyGet: (query: DesktopIpcArgs<"splitpage:history-get">[0], snapshotId: string) => Promise<DesktopIpcResult<"splitpage:history-get">>;
  readonly historyCopy: (fromDocId: string, toDocId: string) => Promise<DesktopIpcResult<"splitpage:history-copy">>;
  readonly historyTouch: (docId: string, title: string) => Promise<DesktopIpcResult<"splitpage:history-touch">>;
  readonly historyListDocs: () => Promise<DesktopIpcResult<"splitpage:history-list-docs">>;
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
  readonly resolveHistoryBackend: () => Promise<HistoryResolvedBackend>;
  readonly historyIdbNotice: () => { kind: string; text: string } | null;
  readonly backendName: () => string | null;
  readonly close: () => Promise<void>;
}

export interface HistoryTestingStorage extends HistoryStorage {
  readonly prepareResetForTest: () => void;
  readonly reset: () => Promise<unknown>;
  readonly controls: Pick<HistoryTestControls, "forceBackend" | "injectFault" | "releaseDelayedPut" | "releaseDelayedImport" | "importGateHit" | "setCapOverride">;
}

export interface HistoryResolvedBackend {
  name: string;
  persistent: boolean;
  readonly put: (docId: string, meta: HistorySnapshotMeta, stateJson: string) => Promise<HistoryWriteResult>;
  readonly list: (docId: string | null, options?: { strict?: boolean }) => Promise<{
    entries: HistorySnapshotMeta[];
    older: HistorySnapshotMeta[];
    olderExpiresAt: number | null;
    damaged?: number;
    olderDamaged?: number;
    usage?: unknown;
  } | null>;
  readonly get: (bucket: string, id: string) => Promise<HistorySnapshotReply | null>;
  readonly touch: (docId: string, title: string) => Promise<unknown>;
  readonly copy: (from: string, to: string) => Promise<{ ok: boolean; copied: number; code?: string | undefined }>;
  readonly rawDocIds: () => Promise<string[] | null>;
  readonly rawDoc: (bucket: string) => Promise<{ title: unknown; lastOpenedAt: number } | null>;
  readonly rawList: (bucket: string) => Promise<HistorySnapshotMeta[]>;
  readonly importOlder: (entries: HistorySnapshotRead[]) => Promise<{ ok: boolean; added: number; code?: string }>;
  readonly evict: (cap: number) => Promise<unknown>;
  readonly store?: {
    readonly rawIndex: ReturnType<typeof createHistoryStore>["rawIndex"];
    readonly backend: {
      readonly bodyCount: () => number | Promise<number>;
      readonly hasBody: (sha: string) => boolean | Promise<boolean>;
      readonly inspect: () => unknown;
    };
  };
}
