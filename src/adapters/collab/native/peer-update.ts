import { applyUpdate } from "yjs";
import type { openNativeSession } from "./session.ts";

const PEER = Symbol("native-per-test-peer");

export function applyNativePeerUpdate(target: ReturnType<typeof openNativeSession>, bytes: Uint8Array): void {
  applyUpdate(target.ydoc, bytes, PEER);
}
