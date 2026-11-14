import type { SharedContentRef, SharedOperation, SharedScalarAddress } from "../../core/collab/operations.ts";
import type { RowStatusId } from "../../core/document/timing.ts";

type SharedValueAuthor = { readonly id: string; readonly by: string };

export interface SharedValuePorts {
  readonly author: () => SharedValueAuthor | null;
  readonly beatStamp: (beat: string, author: SharedValueAuthor) => SharedOperation;
  readonly statusHeads: (beat: string) => readonly string[];
  readonly statusParts: (beat: string) => readonly string[];
}

// why: a joined beat shows the highest status of its parts, so every part the row reads gets the new status.
export function sharedBeatStatus(ports: SharedValuePorts, author: SharedValueAuthor, beat: string, value: RowStatusId): SharedOperation[] {
  return ports.statusParts(beat).map((part, index) => ({ kind: "status", id: (author.id + ":status" + (index ? ":" + index : "")) as SharedContentRef, by: author.by,
    target: { scope: "beat", record: part as SharedContentRef }, value, parents: ports.statusHeads(part).map(head => head as SharedContentRef) }));
}

export function sharedScalar(author: SharedValueAuthor, scope: SharedScalarAddress["scope"], record: string, field: string, value: number | null): SharedOperation {
  const base = { kind: "scalar" as const, id: (author.id + ":" + field) as SharedContentRef, by: author.by, target: { scope, record: record as SharedContentRef }, field };
  return value === null ? { ...base, clear: true } : { ...base, value };
}
