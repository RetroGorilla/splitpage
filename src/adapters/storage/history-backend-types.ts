import type { HistorySnapshotMeta, HistorySnapshotRead, HistoryWriteResult } from "../../application/recovery/history-ports.ts";

export interface HistoryIndexRecord {
  [key: string]: unknown;
  title?: string;
  lastOpenedAt?: number;
  migratedAt?: number;
  expiresAt?: number;
  snapshots: (HistorySnapshotMeta & { sha: string })[];
}

export type HistoryIndex = Record<string, HistoryIndexRecord>;

export interface HistoryBackendTransaction {
  readonly list: () => Promise<HistoryIndex>;
  readonly get: (sha: string) => Promise<string | null>;
  readonly put: (sha: string, text: string) => Promise<void>;
  readonly commit: (changes: Record<string, HistoryIndexRecord | null>, dropped: string[]) => Promise<void>;
}

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
  usage?: HistoryStoreUsage | null;
}

export interface HistoryOlderImportResult {
  ok: boolean;
  count: number;
  added: number;
  code?: string;
}

export interface HistoryBackendDoc {
  title: string;
  lastOpenedAt: number;
  docId?: string;
  count?: number;
  bytes?: number;
  migratedAt?: number;
  expiresAt?: number;
}

export interface HistoryBackendAdapter {
  name: string;
  persistent: boolean;
  readonly put: (docId: string, meta: unknown, stateJson: string) => Promise<HistoryWriteResult & { evicted?: number; overCap?: boolean }>;
  readonly list: (docId?: string | null, opts?: { strict?: boolean }) => Promise<HistoryBackendList | null>;
  readonly get: (bucket: string, id: string) => Promise<HistorySnapshotRead | null>;
  readonly copy: (from: string, to: string) => Promise<{ ok: boolean; copied: number; code?: string | undefined }>;
  readonly touch: (docId: string, title: string) => Promise<unknown>;
  readonly importOlder: (entries: HistorySnapshotRead[]) => Promise<HistoryOlderImportResult>;
  readonly evict: (cap?: number) => Promise<unknown>;
  readonly rawDocIds: () => Promise<string[] | null>;
  readonly rawDoc: (bucket: string) => Promise<HistoryBackendDoc | null>;
  readonly rawList: (bucket: string) => Promise<HistorySnapshotMeta[]>;
}
