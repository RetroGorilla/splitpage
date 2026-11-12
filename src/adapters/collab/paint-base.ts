import * as Y from "yjs";
import type { PaintedText } from "../../application/editing/ports.ts";
import type { SharedContentRef, SharedTextAddress } from "../../core/collab/operations.ts";
import { OBJ } from "../../core/text/runs.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { encodeCollabTextAnchor, readSharedAnchor } from "./anchors.ts";
import { readSharedRevision } from "./document.ts";
import { sharedStructureSpans } from "./structure-spans.ts";
import { createSharedPreparation } from "./prepare.ts";
import { collabProjectedTextTarget } from "./text-target.ts";

export function readSharedPaintedText(handle: SharedDocumentHandle, address: SharedTextAddress): PaintedText | null {
  const found = collabProjectedTextTarget(handle, address);
  if (!found) return null;
  const { target } = found, revision = readSharedRevision(handle);
  let whole = "";
  const units: { readonly value: unknown }[] = [];
  for (const delta of found.text.toDelta() as { insert: unknown }[]) {
    if (typeof delta.insert !== "string") { whole += OBJ; units.push({ value: delta.insert }); continue; }
    whole += delta.insert;
    for (let index = 0; index < delta.insert.length; index++) units.push({ value: delta.insert.charAt(index) });
  }
  if (whole.length !== found.text.length) return null;
  let positions = Array.from({ length: whole.length }, (_, index) => index);
  let end = whole.length;
  if (target.field === "visualText" && found.container.get("beat") !== target.owner) return null;
  if (target.field === "audioText" || target.field === "heading") {
    const preparation = createSharedPreparation(handle);
    try {
      preparation.view.resolveOwner(target.owner, target.field);
      const span = sharedStructureSpans(preparation.view, target.segment, units).find(span => span.owner === target.owner && span.field === target.field);
      if (!span) return null;
      positions = span.positions;
      end = span.to;
    } finally { preparation.close(); }
  }
  const length = positions.length;
  // why: units typed together have consecutive clocks, so the record keeps runs and builds an anchor only when asked
  const starts: number[] = [], clients: number[] = [], clocks: number[] = [];
  for (let index = 0; index < length; index++) {
    const id = Y.createRelativePositionFromTypeIndex(found.text, positions[index] as number, 0).item;
    if (!id) return null;
    const run = starts.length - 1, start = starts[run], clock = clocks[run];
    if (start !== undefined && clock !== undefined && clients[run] === id.client && clock + index - start === id.clock) continue;
    starts.push(index); clients.push(id.client); clocks.push(id.clock);
  }
  // why: anchors.ts owns how an anchor is framed; only the position inside the frame differs per unit.
  const frame = length ? JSON.parse(encodeCollabTextAnchor(found.text, target, positions[0] as number, "after")) as Record<string, unknown> : null;
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
  const endGap = encodeCollabTextAnchor(found.text, target, end, "before");
  return Object.freeze({ revision, text: positions.map(position => whole.charAt(position)).join(""), identity, endGap, ...(length ? {} : { emptyGap: endGap }) });
}
