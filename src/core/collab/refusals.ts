import type { SharedContentRef } from "./operations.ts";

export type SharedCommandIntent =
  | { readonly kind: "edit" }
  | { readonly kind: "move"; readonly extent: "whole-segment" | "part-segment" }
  | { readonly kind: "structural-cut-paste"; readonly sourceScenes: readonly (SharedContentRef | null)[];
      readonly destinationScene: SharedContentRef | null };
export type SharedCommandPermission = "allowed" | "move-in-shared-session" | "cross-scene-structural-paste";

export function sharedCommandPermission(intent: SharedCommandIntent): SharedCommandPermission {
  if (intent.kind === "move") return "move-in-shared-session";
  if (intent.kind === "structural-cut-paste") {
    for (const scene of intent.sourceScenes) {
      if (scene !== intent.destinationScene) return "cross-scene-structural-paste";
    }
  }
  return "allowed";
}
