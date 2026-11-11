import { beatPos, comparePos, findInFlow } from "../../core/flow/flow.ts";
import type { FlowDoc, FlowPorts, FlowPos } from "../../core/flow/flow.ts";
import { countInTags, findInCell } from "../../core/text/search.ts";
import { sliceCell } from "../../core/text/edits.ts";
import type { WriterSearchMatch, WriterSearchResults } from "../common/writer-find.ts";

export function flowMatchStart(match: WriterSearchMatch): FlowPos {
  return match.kind === "visual" ? beatPos(match.rowId, 0) : match.range.anchor;
}

export function visualMatchHighlight(doc: FlowDoc, match: WriterSearchMatch & { readonly kind: "visual" }, ports: FlowPorts) {
  const cell = ports.cells(doc.rows.find(row => row.id === match.rowId)?.visualText);
  const plainOffset = (end: number) => sliceCell(cell, 0, end).reduce((length, run) =>
    length + (run.atom === "image" || run.atom === "video" ? 0 : run.text.length), 0);
  return { from: plainOffset(match.from), to: plainOffset(match.to) };
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
