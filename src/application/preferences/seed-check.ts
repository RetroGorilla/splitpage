import { checksumText } from "../../../shared/text.js";

export interface SeedCheck {
  readonly passes: () => boolean;
}

export function seedCheckMatches(metaContent: string | null, stateText: string | null): boolean {
  if (metaContent === null || stateText === null) return false;
  return metaContent === stateText.length + "-" + checksumText(stateText);
}
