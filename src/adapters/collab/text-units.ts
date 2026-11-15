import * as Y from "yjs";
import type { SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { readSharedPaintedText } from "./paint-base.ts";

function unitKey(ref: string): string {
  try {
    const value: unknown = JSON.parse(ref);
    const relative = value && typeof value === "object" ? (value as { readonly relative?: unknown }).relative : undefined;
    const item = Array.isArray(relative) ? Y.decodeRelativePosition(Uint8Array.from(relative as number[])).item : null;
    if (item) return item.client + ":" + item.clock;
  } catch { return ref; }
  return ref;
}

export function readSharedTextUnits(handle: SharedDocumentHandle, address: SharedTextAddress): readonly string[] | null {
  const painted = readSharedPaintedText(handle, address);
  if (!painted) return null;
  return Array.from({ length: painted.text.length }, (_, index) => {
    const ref = painted.identity(index);
    return ref === null ? "" : unitKey(ref);
  });
}
