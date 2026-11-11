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
      const next = new Map<string, PaintedText>(), shown = source.documentRevision();
      for (const row of rows) {
        const read = source.read(row.id, "audioText");
        // why: equal text is not proof; a later revision can hold the same string in other units, so the
        // record must be of the revision that was painted, and its units must be the painted ones one for one
        if (read && read.revision === shown && read.text === painted(row)) next.set(row.id, read);
      }
      bases = next;
    },
    base: rowId => bases.get(rowId) ?? null,
    clear: () => { bases = new Map(); }
  };
}
