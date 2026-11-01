import type { DesktopIpcResult } from "../../../shared/desktop-contract.d.ts";

export interface DesktopDraftStore {
  readonly writable: () => boolean;
  readonly canDiscard: () => boolean;
  readonly write: (payload: unknown) => Promise<DesktopIpcResult<"splitpage:draft-write">>;
  readonly discard: (seq: number) => Promise<DesktopIpcResult<"splitpage:draft-discard">>;
  readonly taker: () => (() => Promise<DesktopIpcResult<"splitpage:draft-take">>) | null;
  readonly restoreDone: (outcome: string) => void;
  readonly hasDraftToRestore: () => boolean;
}
