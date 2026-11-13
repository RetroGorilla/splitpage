import type { FlowRange } from "../../core/flow/flow.ts";
import { beatPos, headingPos } from "../../core/flow/flow.ts";
import type { SharedContentRef, SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { resolveSharedAnchor } from "./anchors.ts";
import { collabProjectedHeadingPoint, collabProjectedNarrationPoint, collabProjectedTextOffset } from "./text-target.ts";

export function resolveSharedBufferedSelection(handle: SharedDocumentHandle, anchors: readonly (SharedContentRef | null)[],
  field?: { readonly key: string; readonly target: SharedTextAddress }): FlowRange | undefined {
  if (field?.target.field === "title") return undefined;
  function point(anchor: SharedContentRef | null | undefined) {
    const location = anchor ? resolveSharedAnchor(handle, anchor) : "gone";
    if (location === "gone") return null;
    if (field?.target.field === "heading") {
      const heading = collabProjectedHeadingPoint(handle, location.segment, location.offset);
      return heading ? headingPos(heading.owner, heading.offset) : null;
    }
    if (field?.target.field === "visualText") {
      const offset = collabProjectedTextOffset(handle, field.target, location.segment, location.offset);
      return offset === null ? null : beatPos(field.key, offset);
    }
    const projected = collabProjectedNarrationPoint(handle, location.segment, location.offset);
    return projected ? beatPos(projected.owner, projected.offset) : null;
  }
  const anchor = point(anchors[0]), head = point(anchors[1]);
  return anchor && head ? { anchor, head } : undefined;
}
