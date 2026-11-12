import type { SharedScalarAddress } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { scalarTarget } from "./scalar-executor.ts";
import { scalarFieldAllowed } from "./scalar-fields.ts";
import { sharedJson, withSharedSnapshot } from "./snapshot.ts";

export function readSharedScalars(handle: SharedDocumentHandle, target: SharedScalarAddress): Record<string, unknown> | null {
  return withSharedSnapshot(handle, copy => {
    const source = scalarTarget(copy as unknown as SharedDocumentHandle, target);
    if (!source) return null;
    const output: [string, unknown][] = [];
    const fields = target.scope === "document" ? ["fileTitle", "wordsPerMinute", "targetSeconds", "paragraphsDecided", "extra"]
      : target.scope === "beat" ? ["lengthSeconds", "paragraphStart", "stamp", "extra"] : ["extra"];
    for (const key of fields) {
      const value = sharedJson(source.get(key));
      if (scalarFieldAllowed(target.scope, key, value, false)) output.push([key, value]);
    }
    return Object.fromEntries(output);
  });
}
