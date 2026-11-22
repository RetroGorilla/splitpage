import type { SharedGalleryPorts } from "../../../src/application/commands/gallery.ts";
import type { StampPorts } from "../../../src/application/session/ports.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { readSharedRecords } from "../../../src/adapters/collab/record-reader.ts";
import { readSharedJoinedBeats } from "../../../src/adapters/collab/undo-join.ts";
import { sharedBeatStamp } from "../../../src/adapters/collab/stamp.ts";

export function sharedGalleryPorts(source: { readonly handle: () => SharedDocumentHandle | null; readonly author: SharedGalleryPorts["author"]; readonly stamps: StampPorts }): SharedGalleryPorts {
  return {
    author: source.author,
    pictures: beat => {
      const handle = source.handle();
      return handle ? readSharedRecords(handle, "gallery").filter(record => record.fields.beat === beat) : [];
    },
    joined: beat => {
      const handle = source.handle(), members = handle ? readSharedJoinedBeats(handle, beat) : [];
      return handle && members.length ? readSharedRecords(handle, "gallery").filter(record => members.includes(String(record.fields.beat))) : [];
    },
    beatStamp: (beat, author) => sharedBeatStamp(beat, author, source.stamps)
  };
}
