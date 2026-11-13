import type { FlowRange } from "../../core/flow/flow.ts";
import { beatPos } from "../../core/flow/flow.ts";
import type { SharedContentRef, SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { resolveSharedAnchor } from "./anchors.ts";
import { collabProjectedNarrationPoint, collabProjectedTextOffset } from "./text-target.ts";

export function resolveSharedBufferedSelection(handle: SharedDocumentHandle, anchors: readonly (SharedContentRef | null)[],
  visual?: { readonly key: string; readonly target: SharedTextAddress }): FlowRange | undefined {
  function point(anchor: SharedContentRef | null | undefined) {
    const location = anchor ? resolveSharedAnchor(handle, anchor) : "gone";
    if (location === "gone") return null;
    if (visual) {
      const offset = collabProjectedTextOffset(handle, visual.target, location.segment, location.offset);
      return offset === null ? null : beatPos(visual.key, offset);
    }
    const projected = collabProjectedNarrationPoint(handle, location.segment, location.offset);
    return projected ? beatPos(projected.owner, projected.offset) : null;
  }
  const anchor = point(anchors[0]), head = point(anchors[1]);
  return anchor && head ? { anchor, head } : undefined;
}
