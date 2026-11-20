import { applyUpdate } from "yjs";
import type { openNativeSession } from "./session.ts";

const PEER = Symbol("native-per-test-peer");

export function applyNativePeerUpdate(target: ReturnType<typeof openNativeSession>, bytes: Uint8Array): boolean {
  if (!target.acceptsPeerUpdate()) return false;
  applyUpdate(target.ydoc, bytes, PEER);
  return true;
}
