import type { SharedContentRef, SharedTextAddress } from "../../core/collab/operations.ts";
import { readSharedAnchor, sharedAnchorCharacterEnd } from "./anchors.ts";
import { readSharedTextTarget } from "./text-target.ts";
import { readSharedJoinGlueReference } from "./join-glue-reference.ts";

export function readSharedJoinedSpan(reference: unknown): { readonly target: SharedTextAddress; readonly units: readonly SharedContentRef[] } | null {
  if (typeof reference !== "string") return null;
  let raw: unknown; try { raw = JSON.parse(reference); } catch { return null; }
  if (!Array.isArray(raw) || raw.length !== 3 || raw[0] !== "joined-text-span" || !Array.isArray(raw[2])) return null;
  const target = readSharedTextTarget(raw[1]), units: SharedContentRef[] = [];
  if (!target || target.field !== "audioText") return null;
  for (let index = 0; index < raw[2].length; index++) {
    const value = raw[2][index]; if (typeof value !== "string") return null;
    const glue = readSharedJoinGlueReference(value);
    if (glue ? glue.after : !readSharedAnchor(value) || !sharedAnchorCharacterEnd(value)) return null;
    units.push(value as SharedContentRef);
  }
  return JSON.stringify(["joined-text-span", { owner: target.owner, segment: target.segment, field: target.field }, units]) === reference ? { target, units } : null;
}

export function sharedJoinedSpanReference(target: SharedTextAddress, units: readonly SharedContentRef[]): SharedContentRef | null {
  const reference = JSON.stringify(["joined-text-span", { owner: target.owner, segment: target.segment, field: target.field }, units]);
  return readSharedJoinedSpan(reference) ? reference as SharedContentRef : null;
}
