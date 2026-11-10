import { describeFlow, flowIdentity } from "./operations.ts";
import { isCollapsed, normalizedSections, selectionToOwnBeat, withinOneBeat } from "./flow.ts";
import type { FlowDoc, FlowOutcome, FlowPorts, FlowRange } from "./flow.ts";

export function setVisualForRange(doc: FlowDoc, range: FlowRange, html: string, ports: FlowPorts): FlowOutcome {
  if (ports.operations) return describeFlow(doc, ports, traced => setVisualForRange(doc, range, html, traced));
  if (!withinOneBeat(range)) return { refused: "Visuals must stay within one beat." };
  if (range.head.kind !== "beat") return null;
  const isolated = isCollapsed(range) ? null : selectionToOwnBeat(doc, range, ports);
  if (isolated && !("rows" in isolated)) return isolated;
  const selected = isolated?.selection ?? range;
  if (selected.head.kind !== "beat") return null;
  const rowId = selected.head.rowId;
  const original = (isolated?.rows ?? doc.rows).find(row => row.id === rowId);
  if (original && ports.trace) {
    if (original.visualText) ports.trace.emit({ kind: "record-set", target: { collection: "visuals", record: flowIdentity(rowId + ":visual") }, field: "html", value: html });
    else ports.trace.emit({ kind: "record-create", target: { collection: "visuals", record: flowIdentity(rowId + ":visual") }, fields: { beat: rowId, html } });
  }
  const rows = (isolated?.rows ?? doc.rows).map(row => row.id === rowId ? { ...row, visualText: html } : row);
  return isolated ? { ...isolated, rows } : { rows, sections: normalizedSections(doc.sections), removedComments: [], selection: selected };
}
