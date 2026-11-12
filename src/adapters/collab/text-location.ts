import type { SharedContentRef, SharedTextAddress } from "../../core/collab/operations.ts";
import { isStableSharedIdentity } from "./identity.ts";

export interface SharedTextLocationReader {
  readonly get: (path: readonly string[]) => unknown;
  readonly kind: (path: readonly string[]) => "map" | "text" | "array" | "value" | "missing";
  readonly resolveOwner: (owner: string, field: "audioText" | "heading") => { readonly owner: string; readonly segment: string } | null;
}

export function resolveSharedTextLocation(view: SharedTextLocationReader, raw: SharedTextAddress) {
  if (![raw.owner, raw.segment].every(isStableSharedIdentity)) throw new Error("unstable-identity");
  let owner: string = raw.owner, segment: string = raw.segment, parent: readonly string[];
  if (raw.field === "title") {
    if (owner !== segment || view.get(["meta", "docId"]) !== owner) throw new Error("missing-target");
    parent = ["meta"];
  } else {
    const winner = view.resolveOwner(owner, raw.field === "heading" ? "heading" : "audioText");
    if (!winner) throw new Error("missing-target");
    owner = winner.owner;
    if (raw.field === "visualText") {
      if (raw.segment === raw.owner) {
        const visual = view.get(["beats", owner, "visual"]) ?? owner;
        if (typeof visual !== "string" || !visual || !isStableSharedIdentity(visual)) throw new Error("missing-target");
        segment = visual;
      }
      parent = ["visuals", segment];
      if (view.get([...parent, "beat"]) !== owner) throw new Error("missing-target");
    } else {
      if (raw.segment === raw.owner) segment = winner.segment;
      if (segment !== winner.segment) throw new Error("mismatched-target");
      parent = ["segments", segment];
    }
  }
  const path = [...parent, raw.field === "title" ? "title" : "text"], storePath = [...parent, raw.field === "title" ? "titleMarks" : "markRecords"];
  if (view.kind(path) !== "text") throw new Error("missing-target");
  if (view.kind(storePath) !== "map") throw new Error("missing-store");
  return { target: { owner: owner as SharedContentRef, segment: segment as SharedContentRef, field: raw.field }, path, storePath };
}
