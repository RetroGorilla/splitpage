import { sharedJson } from "./snapshot.ts";
import { isStableSharedIdentity } from "./identity.ts";

export function readSharedJoinEntry(raw: unknown): { readonly into: string; readonly glue: "" | " "; readonly generation: number } | null {
  const json = sharedJson(raw);
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const value = json as Record<string, unknown>;
  if (typeof value.into !== "string" || !value.into || !isStableSharedIdentity(value.into) || value.glue !== "" && value.glue !== " ") return null;
  const generation = value.generation === undefined ? 0 : value.generation;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) return null;
  return { into: value.into, glue: value.glue, generation };
}

export function sharedJoinRetirementGroup(from: string, entry: NonNullable<ReturnType<typeof readSharedJoinEntry>>): string {
  return JSON.stringify(["join-retirement", from, entry.into, entry.glue, entry.generation]);
}

export function readSharedJoinGroup(raw: unknown): { readonly from: string; readonly into: string; readonly glue: "" | " "; readonly generation: number } | null {
  if (typeof raw !== "string") return null;
  let value: unknown; try { value = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(value) || value.length !== 5 || value[0] !== "join-retirement" || typeof value[1] !== "string" || !value[1] || !isStableSharedIdentity(value[1])) return null;
  const entry = readSharedJoinEntry({ into: value[2], glue: value[3], generation: value[4] });
  return entry && sharedJoinRetirementGroup(value[1], entry) === raw ? { from: value[1], into: entry.into, glue: entry.glue, generation: entry.generation } : null;
}
