import type { HistorySnapshotMeta, HistorySnapshotRead, HistorySnapshotReply, HistoryWriteResult } from "../../application/recovery/history-ports.ts";
import type { SharedHistoryBucket, SharedHistoryIndex, SharedHistoryTransaction } from "../../../shared/history-store.ts";

export type HistoryIndexRecord = SharedHistoryBucket;
export type HistoryIndex = SharedHistoryIndex;
export type HistoryBackendTransaction = SharedHistoryTransaction;

export interface HistoryFaultBackend {
  readonly failNext: (op: "put" | "commit", code: string, times?: number) => void;
  readonly clearFaults: () => void;
}

export interface HistoryStoreUsage {
  totalBytes: number;
  capBytes: number;
  overCap: boolean;
  docCount: number;
  readOnly: boolean;
}

export interface HistoryBackendList {
  entries: HistorySnapshotMeta[];
  older: HistorySnapshotMeta[];
  olderExpiresAt: number | null;
  damaged?: number;
  olderDamaged?: number;
  usage?: HistoryStoreUsage | null;
}

export interface HistoryOlderImportResult {
  ok: boolean;
  count: number;
  added: number;
  code?: string;
}

export interface HistoryBackendDoc {
  damaged?: number;
  title: unknown;
  lastOpenedAt: number;
  docId?: string;
  count?: number;
  bytes?: number;
  migratedAt?: unknown;
  expiresAt?: unknown;
}

export interface HistoryBackendAdapter {
  name: string;
  persistent: boolean;
  readonly put: (docId: string, meta: unknown, stateJson: string) => Promise<HistoryWriteResult & { evicted?: number; overCap?: boolean }>;
  readonly list: (docId?: string | null, opts?: { strict?: boolean }) => Promise<HistoryBackendList | null>;
  readonly get: (bucket: string, id: string) => Promise<HistorySnapshotReply | null>;
  readonly copy: (from: string, to: string) => Promise<{ ok: boolean; copied: number; code?: string | undefined }>;
  readonly touch: (docId: string, title: string) => Promise<unknown>;
  readonly importOlder: (entries: HistorySnapshotRead[]) => Promise<HistoryOlderImportResult>;
  readonly evict: (cap?: number) => Promise<unknown>;
  readonly rawDocIds: () => Promise<string[] | null>;
  readonly rawDoc: (bucket: string) => Promise<HistoryBackendDoc | null>;
  readonly rawList: (bucket: string) => Promise<HistorySnapshotMeta[]>;
}
