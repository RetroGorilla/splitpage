import type * as Y from "yjs";
import { readProjectionInlineValue } from "./projection-reader.ts";
import { OBJ } from "../../core/text/runs.ts";

export function readSharedProjectedTextRuns(text: Y.Text, from: number, to: number) {
  const positions: number[] = [], chunks: string[] = []; let offset = 0;
  for (const delta of text.toDelta() as { insert: unknown }[]) {
    const length = typeof delta.insert === "string" ? delta.insert.length : 1, value = readProjectionInlineValue(delta.insert);
    const start = Math.max(offset, from), end = Math.min(offset + length, to);
    if (value !== null && end > start) {
      chunks.push(typeof value === "string" ? value.slice(start - offset, end - offset) : OBJ);
      for (let index = start; index < end; index++) positions.push(index);
    }
    offset += length;
  }
  return offset === text.length ? { positions, text: chunks.join("") } : null;
}
