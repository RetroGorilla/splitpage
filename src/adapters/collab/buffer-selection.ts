import type { FlowRange } from "../../core/flow/flow.ts";
import { beatPos } from "../../core/flow/flow.ts";
import { projectSharedJoinGroups, projectSharedJoinedUnits } from "../../core/collab/projection/joins.ts";
import type { SharedProjectionUnit } from "../../core/collab/projection/units.ts";
import type { SharedContentRef } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState } from "./state.ts";
import { resolveSharedAnchor } from "./anchors.ts";
import { readProjectionBlocks, readProjectionBeatStructure } from "./projection-reader.ts";
import { readProjectionUnits } from "./projection-text-reader.ts";
import { readSharedRecords } from "./record-reader.ts";

export function resolveSharedBufferedSelection(handle: SharedDocumentHandle, anchors: readonly (SharedContentRef | null)[]): FlowRange | undefined {
  const { roots } = collabState(handle);
  const blocks = readProjectionBlocks(roots.order, roots.segments, roots.beats,
    container => readProjectionUnits(handle, container.get("text"), container.get("markRecords")))
    .filter((block): block is typeof block & { id: string } => !block.reason && block.kind === "b" && block.id !== null);
  const groups = projectSharedJoinGroups(blocks.map(block => readProjectionBeatStructure(roots.beats.get(block.id), block.id, roots.retiredJoins, roots.meta)));
  const tags = readSharedRecords(handle, "tags").map(record => record.fields);
  function point(anchor: SharedContentRef | null | undefined) {
    const location = anchor ? resolveSharedAnchor(handle, anchor) : "gone";
    if (location === "gone") return null;
    const block = blocks.find(value => value.segment === location.segment && value.from <= location.offset && location.offset <= value.to);
    const group = block && groups.find(value => !value.removed && value.members.some(member => member.id === block.id));
    if (!block || !group) return null;
    const offset = location.offset - block.from;
    if (offset > block.units.length) return null;
    // why: a zero-width marker follows the same member ordering and glue as the visible projection.
    const marker: SharedProjectionUnit = { value: "", marks: [] };
    const parts = group.members.map(member => {
      const source = blocks.find(value => value.id === member.id), units = source?.units ?? [];
      return { glue: member.glue, units: source === block ? [...units.slice(0, offset), marker, ...units.slice(offset)] : units };
    });
    let projected = 0;
    for (const unit of projectSharedJoinedUnits(parts, tags, group.cyclic)) {
      if (unit === marker) return beatPos(group.root, projected);
      projected += typeof unit.value === "string" ? unit.value.length : 1;
    }
    return null;
  }
  const anchor = point(anchors[0]), head = point(anchors[1]);
  return anchor && head ? { anchor, head } : undefined;
}
