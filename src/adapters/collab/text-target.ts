import * as Y from "yjs";
import { readMarkChange } from "../../core/collab/read-operation.ts";
import type { SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState, assertSharedDocumentIdle, SharedExecutionWriteError } from "./state.ts";
import { transactSharedDocument } from "./document.ts";

export function createCollabText(handle: SharedDocumentHandle, container: Y.Map<unknown>, title = false): Y.Text {
  assertSharedDocumentIdle(collabState(handle));
  const textKey = title ? "title" : "text", marksKey = title ? "titleMarks" : "markRecords";
  if (container.doc !== collabState(handle).doc) throw new Error("New text requires an attached container in this document");
  if (container.has(textKey) || container.has(marksKey)) throw new Error("Cannot create text or marks for an existing text target");
  const text = new Y.Text();
  transactSharedDocument(handle, "local-command", () => { container.set(textKey, text); container.set(marksKey, new Y.Map<unknown>()); });
  return text;
}

export function readSharedTextTarget(raw: unknown): SharedTextAddress | null {
  return readMarkChange({ kind: "mark", id: "target", by: "", target: raw, observed: [], mark: { kind: "b", value: true } })?.target ?? null;
}

export function collabTextTarget(handle: SharedDocumentHandle, raw: SharedTextAddress) {
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
