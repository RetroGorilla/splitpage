import type { SharedGalleryPorts } from "../../../application/commands/gallery.ts";
import type { StampPorts } from "../../../application/session/ports.ts";
import type { SharedDocumentHandle } from "../../../adapters/collab/types.ts";
import { readSharedRecords } from "../../../adapters/collab/record-reader.ts";
import { sharedBeatStamp } from "../../../adapters/collab/stamp.ts";

export function sharedGalleryPorts(source: { readonly handle: () => SharedDocumentHandle | null; readonly author: SharedGalleryPorts["author"]; readonly stamps: StampPorts }): SharedGalleryPorts {
  return {
    author: source.author,
    pictures: beat => {
      const handle = source.handle();
      return handle ? readSharedRecords(handle, "gallery").filter(record => record.fields.beat === beat) : [];
    },
    beatStamp: (beat, author) => sharedBeatStamp(beat, author, source.stamps)
  };
}
