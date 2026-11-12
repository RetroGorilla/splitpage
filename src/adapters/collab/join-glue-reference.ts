import type { SharedContentRef } from "../../core/collab/operations.ts";
import { readSharedJoinGroup } from "./join-record.ts";

export function sharedJoinGlueReference(group: string, after = false): SharedContentRef {
  return JSON.stringify(after ? ["join-glue", group, "after"] : ["join-glue", group]) as SharedContentRef;
}
export function readSharedJoinGlueReference(raw: unknown): { readonly group: string; readonly after: boolean } | null {
  if (typeof raw !== "string") return null;
  let value: unknown; try { value = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(value) || value[0] !== "join-glue" || value.length !== 2 && (value.length !== 3 || value[2] !== "after") || !readSharedJoinGroup(value[1])) return null;
  const group = value[1] as string, after = value.length === 3;
  return sharedJoinGlueReference(group, after) === raw ? { group, after } : null;
}
