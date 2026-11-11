import * as Y from "yjs";
import type { PaintedText } from "../../application/editing/ports.ts";
import type { SharedContentRef, SharedTextAddress } from "../../core/collab/operations.ts";
import { OBJ } from "../../core/text/runs.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { encodeCollabTextAnchor, readSharedAnchor } from "./anchors.ts";
import { readSharedRevision } from "./document.ts";
import { collabTextTarget } from "./text-target.ts";

export function readSharedPaintedText(handle: SharedDocumentHandle, address: SharedTextAddress): PaintedText | null {
  const found = collabTextTarget(handle, address);
  if (!found) return null;
  const revision = readSharedRevision(handle), length = found.text.length;
  let text = "";
  for (const delta of found.text.toDelta() as { insert: unknown }[]) text += typeof delta.insert === "string" ? delta.insert : OBJ;
  if (text.length !== length) return null;
  // why: units typed together have consecutive clocks, so runs keep the record small; an anchor string per
  // painted unit would hold megabytes for a long script.
  const starts: number[] = [], clients: number[] = [], clocks: number[] = [];
  for (let index = 0; index < length; index++) {
    const id = Y.createRelativePositionFromTypeIndex(found.text, index, 0).item;
    if (!id) return null;
    const run = starts.length - 1, start = starts[run], clock = clocks[run];
    if (start !== undefined && clock !== undefined && clients[run] === id.client && clock + index - start === id.clock) continue;
    starts.push(index); clients.push(id.client); clocks.push(id.clock);
  }
  // why: anchors.ts owns how an anchor is framed; only the position inside the frame differs per unit.
  const frame = length ? JSON.parse(encodeCollabTextAnchor(found.text, found.target, 0, "after")) as Record<string, unknown> : null;
  function identity(index: number): SharedContentRef | null {
    if (!frame || !Number.isInteger(index) || index < 0 || index >= length) return null;
    let low = 0, high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((starts[middle] as number) <= index) low = middle;
      else high = middle - 1;
    }
    const item = { client: clients[low] as number, clock: (clocks[low] as number) + index - (starts[low] as number) };
    const relative = [...Y.encodeRelativePosition(Y.createRelativePositionFromJSON({ item, assoc: 0 }))];
    return readSharedAnchor(JSON.stringify({ ...frame, relative }));
  }
  return Object.freeze({ revision, text, identity });
}
