import type { CellRange } from "../../application/editing/cell-editing.ts";
import { namedTagId, tagStack, withTagStack } from "../../core/text/runs.ts";
import type { Run } from "../../core/text/runs.ts";
import { domToPos } from "./cell-dom.ts";

export function inheritOpenedTags(cell: Element, selection: CellRange | null, piece: readonly Run[]): readonly Run[] {
  const opened = cell.querySelector("[data-tag-editing]");
  if (!opened || !selection) return piece;
  const from = domToPos(cell, opened, 0);
  const to = domToPos(cell, opened, opened.childNodes.length);
  if (from === null || to === null || selection.from < from || selection.to > to) return piece;
  const enclosing: string[] = [];
  for (let tag: Element | null = opened; tag && tag !== cell; tag = tag.parentElement) {
    if (tag.matches(".tag-anchor")) enclosing.unshift(namedTagId(tag.getAttribute("data-tag-cat") || "", tag.getAttribute("data-tag-name") || ""));
  }
  return piece.map(run => run.atom ? run : {
    ...run,
    marks: withTagStack(run.marks, [...enclosing, ...tagStack(run.marks).filter(id => !enclosing.includes(id))])
  });
}
