import * as Y from "yjs";
import { readMarkChange } from "../../core/collab/read-operation.ts";
import type { SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState, assertSharedDocumentIdle, SharedExecutionWriteError } from "./state.ts";
import { transactSharedDocument } from "./document.ts";
import { resolveSharedTextLocation } from "./text-location.ts";
import { observeSharedStructureIndex } from "./structure-index.ts";
import { bindSharedStructurePlan, resolveSharedStructureOwner, readIndexedStructureSpans } from "./structure-plan.ts";
import { readSharedJoinedTextGeometry } from "./joined-text-geometry.ts";
import type { SharedStructureReadView } from "./structure-read-view.ts";
import { readSharedProjectedTextRuns } from "./projected-text-runs.ts";
import { projectSharedJoinSeparator } from "../../core/collab/projection/joins.ts";
import { readSharedJoinGroup } from "./join-record.ts";

export function createCollabText(handle: SharedDocumentHandle, container: Y.Map<unknown>, title = false): Y.Text {
  assertSharedDocumentIdle(collabState(handle));
  const textKey = title ? "title" : "text", marksKey = title ? "titleMarks" : "markRecords";
  if (container.doc !== collabState(handle).doc) throw new Error("New text requires an attached container in this document");
  if (container.has(textKey) || container.has(marksKey)) throw new Error("Cannot create text or marks for an existing text target");
  const text = new Y.Text();
  transactSharedDocument(handle, "local-command", () => { attachCollabText(container, textKey, marksKey, text); });
  return text;
}

function attachCollabText(container: Y.Map<unknown>, textKey: string, marksKey: string, text = new Y.Text()): Y.Text {
  container.set(textKey, text); container.set(marksKey, new Y.Map<unknown>());
  return text;
}

export function applySharedTextCreation(handle: SharedDocumentHandle, description: { readonly path: readonly string[]; readonly title: boolean }): void {
  const state = collabState(handle);
  if (!state.execution?.applying) throw new SharedExecutionWriteError();
  let container: unknown = state.roots[description.path[0] as keyof typeof state.roots];
  for (const key of description.path.slice(1)) container = (container as Y.Map<unknown>).get(key);
  attachCollabText(container as Y.Map<unknown>, description.title ? "title" : "text", description.title ? "titleMarks" : "markRecords");
}

export function readSharedTextTarget(raw: unknown): SharedTextAddress | null {
  return readMarkChange({ kind: "mark", id: "target", by: "", target: raw, observed: [], mark: { kind: "b", value: true } })?.target ?? null;
}

function nativeStructureView(handle: SharedDocumentHandle) {
  const state = collabState(handle);
  const index = observeSharedStructureIndex(handle);
  const get = (path: readonly string[]): unknown => {
    let value: unknown = state.roots[path[0] as keyof typeof state.roots];
    for (const key of path.slice(1)) { if (!(value instanceof Y.Map)) return undefined; value = value.get(key); }
    return value;
  };
  const held = new Map<string, unknown>();
    const view: SharedStructureReadView = { get, has: path => {
      const parent = get(path.slice(0, -1)); return parent instanceof Y.Map && parent.has(path.at(-1) as string);
    }, scratch: <T>(key: string, create: () => T): T => { if (!held.has(key)) held.set(key, create()); return held.get(key) as T; }, kind: path => {
      const value = get(path); return value instanceof Y.Map ? "map" : value instanceof Y.Text ? "text" : value instanceof Y.Array ? "array" : value === undefined ? "missing" : "value";
    } };
  bindSharedStructurePlan(view, index);
  return { index, get, view };
}

