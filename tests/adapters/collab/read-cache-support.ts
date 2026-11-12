import assert from "node:assert/strict";
import * as Y from "yjs";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { readCollabMarkState } from "../../../src/adapters/collab/mark-store.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { readSharedContentRef } from "../../../src/core/collab/read-operation.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

export function cacheText(handle: SharedDocumentHandle, row = "R1") {
  const container = collabState(handle).roots.segments.get("b:" + row);
  assert.ok(container instanceof Y.Map);
  const text: unknown = container.get("text"), store: unknown = container.get("markRecords");
  assert.ok(text instanceof Y.Text); assert.ok(store instanceof Y.Map);
  return { container, text, store };
}

export function cacheMarks(handle: SharedDocumentHandle, row = "R1") {
  const { text, store } = cacheText(handle, row);
  return readCollabMarkState(handle, text, store).characters.map(character => ({ value: character.value,
    marks: character.marks.flatMap(group => group.values.map(value => [group.kind, value])) }));
}

export function cacheStatus(handle: SharedDocumentHandle, row = "R1"): { value: unknown; keys: readonly string[] } {
  const record = readSharedContentRef(row); assert.ok(record);
  const preparation = createSharedPreparation(handle);
  try {
    const keys = preparation.view.statusEvents({ scope: "beat", record });
    return { value: keys.map(key => preparation.view.get(["statusEvents", key])), keys };
  } finally { preparation.close(); }
}
