import * as Y from "yjs";
import { readMarkChange } from "../../core/collab/read-operation.ts";
import type { SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState, assertSharedDocumentIdle, SharedExecutionWriteError } from "./state.ts";
import { transactSharedDocument } from "./document.ts";
import { resolveSharedTextLocation } from "./text-location.ts";
import { observeSharedStructureIndex } from "./structure-index.ts";
import { resolveIndexedStructureOwner } from "./structure-plan.ts";

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

export function collabProjectedTextTarget(handle: SharedDocumentHandle, raw: SharedTextAddress) {
  const state = collabState(handle);
  const index = observeSharedStructureIndex(handle);
  const get = (path: readonly string[]): unknown => {
    let value: unknown = state.roots[path[0] as keyof typeof state.roots];
    for (const key of path.slice(1)) { if (!(value instanceof Y.Map)) return undefined; value = value.get(key); }
    return value;
  };
  try {
    const found = resolveSharedTextLocation({ get, kind: path => {
      const value = get(path); return value instanceof Y.Map ? "map" : value instanceof Y.Text ? "text" : value instanceof Y.Array ? "array" : value === undefined ? "missing" : "value";
    }, resolveOwner: (owner, field) => resolveIndexedStructureOwner(index, owner, field) }, raw);
    return collabPhysicalTextTarget(handle, found.target);
  } catch { return null; }
}

export function collabTextTarget(handle: SharedDocumentHandle, raw: SharedTextAddress) {
  return collabProjectedTextTarget(handle, raw) ?? collabPhysicalTextTarget(handle, raw);
}

export function collabPhysicalTextTarget(handle: SharedDocumentHandle, raw: SharedTextAddress) {
  const target = readSharedTextTarget(raw);
  if (!target) return null;
  const { roots } = collabState(handle);
  const container = target.field === "title" ? roots.meta : target.field === "visualText" ? roots.visuals.get(target.segment) : roots.segments.get(target.segment);
  if (!(container instanceof Y.Map)) return null;
  const text: unknown = container.get(target.field === "title" ? "title" : "text");
  return text instanceof Y.Text ? { target, container, text, marksKey: target.field === "title" ? "titleMarks" : "markRecords" } : null;
}

export function collabApplyingTextTarget(handle: SharedDocumentHandle, target: SharedTextAddress) {
  const state = collabState(handle);
  if (!state.execution?.applying) throw new SharedExecutionWriteError();
  const container = (target.field === "title" ? state.roots.meta : target.field === "visualText" ? state.roots.visuals.get(target.segment) : state.roots.segments.get(target.segment)) as Y.Map<unknown>;
  return { text: container.get(target.field === "title" ? "title" : "text") as Y.Text,
    store: container.get(target.field === "title" ? "titleMarks" : "markRecords") as Y.Map<unknown> };
}
