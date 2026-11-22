import type { SharedOperation } from "../../core/collab/operations.ts";
import type { RowStatusId } from "../../core/document/timing.ts";
import type { RecordCommandRun } from "./shared-records.ts";

type SharedValueAuthor = { readonly id: string; readonly by: string };

export interface SharedValuePorts {
  readonly author: () => SharedValueAuthor | null;
  readonly beatStamp: (beat: string, author: SharedValueAuthor) => SharedOperation;
}

export type SharedBeatField = (rowId: string, field: "status" | "lengthSeconds", value: RowStatusId | number | null) => RecordCommandRun | null;
