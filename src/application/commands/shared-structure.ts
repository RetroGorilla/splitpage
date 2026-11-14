import type { SharedContentRef, SharedJsonFields, SharedOperation } from "../../core/collab/operations.ts";
import type { StampPorts } from "../session/ports.ts";
import { flowBaseReference } from "../../core/collab/base-reference.ts";
import { FlowOperationTrace, flowIdentity } from "../../core/flow/operations.ts";
import { cellLength } from "../../core/text/runs.ts";
import type { Run } from "../../core/text/runs.ts";
import type { DocumentView, Plan } from "../session/document-session.ts";
import type { ParagraphFlagChange } from "./paragraphs.ts";
import type { SharedValuePorts } from "./shared-values.ts";

type SharedStructureAuthor = { readonly id: string; readonly by: string };

export interface SharedStructurePorts extends Pick<SharedValuePorts, "author" | "beatStamp"> {
  readonly cells: (html: string | null | undefined) => readonly Run[];
  readonly joinedParts: (beat: string) => readonly { readonly beat: string; readonly length: number }[];
}

export function sharedStructureTrace(doc: DocumentView, ports: SharedStructurePorts, author: SharedStructureAuthor): FlowOperationTrace {
  return new FlowOperationTrace(doc, { cells: ports.cells }, author);
}

// why: the caller's id names the new beat only inside its own list, so its stamp travels in the creation itself.
export function sharedCreatedBeat(stamps: StampPorts): SharedJsonFields {
  return { visualText: "", imageRef: null, status: "todo", stamp: { at: stamps.clock.nowIso(), by: stamps.editor.name() } };
}

export function sharedParagraphFlags(trace: FlowOperationTrace, flags: readonly ParagraphFlagChange[]): void {
  for (const flag of flags) trace.emit({ kind: "scalar", target: { scope: "beat", record: flowIdentity(flag.rowId) }, field: "paragraphStart",
    ...flag.start ? { value: true } : { clear: true } });
}

export function sharedRemoval(doc: DocumentView, rowIds: readonly string[], flags: readonly ParagraphFlagChange[], shared: SharedStructurePorts | undefined): Pick<Plan, "shared"> {
  const by = shared?.author();
  if (!shared || !by) return {};
  const trace = sharedStructureTrace(doc, shared, by), rows = doc.rows.filter(row => rowIds.includes(row.id));
  // why: a joined row's text is its parts' own texts, so the removal names and observes each part.
  const parts = rows.flatMap(row => {
    const joined = shared.joinedParts(row.id);
    return joined.length ? joined.map(part => ({ beat: part.beat, observed: [flowBaseReference(part.beat, "audioText", 0, part.length)] }))
      : [{ beat: row.id, observed: trace.span(row.id, 0, cellLength(shared.cells(row.audioText))) }];
  });
  const targets = parts.map(part => flowIdentity(part.beat));
  trace.emit({ kind: "remove", removalKind: "beat", targets, observed: parts.flatMap(part => part.observed),
    boundaries: targets, components: targets.map(id => flowIdentity(id + ":visual")), gallery: targets.map(id => flowIdentity(id + ":gallery")),
    at: doc.rows.findIndex(row => rowIds.includes(row.id)) });
  sharedParagraphFlags(trace, flags);
  return { shared: sharedStructureList(trace, shared, by, []) };
}

export function sharedStructureList(trace: FlowOperationTrace, ports: SharedStructurePorts, author: SharedStructureAuthor, stamped: readonly string[]): { readonly operations: readonly SharedOperation[] } {
  return { operations: [...trace.ops, ...stamped.map((beat, index) => ports.beatStamp(beat as SharedContentRef, { id: author.id + "_stamp_" + index, by: author.by }))] };
}
