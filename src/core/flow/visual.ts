import { describeFlow } from "./operations.ts";
import { cellLength } from "../text/runs.ts";
import { toHtml } from "../text/html.ts";
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
  if (ports.trace) {
    const original = (isolated?.rows ?? doc.rows).find(row => row.id === rowId), cell = ports.cells(original?.visualText), piece = ports.cells(html);
    // why: a set replaces the beat's visual text whole, as a select-all edit in a Split cell does, so text undo covers it.
    if (original && toHtml(cell) !== toHtml(piece)) ports.trace.replace(rowId, cell, 0, cellLength(cell), piece, "visualText");
  }
  const rows = (isolated?.rows ?? doc.rows).map(row => row.id === rowId ? { ...row, visualText: html } : row);
  return isolated ? { ...isolated, rows } : { rows, sections: normalizedSections(doc.sections), removedComments: [], selection: selected };
}
