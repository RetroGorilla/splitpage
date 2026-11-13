import type { FlowRange } from "../../core/flow/flow.ts";
import { beatPos, headingPos } from "../../core/flow/flow.ts";
import type { SharedContentRef, SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { resolveSharedAnchor } from "./anchors.ts";
import { collabProjectedHeadingPoint, collabProjectedNarrationPoint } from "./text-target.ts";

export function resolveSharedBufferedSelection(handle: SharedDocumentHandle, anchors: readonly (SharedContentRef | null)[],
  field: SharedTextAddress["field"] = "audioText"): FlowRange | undefined {
  if (field !== "audioText" && field !== "heading") return undefined;
  function point(anchor: SharedContentRef | null | undefined) {
    const location = anchor ? resolveSharedAnchor(handle, anchor) : "gone";
    if (location === "gone") return null;
    if (field === "heading") {
      const heading = collabProjectedHeadingPoint(handle, location.segment, location.offset);
      return heading ? headingPos(heading.owner, heading.offset) : null;
    }
    const projected = collabProjectedNarrationPoint(handle, location.segment, location.offset);
    return projected ? beatPos(projected.owner, projected.offset) : null;
  }
  const anchor = point(anchors[0]), head = point(anchors[1]);
  return anchor && head ? { anchor, head } : undefined;
}
