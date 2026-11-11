import type { SharedContentRef, SharedMarkValue } from "../../core/collab/operations.ts";
import type { SharedStoredMarkValue } from "./stored-mark.ts";
import { readSharedStoredMark } from "./stored-mark.ts";
import { isStableSharedIdentity } from "./identity.ts";

export type SharedMarkTranslation = { readonly type: "add"; readonly mark: SharedStoredMarkValue }
  | { readonly type: "remove"; readonly observed: readonly SharedContentRef[] };

export function prepareSharedMarkTranslation(mark: SharedMarkValue, writer: string, operation: string, position: readonly number[],
  additions: readonly { readonly identity: SharedContentRef; readonly mark: SharedStoredMarkValue }[] = []): SharedMarkTranslation | null {
  if (!writer.length || !operation.length || !isStableSharedIdentity(writer) || !isStableSharedIdentity(operation)
    || "id" in mark && !isStableSharedIdentity(mark.id) || mark.kind === "tag" && mark.value !== null && !isStableSharedIdentity(mark.value)) return null;
  for (let index = 0; index < position.length; index++) if (!Number.isSafeInteger(position[index]) || (position[index] as number) < 0) return null;
  if (mark.value === null) return { type: "remove", observed: [...new Set(additions.filter(addition => addition.mark.kind === mark.kind
    && (!("id" in mark) || addition.mark.value === mark.id)).map(addition => addition.identity))].sort() };
  const stored = readSharedStoredMark("id" in mark
    ? { kind: mark.kind, id: JSON.stringify(["mark-occurrence", writer, operation, ...position]), value: mark.id }
    : mark);
  return stored ? { type: "add", mark: stored } : null;
}
