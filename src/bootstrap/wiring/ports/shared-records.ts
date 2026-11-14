import type { SharedRecordPorts } from "../../../application/commands/shared-records.ts";
import type { SharedContentRef } from "../../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "../../../adapters/collab/types.ts";
import { readSharedRecords } from "../../../adapters/collab/record-reader.ts";
import { readSharedStatusHeads } from "../../../adapters/collab/status.ts";

export function sharedRecordPorts(source: { readonly handle: () => SharedDocumentHandle | null; readonly author: SharedRecordPorts["author"] }): SharedRecordPorts {
  return {
    author: source.author,
    ranks: collection => {
      const handle = source.handle();
      return handle ? readSharedRecords(handle, collection).flatMap(record => typeof record.fields.rank === "string" ? [record.fields.rank] : []) : [];
    },
    heads: (scope, record) => {
      const handle = source.handle();
      return handle ? readSharedStatusHeads(handle, { scope, record: record as SharedContentRef }) : [];
    }
  };
}
