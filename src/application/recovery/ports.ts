import type { OperationContext } from "../session/operation.ts";

export interface DraftWrite {
  readonly key: string;
  readonly base?: string | undefined;
  readonly docId?: string | undefined;
  readonly rev?: number | undefined;
  readonly title?: string | undefined;
  readonly writerId?: string | undefined;
  readonly generation?: number | undefined;
  readonly editSeq?: number | undefined;
  readonly schema?: unknown;
  readonly docIdWrittenOut?: boolean | undefined;
  readonly stateJson: string;
  readonly baseJson?: string | null | undefined;
}

export interface DraftMeta {
  readonly key: string;
  readonly base: string;
  readonly docId: string;
  readonly rev: number;
  readonly title: string;
  readonly writtenAt: number;
  readonly writerId: string;
  readonly generation: number;
  readonly editSeq: number;
  readonly schema: unknown;
  readonly docIdWrittenOut: boolean;
  readonly bytes: number;
}

export interface StoredDraft extends DraftMeta {
  readonly stateJson: string;
  readonly baseJson: string | null;
}

export type DraftPutResult =
  | { readonly ok: true; readonly evicted: number }
  | { readonly ok: false; readonly code: string };

export interface DraftPutOptions {
  readonly keepBase?: boolean | undefined;
}

export interface KeyedDraftStore {
  readonly available: () => Promise<boolean>;
  readonly put: (rec: DraftWrite, opts?: DraftPutOptions) => Promise<DraftPutResult>;
  readonly get: (key: string) => Promise<StoredDraft | null>;
  readonly list: () => Promise<DraftMeta[]>;
  readonly remove: (key: string, writerId?: string, generation?: number) => Promise<boolean>;
  readonly claim: (key: string, writerId: string, generation?: number) => Promise<boolean>;
}

export interface DraftLimits {
  readonly maxAgeMs: number;
  readonly maxCount: number;
  readonly maxBytes: number;
}

export interface DesktopDraftResult {
  readonly ok?: boolean;
  readonly code?: string;
}

export interface DesktopDraftStore {
  readonly writable: () => boolean;
  readonly canDiscard: () => boolean;
  readonly write: (payload: unknown) => Promise<DesktopDraftResult | null | undefined>;
  readonly discard: (seq: number) => Promise<DesktopDraftResult | null | undefined>;
}

export interface DraftOwnershipPort {
  readonly capture: () => OperationContext;
  readonly stillOwns: (ctx: OperationContext) => boolean;
}
