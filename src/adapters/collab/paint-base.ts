import * as Y from "yjs";
import type { PaintedText } from "../../application/editing/ports.ts";
import type { SharedContentRef, SharedTextAddress } from "../../core/collab/operations.ts";
import { OBJ } from "../../core/text/runs.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { encodeCollabTextAnchor, readSharedAnchor } from "./anchors.ts";
import { readSharedRevision } from "./document.ts";
import { sharedStructureSpans } from "./structure-boundary.ts";
import { collabTextTarget } from "./text-target.ts";

const TEXT_UNIT = Object.freeze({ value: "" });

export function readSharedPaintedText(handle: SharedDocumentHandle, address: SharedTextAddress): PaintedText | null {
  const found = collabTextTarget(handle, address);
  if (!found) return null;
  const { target } = found, revision = readSharedRevision(handle);
  let whole = "";
  const units: { readonly value: unknown }[] = [];
  for (const delta of found.text.toDelta() as { insert: unknown }[]) {
    if (typeof delta.insert !== "string") { whole += OBJ; units.push({ value: delta.insert }); continue; }
    whole += delta.insert;
    for (let index = 0; index < delta.insert.length; index++) units.push(TEXT_UNIT);
  }
  if (whole.length !== found.text.length) return null;
  let from = 0, to = whole.length;
  if (target.field === "visualText" && found.container.get("beat") !== target.owner) return null;
  if (target.field === "audioText" || target.field === "heading") {
    // why: a split keeps one physical text for several beats; a beat's units are the span its boundaries give it
    const span = sharedStructureSpans(found.container.get("head"), units).find(span => span.owner === target.owner && span.field === target.field);
    if (!span) return null;
    from = span.from; to = span.to;
  }
  const length = to - from;
  // why: units typed together have consecutive clocks, so the record keeps runs and builds an anchor only when asked
  const starts: number[] = [], clients: number[] = [], clocks: number[] = [];
  for (let index = 0; index < length; index++) {
    const id = Y.createRelativePositionFromTypeIndex(found.text, from + index, 0).item;
    if (!id) return null;
    const run = starts.length - 1, start = starts[run], clock = clocks[run];
    if (start !== undefined && clock !== undefined && clients[run] === id.client && clock + index - start === id.clock) continue;
    starts.push(index); clients.push(id.client); clocks.push(id.clock);
  }
  // why: anchors.ts owns how an anchor is framed; only the position inside the frame differs per unit.
  const frame = length ? JSON.parse(encodeCollabTextAnchor(found.text, target, from, "after")) as Record<string, unknown> : null;
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
  const endGap = encodeCollabTextAnchor(found.text, target, to, "before");
  return Object.freeze({ revision, text: whole.slice(from, to), identity, endGap, ...(length ? {} : { emptyGap: endGap }) });
}
