import type * as Y from "yjs";
import type { SharedDocumentHandle } from "./types.ts";
import type { SharedMarkedCharacter } from "./mark-record.ts";
import { collabState } from "./state.ts";
import type { SharedResolvedMarkRecord } from "./mark-store.ts";
import { readCollabMarkState } from "./mark-store.ts";
import type { SharedTextAnchorLocation } from "./anchors.ts";
import { resolveCollabTextAnchor } from "./anchors.ts";
import { freezeSharedPreparedValue, sharedPreparedTextInsert } from "./prepare-value.ts";

export interface SharedPreparedTextUnit {
  readonly value: unknown;
  readonly identity: SharedMarkedCharacter["identity"];
  readonly marks: SharedMarkedCharacter["marks"];
}
export interface SharedPreparationText {
  readonly length: number;
  readonly units: readonly SharedPreparedTextUnit[];
  readonly recordKeys: readonly string[];
  readonly records: readonly SharedResolvedMarkRecord[];
  readonly resolveAnchor: (anchor: unknown) => SharedTextAnchorLocation;
}

export function createCollabTextFacade(handle: SharedDocumentHandle, text: Y.Text, store: unknown, ensureOpen: () => void): SharedPreparationText {
  const state = readCollabMarkState(handle, text, store);
  const data = collabState(handle).reads.memo([state], "prepared-text", () => {
    const values: unknown[] = [];
    for (const delta of text.toDelta()) {
      const value = sharedPreparedTextInsert(delta.insert);
      if (typeof delta.insert === "string") for (const unit of (value as string).split("")) values.push(unit);
      else values.push(value);
    }
    return freezeSharedPreparedValue({ length: text.length,
      units: state.characters.map((char, index) => ({ value: values[index], identity: char.identity, marks: char.marks })),
      recordKeys: state.recordKeys, records: state.records });
  });
  return Object.freeze({ ...data,
    resolveAnchor: (anchor: unknown) => { ensureOpen(); return freezeSharedPreparedValue(resolveCollabTextAnchor(handle, anchor, text)); }
  });
}
