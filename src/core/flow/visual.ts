import { isCollapsed, normalizedSections, selectionToOwnBeat, withinOneBeat } from "./flow.ts";
import type { FlowDoc, FlowOutcome, FlowPorts, FlowRange } from "./flow.ts";

export function setVisualForRange(doc: FlowDoc, range: FlowRange, html: string, ports: FlowPorts): FlowOutcome {
  if (!withinOneBeat(range)) return { refused: "Visuals must stay within one beat." };
  if (range.head.kind !== "beat") return null;
  const isolated = isCollapsed(range) ? null : selectionToOwnBeat(doc, range, ports);
  if (isolated && !("rows" in isolated)) return isolated;
  const selected = isolated?.selection ?? range;
  if (selected.head.kind !== "beat") return null;
  const rowId = selected.head.rowId;
  const rows = (isolated?.rows ?? doc.rows).map(row => row.id === rowId ? { ...row, visualText: html } : row);
  return isolated ? { ...isolated, rows } : { rows, sections: normalizedSections(doc.sections), removedComments: [], selection: selected };
}
