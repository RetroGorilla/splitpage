import { beatPos, caretAt, normalizedSections, replaceMatch } from "./flow.ts";
import type { FlowDoc, FlowEdit, FlowOutcome, FlowPorts, FlowRange } from "./flow.ts";
import { replaceText } from "../text/edits.ts";
import { toHtml } from "../text/html.ts";

export type FlowReplacementMatch =
  | { readonly kind: "narration"; readonly range: FlowRange }
  | { readonly kind: "visual"; readonly rowId: string; readonly from: number; readonly to: number };

export function replaceFlowMatches(doc: FlowDoc, matches: readonly FlowReplacementMatch[], text: string, ports: FlowPorts): FlowOutcome {
  let current = doc;
  let last: FlowEdit | null = null;
  for (const match of matches.slice().reverse()) {
    let result: FlowOutcome;
    if (match.kind === "visual") {
      const row = current.rows.find(item => item.id === match.rowId);
      if (!row) continue;
      const html = toHtml(replaceText(ports.cells(row.visualText), match.from, match.to, text));
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
