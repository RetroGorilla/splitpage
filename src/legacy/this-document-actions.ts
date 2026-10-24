import type { ActionDefinition } from "../application/actions.ts";
import { openHistoryPanel } from "../js/03-sync.js";
import { EVERY_OVERLAY, availableUnless } from "../application/screen.ts";
import { screenNow } from "./screen-state.ts";

export function thisDocumentActions(): ActionDefinition[] {
  return [
    {
      id: "history",
      label: "Version history…",
      group: "This document",
      icon: "i-history",
      words: "versions restore snapshot backup older undo",
      availability: () => availableUnless(EVERY_OVERLAY, screenNow()),
      run: () => { openHistoryPanel(); }
    }
  ];
}
