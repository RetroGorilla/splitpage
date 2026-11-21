import { sliceCell } from "../text/edits.ts";
import { projection } from "../text/runs.ts";
import type { Run } from "../text/runs.ts";

export function headingLine(cell: readonly Run[], marker: string, nameMax: number, enterAt: number | null, hasRunOn: boolean) {
  const text = projection(cell);
  const newline = text.indexOf("\n"), lineEnd = newline === -1 ? text.length : newline;
  const end = enterAt === null ? lineEnd : Math.min(enterAt, lineEnd);
  const name = text.slice(marker.length, end).trim();
  if (!name) return {};
  if (sliceCell(cell, 0, end).some(run => !!run.marks.tag || !!run.marks.cmt?.length)) {
    return { notice: "A scene header can't hold tags or comments." };
  }
  if (enterAt === null && newline === -1 && hasRunOn) {
    return { notice: "A scene header can't hold several beats. Press Enter after the header's words." };
  }
  if (Array.from(name).length > nameMax) {
    return { notice: "A scene name can be up to " + nameMax + " characters, so this stays as narration." };
  }
  return { name, restStart: end < text.length && text[end] === "\n" ? end + 1 : end };
}
