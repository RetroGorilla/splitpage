import type { FlowPos, FlowRange, FlowSelectionPair } from "../../core/flow/flow.ts";
import type { SharedContentRef } from "../../core/collab/operations.ts";
import type { SharedRecordedSelection, SharedUndoSelection } from "../../core/collab/undo-record.ts";
import { headingFieldKey } from "../../application/editing/buffered-field-key.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { readSharedAnchorUnit, sharedAnchorCharacterEnd, sharedAnchorTarget } from "./anchors.ts";
import { nativeStructureView } from "./text-target.ts";
import { resolveSharedStructureOwner } from "./structure-plan.ts";
import { readSharedJoinedTextGeometry } from "./joined-text-geometry.ts";
import { sharedBufferedTarget } from "./buffer.ts";
import { resolveSharedBufferedSelection } from "./buffer-selection.ts";
import { readSharedPaintedText } from "./paint-base.ts";

function point(handle: SharedDocumentHandle, pos: FlowPos, side: "start" | "end"): SharedContentRef | null {
  try {
    const painted = readSharedPaintedText(handle, sharedBufferedTarget(handle, pos.kind === "beat" ? pos.rowId : headingFieldKey(pos.sceneId)));
    if (!painted) return null;
    const at = Math.max(0, Math.min(pos.offset, painted.text.length));
    const next = at < painted.text.length ? painted.identity(at) : null, previous = at > 0 ? painted.identity(at - 1) : null;
    const nextUnit = next && readSharedAnchorUnit(next) ? next : null, previousEnd = previous && readSharedAnchorUnit(previous) ? sharedAnchorCharacterEnd(previous) : null;
    return (side === "start" ? nextUnit ?? previousEnd : previousEnd ?? nextUnit) ?? painted.emptyGap ?? painted.endGap ?? null;
  } catch { return null; }
}

function anchored(handle: SharedDocumentHandle, range: FlowRange): SharedUndoSelection | null {
  const same = range.anchor.kind === range.head.kind && (range.anchor.kind === "beat" ? range.anchor.rowId === (range.head as typeof range.anchor).rowId
    : range.anchor.sceneId === (range.head as typeof range.anchor).sceneId);
  const backward = same && range.anchor.offset > range.head.offset, collapsed = same && range.anchor.offset === range.head.offset;
  const anchor = point(handle, range.anchor, collapsed || backward ? "end" : "start"), focus = point(handle, range.head, !collapsed && backward ? "start" : "end");
  return anchor && focus ? { anchor, focus } : null;
}

export function anchorSharedRecordedSide(handle: SharedDocumentHandle, range: FlowRange): SharedUndoSelection | null {
  return anchored(handle, range);
}

function resolved(handle: SharedDocumentHandle, selection: SharedUndoSelection): FlowRange | null {
  const target = sharedAnchorTarget(selection.focus);
  const field = target?.field === "heading" ? { key: headingFieldKey(target.owner), target } : undefined;
  return resolveSharedBufferedSelection(handle, [selection.anchor, selection.focus], field) ?? null;
}

// why: rule 89 on #1414: a recorded end on a deleted character resolves to the nearest surviving position
export function resolveSharedRecordedSelection(handle: SharedDocumentHandle, recorded: SharedRecordedSelection): FlowSelectionPair | null {
  const before = resolved(handle, recorded.before), after = resolved(handle, recorded.after);
  return before && after ? { before, after } : null;
}

export function sharedRowShowing(handle: SharedDocumentHandle, rowId: string): string {
  try {
    const { view } = nativeStructureView(handle);
    const owner = resolveSharedStructureOwner(view, rowId, "audioText"), geometry = owner ? readSharedJoinedTextGeometry(view, owner.owner) : null;
    return geometry && !geometry.removed ? String(geometry.root) : rowId;
  } catch { return rowId; }
}
