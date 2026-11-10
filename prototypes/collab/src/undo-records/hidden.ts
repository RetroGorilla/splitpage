import type * as Y from "yjs";
import type { CollabCaret, CollabCharacter, CollabModel, CollabRow } from "../model.ts";

export const hiddenKey = "hidden";

export function isHidden(attributes: Record<string, unknown> | undefined): boolean {
  return attributes?.[hiddenKey] === true;
}

export function textIndex(text: Y.Text, start: number, visible: number): number {
  let index = 0;
  let seen = 0;
  for (const delta of text.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
    const length = typeof delta.insert === "string" ? delta.insert.length : 1;
    const hidden = typeof delta.insert === "string" && isHidden(delta.attributes);
    for (let offset = 0; offset < length; offset++, index++) {
      if (index < start || hidden) continue;
      if (seen === visible) return index;
      seen++;
    }
  }
  if (seen === visible) return index;
  throw new Error(`Visible offset ${visible} is past the text`);
}

function shown(character: CollabCharacter): boolean {
  return character.marks[hiddenKey] !== true;
}

function visibleOffset(row: CollabRow | undefined, offset: number): number {
  return row ? row.characters.slice(0, offset).filter(shown).length : offset;
}

function visibleRow(row: CollabRow): CollabRow {
  return { ...row, characters: row.characters.filter(shown), ...(row.visuals ? { visuals: row.visuals.map(visibleRow) } : {}) };
}

export function visibleModel(model: CollabModel): CollabModel {
  const rows = new Map([...model.rows, ...model.recovery.map(entry => entry.row)].map(row => [row.id, row]));
  const carets: Record<string, CollabCaret> = {};
  for (const [name, caret] of Object.entries(model.carets)) {
    const row = rows.get(caret.beat);
    carets[name] = {
      beat: caret.beat, offset: visibleOffset(row, caret.offset),
      ...(caret.selection ? { selection: { beat: caret.selection.beat, from: visibleOffset(rows.get(caret.selection.beat), caret.selection.from), to: visibleOffset(rows.get(caret.selection.beat), caret.selection.to) } } : {})
    };
  }
  return { ...model, rows: model.rows.map(visibleRow), carets, recovery: model.recovery.map(entry => ({ ...entry, row: visibleRow(entry.row) })) };
}
