import { cleanId } from "../document/text-policy.ts";

export type SharedStructureRole = "beat" | "segment" | "visual" | "gallery" | "removal" | "restore" | "join" | "heading";

export function sharedStructureKey(writer: string, operation: string, role: SharedStructureRole, slot = 0): string | null {
  if (!operation || cleanId(operation) !== operation || !/^(0|[1-9][0-9]*)$/.test(writer) || !Number.isSafeInteger(slot) || slot < 0) return null;
  return "structure_" + writer + "_" + operation.split("").map(unit => unit.charCodeAt(0).toString(16).padStart(4, "0")).join("") + "_" + role + "_" + slot;
}
