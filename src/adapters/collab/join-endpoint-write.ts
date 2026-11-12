import * as Y from "yjs";
import type { SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState, SharedExecutionWriteError } from "./state.ts";
import { collabPreparedOperationTextTarget } from "./text-target.ts";
import { sharedJoinEndpointField } from "./join-endpoint.ts";

export interface SharedJoinEndpointWrite { readonly join: string; readonly target: SharedTextAddress; readonly index: number; readonly source: SharedTextAddress; readonly from: number; readonly to: number }
export function applySharedJoinEndpoint(handle: SharedDocumentHandle, description: SharedJoinEndpointWrite): void {
  const state = collabState(handle); if (!state.execution?.applying) throw new SharedExecutionWriteError();
  const destination = collabPreparedOperationTextTarget(handle, description.target), source = collabPreparedOperationTextTarget(handle, description.source);
  const position = (text: Y.Text, segment: string, offset: number, assoc: -1 | 0) => {
    const point = Y.createRelativePositionFromTypeIndex(text, offset, assoc);
    if (!point.type) throw new Error("Prepared join endpoint has no native text identity");
    return { segment, type: [point.type.client, point.type.clock], item: point.item ? [point.item.client, point.item.clock] : null, assoc };
  };
  state.roots.meta.set(sharedJoinEndpointField(description.join), {
    end: position(destination.text, description.target.segment, description.index, 0),
    start: position(source.text, description.source.segment, description.from, -1),
    stop: position(source.text, description.source.segment, description.to, 0)
  });
}
