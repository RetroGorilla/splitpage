import type { PaintedText, PaintedTextSource } from "../../application/editing/ports.ts";
import type { FlowRow } from "../../core/flow/flow.ts";

export interface PaintedBeats {
  readonly record: (rows: readonly FlowRow[], painted: (row: FlowRow) => string) => void;
  readonly base: (rowId: string) => PaintedText | null;
  readonly clear: () => void;
}

export function createPaintedBeats(source: PaintedTextSource): PaintedBeats {
  let bases = new Map<string, PaintedText>();
  return {
    record: (rows, painted) => {
      const next = new Map<string, PaintedText>();
      for (const row of rows) {
        const read = source.read(row.id, "audioText");
        // why: an offset names a shared unit only while the painted text equals the shared text unit for unit
        if (read && read.text === painted(row)) next.set(row.id, read);
      }
      bases = next;
    },
    base: rowId => bases.get(rowId) ?? null,
    clear: () => { bases = new Map(); }
  };
}
