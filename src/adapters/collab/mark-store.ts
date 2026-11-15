import * as Y from "yjs";
import type { SharedTextAddress } from "../../core/collab/operations.ts";
import { collabTextTarget, collabWritingTextTarget, collabPurposeTextTarget, collabPreparedOperationTextTarget } from "./text-target.ts";
import { resolveCollabTextAnchor } from "./anchor-codec.ts";
import { encodeCollabTextAnchor } from "./anchors.ts";
import { transactSharedDocument } from "./document.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState, assertSharedDocumentIdle } from "./state.ts";
import { readSharedMarkRecord, sharedMarkRecordKey } from "./mark-record.ts";
import type { SharedMarkRecord, SharedMarkedCharacter } from "./mark-record.ts";
import { prepareSharedMarkWrite } from "./mark-plan.ts";
import type { SharedMarkWritePlan, SharedMarkWriteChangeInput } from "./mark-plan.ts";
import type { SharedMarkBirth } from "./mark-record.ts";
import { readCollabMarkState } from "./mark-state.ts";

export type SharedMarkWriteResult = { readonly ok: true } | { readonly ok: false; readonly reason: "missing-text" | "missing-store" | "invalid-record" | "existing-record" };

function writingIdentity(handle: SharedDocumentHandle) { const state = collabState(handle); return state.hydrating ? "hydration" as const : state.doc.clientID; }

export function writeSharedMarkRecord(handle: SharedDocumentHandle, target: SharedTextAddress, key: string, raw: unknown): SharedMarkWriteResult {
  assertSharedDocumentIdle(collabState(handle));
  const normalized = sharedMarkRecordKey(key, writingIdentity(handle)), record = normalized && readSharedMarkRecord(normalized, raw);
  if (!record) return { ok: false, reason: "invalid-record" };
  const found = collabWritingTextTarget(handle, target);
  if (!found) return { ok: false, reason: "missing-text" };
  const store: unknown = found.container.get(found.marksKey);
  if (!(store instanceof Y.Map)) return { ok: false, reason: "missing-store" };
  const start = resolveCollabTextAnchor(handle, record.start, found.text), end = resolveCollabTextAnchor(handle, record.end, found.text);
  const from = start.kind === "gone" ? null : start.index, to = end.kind === "gone" ? null : end.index;
  if (from === null || to === null || to < from || from < found.from || to > found.to) return { ok: false, reason: "invalid-record" };
  if (store.has(normalized)) return { ok: false, reason: "existing-record" };
  transactSharedDocument(handle, "local-command", () => storeRecord(store, normalized, record));
  return { ok: true };
}

export function prepareSharedMarkRecord(handle: SharedDocumentHandle, target: SharedTextAddress, operation: string, from: number, to: number,
  change: SharedMarkWriteChangeInput): SharedMarkRecord | null {
  const found = collabWritingTextTarget(handle, target);
  if (!found || from < found.from || to > found.to || change.born === "inserted") return null;
  const plan = prepareSharedMarkWrite({ length: found.text.length, recordKeys: [] }, writingIdentity(handle), operation, from, to, change);
  return plan ? anchoredRecord(found.text, found.target, plan, null) : null;
}

function anchoredRecord(text: Y.Text, target: SharedTextAddress, plan: SharedMarkWritePlan, inserted: SharedMarkBirth | null): SharedMarkRecord {
  const start = encodeCollabTextAnchor(text, target, plan.from, "after"), end = encodeCollabTextAnchor(text, target, plan.to, "before"), change = plan.change;
  if (change.type === "add") return { type: "add", operation: plan.operation, writer: plan.writer, start, end, mark: change.mark, born: change.born === "inserted" ? inserted : change.born };
  if (change.type === "remove") return { type: "remove", operation: plan.operation, writer: plan.writer, start, end, observed: change.observed };
  return { type: "birth", operation: plan.operation, writer: plan.writer, start, end, observed: change.observed, born: (change.born === "inserted" ? inserted : change.born) as SharedMarkBirth };
}

function storeRecord(store: Y.Map<unknown>, key: string, record: SharedMarkRecord): void { store.set(key, record); }

export function writeCollabMarkPlan(text: Y.Text, store: Y.Map<unknown>, target: SharedTextAddress, plan: SharedMarkWritePlan, inserted: SharedMarkBirth | null): void {
  storeRecord(store, plan.identity, anchoredRecord(text, target, plan, inserted));
}

export function applySharedMarkWrite(handle: SharedDocumentHandle, description: { readonly target: SharedTextAddress; readonly plan: Extract<SharedMarkWritePlan, { kind: "record" }> }): void {
  const { text, store } = collabPreparedOperationTextTarget(handle, description.target);
  writeCollabMarkPlan(text, store, description.target, description.plan, null);
}

export function readSharedMarkCharacters(handle: SharedDocumentHandle, target: SharedTextAddress): SharedMarkedCharacter[] | null {
  const found = target.segment === target.owner ? collabTextTarget(handle, target) : collabPurposeTextTarget(handle, target, "stored-anchor-read");
  if (!found) return null;
  return [...readCollabMarkState(handle, found.text, found.container.get(found.marksKey)).characters];
}
