import type { SharedRewritePorts } from "../../../application/commands/document-edit.ts";
import type { StampPorts } from "../../../application/session/ports.ts";
import type { SharedDocumentHandle } from "../../../adapters/collab/types.ts";
import { sharedBeatStamp } from "../../../adapters/collab/stamp.ts";

export function sharedRewritePorts(source: { readonly handle: () => SharedDocumentHandle | null; readonly author: SharedRewritePorts["author"]; readonly stamps: StampPorts;
  readonly cells: SharedRewritePorts["cells"]; readonly readers: SharedRewritePorts["readers"] }): () => SharedRewritePorts | null {
  return () => source.handle() ? {
    author: source.author,
    beatStamp: (beat, author) => sharedBeatStamp(beat, author, source.stamps),
    cells: source.cells,
    readers: source.readers
  } : null;
}
