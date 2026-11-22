import type { SharedScalarAddress } from "../../../src/core/collab/operations.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { scalarTarget } from "../../../src/adapters/collab/scalar-executor.ts";
import { scalarFieldAllowed } from "../../../src/adapters/collab/scalar-fields.ts";
import { sharedJson, withSharedSnapshot } from "../../../src/adapters/collab/snapshot.ts";
import { readSharedStamp } from "../../../src/adapters/collab/stamp.ts";

export function observeSharedScalars(handle: SharedDocumentHandle, target: SharedScalarAddress): Record<string, unknown> | null {
  return withSharedSnapshot(handle, copy => {
    const source = scalarTarget(copy as unknown as SharedDocumentHandle, target);
    if (!source) return null;
    const output: [string, unknown][] = [];
    const fields = target.scope === "document" ? ["fileTitle", "wordsPerMinute", "targetSeconds", "paragraphsDecided", "extra"]
      : target.scope === "beat" ? ["lengthSeconds", "paragraphStart", "stamp", "extra"] : ["extra"];
    for (const key of fields) {
      const value = key === "stamp" ? readSharedStamp(source) : sharedJson(source.get(key));
      if (scalarFieldAllowed(target.scope, key, value, false)) output.push([key, value]);
    }
    return Object.fromEntries(output);
  });
}
