export interface DesktopDraftResult {
  readonly ok?: boolean;
  readonly code?: string;
}

export interface DesktopDraftStore {
  readonly writable: () => boolean;
  readonly canDiscard: () => boolean;
  readonly write: (payload: unknown) => Promise<DesktopDraftResult | null | undefined>;
  readonly discard: (seq: number) => Promise<DesktopDraftResult | null | undefined>;
  readonly taker: () => (() => Promise<unknown>) | null;
  readonly restoreDone: (outcome: string) => void;
  readonly hasDraftToRestore: () => boolean;
}
