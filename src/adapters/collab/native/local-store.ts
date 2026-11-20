import type { openNativeSession, NativeSessionOptions } from "./session.ts";

export type NativeLocalStoreFailure = {
  readonly kind: "failed";
  readonly reason: "locked" | "blocked" | "quota" | "closed" | "version" | "unavailable" | "io";
  readonly error?: unknown;
};

export type NativeLocalStoreReceipt = { readonly kind: "stored" } | NativeLocalStoreFailure;

export type NativeLocalStoreOpen = NativeLocalStoreFailure | {
  readonly kind: "opened";
  readonly restored: boolean;
  readonly session: ReturnType<typeof openNativeSession>;
  readonly persistent: Promise<boolean>;
  readonly flush: () => Promise<NativeLocalStoreReceipt>;
  readonly subscribe: (listener: (receipt: NativeLocalStoreReceipt) => void) => () => void;
  readonly closed: Promise<NativeLocalStoreReceipt>;
};

export interface NativeLocalStore {
  readonly open: (name: string, options: NativeSessionOptions) => Promise<NativeLocalStoreOpen>;
  readonly delete: (name: string) => Promise<NativeLocalStoreReceipt>;
}
