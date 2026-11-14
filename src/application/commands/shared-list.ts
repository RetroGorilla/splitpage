import type { SharedOperation, SharedScalarAddress } from "../../core/collab/operations.ts";
import type { RowStatusId } from "../../core/document/timing.ts";
import { flowIdentity } from "../../core/flow/operations.ts";
import type { FlowOperationRequest } from "../../core/flow/operations.ts";

export interface SharedListPorts {
  readonly author: () => FlowOperationRequest;
  readonly beatStamp: (beat: string, author: FlowOperationRequest) => SharedOperation;
  readonly statusParents: (beat: string) => readonly string[];
}

export function sharedBeatStatus(ports: SharedListPorts, author: FlowOperationRequest, beat: string, value: RowStatusId): SharedOperation {
  return { kind: "status", id: flowIdentity(author.id + ":status"), by: author.by, target: { scope: "beat", record: flowIdentity(beat) },
    value: value, parents: ports.statusParents(beat).map(flowIdentity) };
}

export function sharedScalar(author: FlowOperationRequest, scope: SharedScalarAddress["scope"], record: string, field: string, value: number | null): SharedOperation {
  const base = { kind: "scalar" as const, id: flowIdentity(author.id + ":" + field), by: author.by, target: { scope: scope, record: flowIdentity(record) }, field: field };
  return value === null ? { ...base, clear: true } : { ...base, value: value };
}
