import type { SharedContentRef } from "./operations.ts";

export type SharedCommandIntent =
  | { readonly kind: "edit" }
  | { readonly kind: "move"; readonly extent: "whole-segment" | "part-segment" }
  | { readonly kind: "structural-cut-paste"; readonly sourceScenes: readonly (SharedContentRef | null)[];
      readonly destinationScene: SharedContentRef | null };
export type SharedCommandPermission = "allowed" | "partial-segment-move" | "cross-scene-structural-paste";

export function sharedCommandPermission(intent: SharedCommandIntent): SharedCommandPermission {
  if (intent.kind === "move" && intent.extent === "part-segment") return "partial-segment-move";
  if (intent.kind === "structural-cut-paste") {
    for (const scene of intent.sourceScenes) {
      if (scene !== intent.destinationScene) return "cross-scene-structural-paste";
    }
  }
  return "allowed";
}