export function collabProjectedTextTarget(handle: SharedDocumentHandle, raw: SharedTextAddress) {
  try {
    const { index, get, view } = nativeStructureView(handle);
    const resolveOwner = (owner: string, field: "audioText" | "heading") => resolveSharedStructureOwner(view, owner, field);
    if (raw.field === "audioText") {
      const owner = resolveOwner(raw.owner, "audioText"); if (!owner) return null;
      const geometry = readSharedJoinedTextGeometry(view, owner.owner); if (!geometry || geometry.removed) return null;
      const fragments = raw.segment === raw.owner ? geometry.root === owner.owner ? geometry.parts : geometry.parts.filter(part => part.owner === owner.owner)
        : geometry.parts.filter(part => part.segment === raw.segment && (geometry.root === owner.owner || part.owner === owner.owner));
      const parts = fragments.map(fragment => {
        const physical = physicalTextTarget(handle, { owner: fragment.owner as SharedTextAddress["owner"], segment: fragment.segment as SharedTextAddress["segment"], field: "audioText" });
        return physical && physical.container.get(physical.marksKey) instanceof Y.Map ? { ...physical, from: fragment.from, to: fragment.to, glue: fragment.glue,
          group: fragment.group, cyclic: geometry.cyclic, ...(fragment.glueSet ? { glueSet: true as const } : {}) } : null;
      });
      const first = parts[0]; if (!first || parts.some(part => part === null)) return null;
      return { ...first, parts: parts.filter((part): part is NonNullable<typeof part> => part !== null) };
    }
    const found = resolveSharedTextLocation({ get, kind: view.kind, resolveOwner }, raw);
    const physical = physicalTextTarget(handle, found.target);
    if (!physical) return null;
    const span = found.target.field === "heading"
      ? readIndexedStructureSpans(index, found.target.segment).find(block => block.id === found.target.owner && block.kind === (found.target.field === "heading" ? "h" : "b"))
      : { from: 0, to: physical.text.length };
    if (!span) return null;
    const part = { ...physical, from: span.from, to: span.to, glue: "" as const, group: null, cyclic: false };
    return { ...part, parts: [part] };
  } catch { return null; }
}

export function collabTextTarget(handle: SharedDocumentHandle, raw: SharedTextAddress) {
  return raw.field === "title" ? collabPurposeTextTarget(handle, raw, "opaque-title-label") : collabProjectedTextTarget(handle, raw);
}

export function collabPurposeTextTarget(handle: SharedDocumentHandle, raw: SharedTextAddress, purpose: "stored-anchor-read" | "hydration-write" | "opaque-title-label") {
  const allowed = purpose === "stored-anchor-read" || purpose === "hydration-write" && collabState(handle).activeOrigin === "hydration"
    || purpose === "opaque-title-label" && raw.field === "title";
  if (!allowed) return null;
  const found = physicalTextTarget(handle, raw);
  return found ? { ...found, from: 0, to: found.text.length } : null;
}

export function collabWritingTextTarget(handle: SharedDocumentHandle, raw: SharedTextAddress) {
  return collabState(handle).activeOrigin === "hydration" ? collabPurposeTextTarget(handle, raw, "hydration-write") : collabTextTarget(handle, raw);
}

function projectedParts(found: NonNullable<ReturnType<typeof collabWritingTextTarget>>): found is NonNullable<ReturnType<typeof collabProjectedTextTarget>> {
  return "parts" in found;
}

export function collabWritingTextPosition(handle: SharedDocumentHandle, raw: SharedTextAddress, offset: number) {
  const found = collabWritingTextTarget(handle, raw);
  if (!found || !Number.isInteger(offset) || offset < 0) return null;
  if (raw.segment !== raw.owner || !projectedParts(found)) return offset >= found.from && offset <= found.to ? { ...found, offset } : null;
  let value = "";
  for (const [index, part] of found.parts.entries()) {
    const reading = readSharedProjectedTextRuns(part.text, part.from, part.to); if (!reading) return null;
    const glue = projectSharedJoinSeparator(value, reading.text, part.glue, index, part.cyclic, "glueSet" in part && part.glueSet === true);
    value += glue; const start = value.length;
    if (offset >= start && offset <= start + reading.positions.length) return { ...part, offset: reading.positions[offset - start] ?? part.to };
    value += reading.text;
  }
  return null;
}

