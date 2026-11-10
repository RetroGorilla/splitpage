import type { SeedBeat } from "../schema.ts";

export const bindingFollowupCases = ["split-inside", "split-before", "split-after", "join-previous", "bold", "comment-tag", "long", "removed", "reentry-type", "reentry-replace", "reentry-paste"] as const;
export type BindingFollowupCase = typeof bindingFollowupCases[number];

export interface BindingFollowupInput {
  seed: SeedBeat[];
  beat: string;
  from: number;
  to: number;
  text: string;
}

export function bindingFollowupInput(name: BindingFollowupCase): BindingFollowupInput {
  const from = name === "split-before" ? 2 : name.startsWith("split-") || name === "reentry-replace" || name === "reentry-paste" ? 1 : name === "join-previous" ? 1 : 2;
  const to = name.startsWith("split-") || name === "reentry-replace" || name === "reentry-paste" ? 3 : from;
  return { seed: [{ id: "R1", text: "abcd" }, { id: "R2", text: "ef" }], beat: name === "join-previous" ? "R2" : "R1", from, to, text: name.startsWith("reentry-") ? "Q" : "xy" };
}
