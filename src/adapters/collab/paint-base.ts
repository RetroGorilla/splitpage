import * as Y from "yjs";
import type { PaintedText } from "../../application/editing/ports.ts";
import type { SharedContentRef, SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { encodeCollabTextAnchor, readSharedAnchor } from "./anchors.ts";
import { readSharedRevision } from "./document.ts";
import { collabProjectedTextTarget, collabProjectedVisualTargets } from "./text-target.ts";
import { readSharedProjectedTextRuns } from "./projected-text-runs.ts";
import { sharedJoinGlueReference } from "./join-glue-reference.ts";
import { projectSharedJoinSeparator } from "../../core/collab/projection/joins.ts";

function partReading(part: { readonly text: Y.Text; readonly target: SharedTextAddress; readonly from: number; readonly to: number }) {
  const runs = readSharedProjectedTextRuns(part.text, part.from, part.to); if (!runs) return null;
  const { positions } = runs;
  const length = positions.length, starts: number[] = [], clients: number[] = [], clocks: number[] = [];
  for (let index = 0; index < length; index++) {
    const id = Y.createRelativePositionFromTypeIndex(part.text, positions[index] as number, 0).item; if (!id) return null;
    const run = starts.length - 1, start = starts[run], clock = clocks[run];
    if (start !== undefined && clock !== undefined && clients[run] === id.client && clock + index - start === id.clock) continue;
    starts.push(index); clients.push(id.client); clocks.push(id.clock);
  }
  const frame = length ? JSON.parse(encodeCollabTextAnchor(part.text, part.target, positions[0] as number, "after")) as Record<string, unknown> : null;
  function identity(index: number): SharedContentRef | null {
    if (!frame || !Number.isInteger(index) || index < 0 || index >= length) return null;
    let low = 0, high = starts.length - 1;
    while (low < high) { const middle = (low + high + 1) >> 1; if ((starts[middle] as number) <= index) low = middle; else high = middle - 1; }
    const item = { client: clients[low] as number, clock: (clocks[low] as number) + index - (starts[low] as number) };
    const relative = [...Y.encodeRelativePosition(Y.createRelativePositionFromJSON({ item, assoc: 0 }))];
    return readSharedAnchor(JSON.stringify({ ...frame, relative }));
  }
  return { text: runs.text, identity, endGap: encodeCollabTextAnchor(part.text, part.target, part.to, "before") };
}

function paintedText(handle: SharedDocumentHandle, address: SharedTextAddress, selection: boolean): PaintedText | null {
  const visuals = selection && address.field === "visualText";
  const found = visuals ? collabProjectedVisualTargets(handle, address) : collabProjectedTextTarget(handle, address); if (!found) return null;
  const pieces: { readonly from: number; readonly length: number; readonly identity: (index: number) => SharedContentRef | null }[] = [];
  let text = "", endGap: SharedContentRef | null = null;
  let preceding: string | null = null;
  for (const [index, part] of found.parts.entries()) {
    const read = partReading(part); if (!read) return null;
    const reading = selection ? { ...read, text: read.text.replace(/\p{Cs}/gu, "\ufffd") } : read;
    const glue = visuals ? text.length && reading.text.length ? "\n" : ""
      : projectSharedJoinSeparator(text, reading.text, part.glue, index, part.cyclic, "glueSet" in part && part.glueSet === true);
    if (glue && (part.group || visuals)) {
      const reference = visuals ? JSON.stringify(["painted-visual-break", preceding, part.target.segment]) as SharedContentRef : sharedJoinGlueReference(part.group as string);
      pieces.push({ from: text.length, length: 1, identity: () => reference }); text += glue;
    }
    if (reading.text.length) pieces.push({ from: text.length, length: reading.text.length, identity: reading.identity });
    text += reading.text; endGap = reading.endGap;
    if (reading.text.length) preceding = part.target.segment;
  }
  if (!endGap) return null;
  const length = text.length;
  function identity(index: number): SharedContentRef | null {
    if (!Number.isInteger(index) || index < 0 || index >= length) return null;
    let low = 0, high = pieces.length - 1;
    while (low < high) { const middle = (low + high + 1) >> 1; if ((pieces[middle]?.from ?? Infinity) <= index) low = middle; else high = middle - 1; }
    const part = pieces[low]; return part && index < part.from + part.length ? part.identity(index - part.from) : null;
  }
  return Object.freeze({ revision: readSharedRevision(handle), text, identity, endGap, ...(length ? {} : { emptyGap: endGap }) });
}

export function readSharedPaintedText(handle: SharedDocumentHandle, address: SharedTextAddress): PaintedText | null {
  return paintedText(handle, address, false);
}

export function readSharedPaintedSelectionText(handle: SharedDocumentHandle, address: SharedTextAddress): PaintedText | null {
  try { return paintedText(handle, address, true); } catch { return null; }
}
