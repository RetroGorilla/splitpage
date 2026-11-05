import { sliceCell } from "../../core/text/edits.ts";
import { cellLength, normalizeCell, projection } from "../../core/text/runs.ts";
import type { Run } from "../../core/text/runs.ts";

export function clipboardEndsInBlock(body: Element): boolean {
  let last = body.lastChild;
  while (last && (last.nodeType === 8 || (last.nodeType === 3 && !/\S/.test(last.nodeValue as string)))) {
    body.removeChild(last);
    last = body.lastChild;
  }
  return !!(last && last.nodeType === 1 && ((last as Element).tagName === "P" || (last as Element).tagName === "DIV"));
}

export function clipboardContent(cell: Run[], endsInBlock: boolean, fallback: () => string): { cell: Run[]; text: string | null } {
  const trimmed = endsInBlock && projection(cell).slice(-1) === "\n" ? sliceCell(cell, 0, cellLength(cell) - 1) : cell;
  if (cellLength(trimmed)) return { cell: trimmed, text: null };
  const text = fallback();
  return { cell: normalizeCell([{ text: text, marks: {} }]), text: text };
}
