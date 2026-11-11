import * as Y from "yjs";
import { chooseSharedProjectionPayload } from "../../core/collab/projection/text.ts";
import type { SharedProjectionUnit } from "../../core/collab/projection/units.ts";
import type { SharedInlineValue } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { readCollabMarkState } from "./mark-store.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { readSharedStoredMark } from "./stored-mark.ts";
import { readProjectionInlineValue } from "./projection-reader.ts";

export function readProjectionUnits(handle: SharedDocumentHandle, raw: unknown, store: unknown): SharedProjectionUnit[] {
  if (!(raw instanceof Y.Text)) return [];
  const characters = readCollabMarkState(handle, raw, store).characters, units: SharedProjectionUnit[] = [];
  let offset = 0;
  for (const delta of raw.toDelta() as { insert: unknown }[]) {
    const insert = readProjectionInlineValue(delta.insert), values: SharedInlineValue[] = [];
    if (typeof insert === "string") for (let index = 0; index < insert.length; index++) values.push(insert.charAt(index));
    else if (insert) values.push(insert);
    else { offset++; continue; }
    for (const value of values) {
      const marks: SharedProjectionUnit["marks"][number][] = [];
      for (const group of characters[offset++]?.marks ?? []) {
        const payload = chooseSharedProjectionPayload(group.values);
        if (payload === undefined || group.id !== null && !isStableSharedIdentity(group.id)) continue;
        const mark = readSharedStoredMark({ kind: group.kind, ...(group.id === null ? {} : { id: group.id }), value: payload });
        if (mark) marks.push(mark);
      }
      units.push({ value, marks });
    }
  }
  return units;
}
