import type { HistoryOwner, HistoryResolvedBackend, HistorySnapshotMeta, HistoryStorage, HistoryTestControls } from "./history-ports.ts";

export interface HistoryPendingSnapshot {
  docId: string;
  meta: HistorySnapshotMeta;
  stateJson: string;
  status: string;
  refs?: string[];
}

export interface HistoryControlAccess {
  readonly storage: HistoryStorage;
  readonly resolve: () => Promise<HistoryResolvedBackend>;
  readonly idle: () => Promise<boolean>;
  readonly now: () => number;
  readonly localEntries: (docId?: string | null, status?: string) => HistoryPendingSnapshot[];
  readonly retry: () => void;
  readonly read: HistoryOwner["getHistorySnapshot"];
  readonly migrate: HistoryOwner["startHistoryMigration"];
  readonly importBundle: HistoryOwner["importHistoryBundle"];
  lastAt: number;
  local: Record<string, HistoryPendingSnapshot>;
  warned: Record<string, boolean>;
  retryQueued: boolean;
  protected: Record<string, number>;
}

export interface HistoryInstrumentedOwner extends HistoryOwner {
  readonly testControls: () => HistoryTestControls;
}

export interface HistoryInstrumentation {
  readonly clock: (now: () => number) => number;
  readonly capacity: (defaultCap: number) => number;
  readonly controls: (access: HistoryControlAccess) => HistoryTestControls;
  readonly expose: (running: () => { extensions: HistoryTestControls | null }) => Pick<HistoryInstrumentedOwner, "testControls">;
}
