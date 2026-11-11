import * as Y from "yjs";
import { readTextInsert } from "../../core/collab/read-operation.ts";
import { chooseSharedProjectionPayload } from "../../core/collab/projection/text.ts";
import type { SharedProjectionUnit } from "../../core/collab/projection/text.ts";
import type { SharedInlineValue } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { readCollabMarkState } from "./mark-store.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { sharedJson } from "./snapshot.ts";
import { readSharedStoredMark } from "./stored-mark.ts";

function inline(raw: unknown): SharedInlineValue | null {
  const atom = sharedJson(raw);
  if (typeof atom === "string") return atom;
  if (!atom || typeof atom !== "object" || Array.isArray(atom)) return null;
  const item = atom as Record<string, unknown>;
  const value = "k" in item ? { atom: "broll", id: item.k, ...(item.label === undefined ? {} : { text: item.label }) }
    : "w" in item ? { atom: "who", name: item.w } : "img" in item ? { atom: "image", ref: item.img }
    : { atom: "video", href: item.video, host: item.host };
  const read = readTextInsert({ kind: "text-insert", id: "projection", by: "", target: { owner: "projection", segment: "projection", field: "audioText" }, at: { left: null, right: null, affinity: "before" }, content: [{ value, marks: [] }] })?.content[0]?.value;
  return read && (typeof read === "string" || read.atom !== "broll" || isStableSharedIdentity(read.id)) ? read : null;
}
export function readProjectionUnits(handle: SharedDocumentHandle, raw: unknown, store: unknown): SharedProjectionUnit[] {
  if (!(raw instanceof Y.Text)) return [];
  const characters = readCollabMarkState(handle, raw, store).characters, units: SharedProjectionUnit[] = [];
  let offset = 0;
  for (const delta of raw.toDelta() as { insert: unknown }[]) {
    const insert = inline(delta.insert), values: SharedInlineValue[] = [];
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
