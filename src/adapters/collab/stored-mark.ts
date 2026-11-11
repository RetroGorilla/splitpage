import type { SharedContentRef } from "../../core/collab/operations.ts";
import type { FormatMark } from "../../core/text/runs.ts";
import { readSharedContentRef } from "../../core/collab/read-operation.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { safeHref } from "../../core/document/text-policy.ts";

export type SharedStoredMarkValue = { readonly kind: FormatMark | "dir" | "cue"; readonly value: true }
  | { readonly kind: "comment" | "tag"; readonly id: SharedContentRef; readonly value: SharedContentRef }
  | { readonly kind: "link"; readonly id: SharedContentRef; readonly value: string };

export function readSharedStoredMark(raw: unknown): SharedStoredMarkValue | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>, keys = Object.keys(value).sort().join(","), kind = value.kind;
  if (kind === "b" || kind === "i" || kind === "u" || kind === "s" || kind === "hl" || kind === "dir" || kind === "cue") {
    return keys === "kind,value" && value.value === true ? { kind, value: true } : null;
  }
  if (keys !== "id,kind,value" || typeof value.id !== "string" || !isStableSharedIdentity(value.id)) return null;
  const id = readSharedContentRef(value.id); if (!id) return null;
  if (kind === "comment" || kind === "tag") {
    const payload = typeof value.value === "string" && isStableSharedIdentity(value.value) && readSharedContentRef(value.value);
    return payload ? { id, kind, value: payload } : null;
  }
  return kind === "link" && typeof value.value === "string" && safeHref(value.value) === value.value
    ? { id, kind, value: value.value.replace(/\p{Cs}/gu, "\ufffd") } : null;
}
