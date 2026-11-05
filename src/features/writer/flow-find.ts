import { beatPos, caretAt, comparePos, findInFlow, normalizedSections, replaceMatch } from "../../core/flow/flow.ts";
import type { FlowDoc, FlowEdit, FlowOutcome, FlowPorts, FlowPos } from "../../core/flow/flow.ts";
import { countInTags, findInCell } from "../../core/text/search.ts";
import { replaceText } from "../../core/text/edits.ts";
import { toHtml } from "../../core/text/html.ts";
import type { WriterSearchMatch, WriterSearchResults } from "../common/writer-find.ts";

export function flowMatchStart(match: WriterSearchMatch): FlowPos {
  return match.kind === "visual" ? beatPos(match.rowId, 0) : match.range.anchor;
}

export function searchFlow(doc: FlowDoc, needle: string, matchCase: boolean, visuals: boolean, ports: FlowPorts): WriterSearchResults {
  const matches: WriterSearchMatch[] = findInFlow(doc, needle, matchCase, ports).map(hit => ({ kind: "narration", range: hit.range }));
  let inTags = 0;
  for (const row of doc.rows) {
    inTags += countInTags(ports.cells(row.audioText), needle, matchCase);
    if (!visuals) continue;
    const cell = ports.cells(row.visualText);
    inTags += countInTags(cell, needle, matchCase);
    for (const hit of findInCell(cell, needle, matchCase)) matches.push({ kind: "visual", rowId: row.id, ...hit });
  }
  matches.sort((a, b) => comparePos(doc, flowMatchStart(a), flowMatchStart(b)) ||
    (a.kind === "visual" && b.kind === "visual" ? a.from - b.from : a.kind === "visual" ? -1 : b.kind === "visual" ? 1 : 0));
  return { matches, inTags };
}

export function replaceFlowMatches(doc: FlowDoc, matches: readonly WriterSearchMatch[], text: string, ports: FlowPorts): FlowOutcome {
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
