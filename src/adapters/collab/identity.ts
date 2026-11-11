import { hasLoneSurrogate } from "../../core/document/text-policy.ts";

export function isStableSharedIdentity(text: string): boolean {
  return !hasLoneSurrogate(text) && !text.includes("\ufffd");
}
