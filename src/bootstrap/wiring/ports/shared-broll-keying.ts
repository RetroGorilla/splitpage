import { sharedBrollLineKeys } from "../../../adapters/collab/broll-keying.ts";
import { sharedBeatStamp } from "../../../adapters/collab/stamp.ts";
import type { SharedDocumentHandle } from "../../../adapters/collab/types.ts";
import type { SharedBrollKeyingPorts } from "../../../application/commands/shared-broll-keying.ts";
import type { StampPorts } from "../../../application/session/ports.ts";

export function sharedBrollKeyingPorts(handle: SharedDocumentHandle, source: Pick<SharedBrollKeyingPorts, "author" | "cells" | "readers" | "plainTextOf"> & {
  readonly stamps: StampPorts }): SharedBrollKeyingPorts {
  return {
    author: source.author,
    beatStamp: (beat, author) => sharedBeatStamp(beat, author, source.stamps),
    cells: source.cells,
    readers: source.readers,
    plainTextOf: source.plainTextOf,
    lineKeys: rowId => sharedBrollLineKeys(handle, rowId)
  };
}
