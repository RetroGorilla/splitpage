import { beatPos, caretAt, normalizedSections, replaceMatch } from "./flow.ts";
import type { FlowDoc, FlowEdit, FlowOutcome, FlowPorts, FlowRange } from "./flow.ts";
import { clampRange, deleteRange, replaceText, sliceCell } from "../text/edits.ts";
import { cellLength } from "../text/runs.ts";
import { describeFlow } from "./operations.ts";
import { toHtml } from "../text/html.ts";

export type FlowReplacementMatch =
  | { readonly kind: "narration"; readonly range: FlowRange }
  | { readonly kind: "visual"; readonly rowId: string; readonly from: number; readonly to: number };

export function replaceFlowMatches(doc: FlowDoc, matches: readonly FlowReplacementMatch[], text: string, ports: FlowPorts): FlowOutcome {
  if (ports.operations) return describeFlow(doc, ports, traced => replaceFlowMatches(doc, matches, text, traced));
  let current = doc;
  let last: FlowEdit | null = null;
  for (const match of matches.slice().reverse()) {
    let result: FlowOutcome;
    if (match.kind === "visual") {
      const row = current.rows.find(item => item.id === match.rowId);
      if (!row) continue;
      const cell = ports.cells(row.visualText), next = replaceText(cell, match.from, match.to, text);
      if (ports.trace) {
        const range = clampRange(cell, match.from, match.to);
        ports.trace.replace(row.id, cell, match.from, match.to, sliceCell(next, range.from, range.from + cellLength(next) - cellLength(deleteRange(cell, match.from, match.to))), "visualText");
      }
      const html = toHtml(next);
      result = {
        rows: current.rows.map(item => item.id === row.id ? { ...item, visualText: html } : item),
        sections: normalizedSections(current.sections),
        removedComments: [],
        selection: caretAt(beatPos(row.id, 0))
      };
    } else result = replaceMatch(current, match.range, text, ports);
    if (result && "refused" in result) return result;
    if (result && "rows" in result) {
      last = result;
      current = { ...current, rows: result.rows, sections: result.sections };
    }
  }
  return last;
}
