import type { openNativeSession, NativeSessionOptions } from "./session.ts";

export type NativeLocalStoreFailure = {
  readonly kind: "failed";
  readonly reason: "locked" | "blocked" | "quota" | "closed" | "version" | "unavailable" | "io";
  readonly error?: unknown;
};

export type NativeLocalStoreReceipt =
  | { readonly kind: "stored"; readonly generation: number }
  | (NativeLocalStoreFailure & { readonly generation: number; readonly committed: number; readonly operation?: "compact" });

export type NativeLocalStoreClose = NativeLocalStoreReceipt & { readonly state: Uint8Array };

export type NativeLocalStoreOpen = NativeLocalStoreFailure | {
  readonly kind: "opened";
  readonly restored: boolean;
  readonly generation: number;
  readonly session: ReturnType<typeof openNativeSession>;
  readonly persistent: Promise<boolean>;
  readonly flush: () => Promise<NativeLocalStoreReceipt>;
  readonly subscribe: (listener: (receipt: NativeLocalStoreReceipt) => void) => () => void;
  readonly closed: Promise<NativeLocalStoreClose>;
};

export interface NativeLocalStore {
  readonly open: (name: string, options: NativeSessionOptions) => Promise<NativeLocalStoreOpen>;
  readonly delete: (name: string) => Promise<{ readonly kind: "stored" } | NativeLocalStoreFailure>;
}