export function collabStoredJoinGluePosition(handle: SharedDocumentHandle, group: string, after: boolean) {
  const parsed = readSharedJoinGroup(group); if (!parsed) return null;
  const { view } = nativeStructureView(handle), geometry = readSharedJoinedTextGeometry(view, parsed.from);
  const index = geometry?.parts.findIndex(part => part.group === group) ?? -1;
  const part = geometry?.parts[after ? index : index - 1]; if (index < 1 || !part) return null;
  const found = physicalTextTarget(handle, { owner: part.owner as SharedTextAddress["owner"], segment: part.segment as SharedTextAddress["segment"], field: "audioText" });
  return found ? { ...found, offset: after ? part.from : part.to } : null;
}

export function collabProjectedTextOffset(handle: SharedDocumentHandle, raw: SharedTextAddress, segment: string, offset: number): number | null {
  const found = collabProjectedTextTarget(handle, raw); if (!found) return null;
  let value = "";
  for (const [index, part] of found.parts.entries()) {
    const reading = readSharedProjectedTextRuns(part.text, part.from, part.to); if (!reading) return null;
    value += projectSharedJoinSeparator(value, reading.text, part.glue, index, part.cyclic, "glueSet" in part && part.glueSet === true);
    if (part.target.segment === segment && offset >= part.from && offset <= part.to) return value.length + reading.positions.filter(position => position < offset).length;
    value += reading.text;
  }
  return null;
}

export function collabProjectedNarrationPoint(handle: SharedDocumentHandle, segment: string, offset: number) {
  const { index, view } = nativeStructureView(handle);
  const span = readIndexedStructureSpans(index, segment).find(block => block.kind === "b" && block.from <= offset && offset <= block.to);
  const geometry = span?.id ? readSharedJoinedTextGeometry(view, span.id) : null;
  if (!geometry || geometry.removed) return null;
  const owner = geometry.root as SharedTextAddress["owner"];
  const projected = collabProjectedTextOffset(handle, { owner, segment: owner, field: "audioText" }, segment, offset);
  return projected === null ? null : { owner, offset: projected };
}

export function collabProjectedSegmentAnchorTarget(handle: SharedDocumentHandle, segment: string, offset: number) {
  const index = observeSharedStructureIndex(handle), span = readIndexedStructureSpans(index, segment).find(block => block.from <= offset && block.to >= offset);
  return span?.id ? collabWritingTextTarget(handle, { owner: span.id as SharedTextAddress["owner"], segment: segment as SharedTextAddress["segment"], field: span.kind === "h" ? "heading" : "audioText" }) : null;
}

function physicalTextTarget(handle: SharedDocumentHandle, raw: SharedTextAddress) {
  const target = readSharedTextTarget(raw);
  if (!target) return null;
  const { roots } = collabState(handle);
  const container = target.field === "title" ? roots.meta : target.field === "visualText" ? roots.visuals.get(target.segment) : roots.segments.get(target.segment);
  if (!(container instanceof Y.Map)) return null;
  const text: unknown = container.get(target.field === "title" ? "title" : "text");
  return text instanceof Y.Text ? { target, container, text, marksKey: target.field === "title" ? "titleMarks" : "markRecords" } : null;
}

export function collabPreparedOperationTextTarget(handle: SharedDocumentHandle, target: SharedTextAddress) {
  const state = collabState(handle);
  if (!state.execution?.applying) throw new SharedExecutionWriteError();
  const container = (target.field === "title" ? state.roots.meta : target.field === "visualText" ? state.roots.visuals.get(target.segment) : state.roots.segments.get(target.segment)) as Y.Map<unknown>;
  return { text: container.get(target.field === "title" ? "title" : "text") as Y.Text,
    store: container.get(target.field === "title" ? "titleMarks" : "markRecords") as Y.Map<unknown> };
}
