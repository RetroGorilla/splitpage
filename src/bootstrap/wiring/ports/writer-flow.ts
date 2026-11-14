import { flowCommand } from "../../../application/commands/flow.ts";
import type { FlowCommandSource } from "../../../application/commands/flow.ts";
import type { FlowOutcome, FlowPorts, FlowPos, FlowRange } from "../../../core/flow/flow.ts";
import type { FlowOperationRequest } from "../../../core/flow/operations.ts";
import type { SharedContentRef, SharedOperation } from "../../../core/collab/operations.ts";
import type { SharedAuthorPort } from "./shared-author.ts";
import { sharedBeatStamp } from "../../../adapters/collab/stamp.ts";
import { sharedStructureIdentity } from "../../../adapters/collab/structure-identity.ts";
import { sharedFlowPaste } from "../../../application/commands/flow-paste.ts";
import type { SharedDocumentHandle } from "../../../adapters/collab/types.ts";
import { readSharedPaintedText } from "../../../adapters/collab/paint-base.ts";
import { createSharedAnchor } from "../../../adapters/collab/anchors.ts";
import { sharedRecordFieldAccepted } from "../../../adapters/collab/record-codec.ts";

export interface WriterFlowCommands {
  readonly flow: FlowPorts;
  readonly commands: FlowCommandSource;
}

function committedFlowRange(range: FlowRange, operations: readonly SharedOperation[], writer: string): FlowRange {
  const beats = new Map<string, string>(), headings = new Map<string, string>();
  for (const op of operations) {
    if (op.kind === "segment-create" || op.kind === "split" || op.kind === "split-before") beats.set(op.beat, sharedStructureIdentity(writer, op.id, "beat"));
    if (op.kind === "heading-remove" && op.newBeat) beats.set(op.newBeat, sharedStructureIdentity(writer, op.id, "beat"));
    if (op.kind === "heading-create" || op.kind === "heading-finalize") headings.set(op.heading, sharedStructureIdentity(writer, op.id, "heading"));
  }
  const position = (pos: FlowPos): FlowPos => pos.kind === "beat" ? { ...pos, rowId: beats.get(pos.rowId) ?? pos.rowId }
    : { ...pos, sceneId: headings.get(pos.sceneId) ?? pos.sceneId };
  return { anchor: position(range.anchor), head: position(range.head) };
}

export function writerFlowCommands(flow: FlowPorts, source: { readonly author: SharedAuthorPort; readonly writer: () => string; readonly handle?: () => SharedDocumentHandle | null }): WriterFlowCommands {
  let operations: FlowOperationRequest | undefined;
  return {
    flow: { ...flow, get operations() { return operations; } },
    commands: { prepare: (name, operation, stamps, before) => {
      let result: FlowOutcome = null;
      return {
        result: () => result,
        command: { name, needs: "edit", plan: (doc, capability) => {
          const request = source.author.next();
          operations = request ?? undefined;
          const ports = request ? { ...stamps, operations: request, beatStamp: (beat: SharedContentRef, by: FlowOperationRequest) => sharedBeatStamp(beat, by, stamps) } : stamps;
          try { return flowCommand(name, () => {
            const original = operation(doc);
            const edited = request && original && "rows" in original && original.clipboard ? sharedFlowPaste(doc, original, {
              author: request, cells: flow.cells, recordField: sharedRecordFieldAccepted,
              identity: (operation, role) => sharedStructureIdentity(source.writer(), operation, role),
              reference: (span, purpose) => {
                const handle = source.handle?.(); if (!handle) return null;
                const target = { owner: span.owner as SharedContentRef, segment: span.owner as SharedContentRef, field: span.field };
                if (purpose !== "range") {
                  const anchor = createSharedAnchor(handle, target, span.from + (purpose === "left" ? 1 : 0), purpose === "left" ? "after" : "before");
                  return anchor ? [anchor] : null;
                }
                const painted = readSharedPaintedText(handle, target); if (!painted) return null;
                const units: SharedContentRef[] = [];
                for (let index = span.from; index < span.to; index++) { const unit = painted.identity(index); if (!unit) return null; units.push(unit); }
                return units;
              }
            }) : original;
            result = request && edited && "rows" in edited && edited.ops
              ? { ...edited, selection: committedFlowRange(edited.selection, edited.ops, source.writer()) } : edited;
            return result;
          }, ports, before).plan(doc, capability); }
          finally { operations = undefined; }
        } }
      };
    } }
  };
}
