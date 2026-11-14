import type { PaintedText, PaintedTextSource } from "./ports.ts";
import { bufferedFieldTarget } from "./buffered-field-key.ts";

export interface PaintedBeats {
  readonly record: <R extends { readonly id: string }>(rows: readonly R[], painted: (row: R) => string) => void;
  readonly base: (rowId: string) => PaintedText | null;
  readonly text: (rowId: string) => string | undefined;
  readonly field: (rowId: string, text: string) => void;
  readonly stored: (rowId: string) => string | null;
  readonly current: (rowId: string) => PaintedText | null;
  readonly clear: () => void;
}

export function createPaintedBeats(source: PaintedTextSource): PaintedBeats {
  let bases = new Map<string, PaintedText>();
  let texts = new Map<string, string>();
  const readField = (key: string): PaintedText | null => {
    const target = bufferedFieldTarget(key);
    return target ? source.read(key, target.field) : null;
  };
  function field(rowId: string, text: string): void {
    texts.set(rowId, text);
    const shown = source.documentRevision(), read = readField(rowId);
    if (read && read.revision === shown && read.text === text) bases.set(rowId, read);
    else bases.delete(rowId);
  }
  return {
    record: (rows, painted) => {
      const next = new Map<string, PaintedText>(), shown = source.documentRevision(), nextTexts = new Map<string, string>();
      for (const row of rows) {
        const text = painted(row); nextTexts.set(row.id, text);
        const read = readField(row.id);
        // why: equal text is not proof; a later revision can hold the same string in other units, so the
        // record must be of the revision that was painted, and its units must be the painted ones one for one
        if (read && read.revision === shown && read.text === text) next.set(row.id, read);
      }
      bases = next;
      texts = nextTexts;
    },
    base: rowId => bases.get(rowId) ?? null,
    text: rowId => texts.get(rowId), field,
    stored: rowId => readField(rowId)?.text ?? null,
    current: readField,
    clear: () => { bases = new Map(); texts = new Map(); }
  };
}
