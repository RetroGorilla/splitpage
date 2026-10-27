import type { ActionDefinition } from "../../application/actions.ts";
import type { ScreenState } from "../../application/screen.ts";
import { firstRefusal, availableUnless } from "../../application/screen.ts";
import type { ReviewFacts } from "../../application/collaboration/review.ts";
import type { DocumentChromeControl } from "./ports.ts";

export function targetActions(current: () => Pick<DocumentChromeControl, "promptForTarget">, screen: () => ScreenState, review: Pick<ReviewFacts, "reviewing">): ActionDefinition[] {
  function loaded(own: ReturnType<typeof availableUnless>) {
    return firstRefusal(availableUnless(["loading"], screen()), own);
  }
  return [
    {
      id: "set-target",
      label: "Set target length…",
      group: "This document",
      icon: "i-clock",
      words: "target length goal duration aim runtime running time clock back timing over under minutes",
      availability: () => loaded(review.reviewing() ? { enabled: false, reason: "Viewing only — the writer sets the target" } : { enabled: true }),
      run: () => { current().promptForTarget(); }
    }
  ];
}
