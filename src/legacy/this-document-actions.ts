import type { ActionDefinition } from "../application/actions.ts";
import { toggleHideShotScenes } from "../js/01b-hide-shot.js";
import { openHistoryPanel } from "../js/03-sync.js";
import { viewFlags } from "./preferences-bridge.ts";
import { EVERY_OVERLAY, availableUnless } from "../application/screen.ts";
import { screenNow } from "./screen-state.ts";

export function hideShotActions(): ActionDefinition[] {
  return [
    {
      id: "toggle-hide-shot",
      label: "Hide shot scenes",
      group: "This document",
      icon: "i-eye-off",
      keys: ["mod+alt+h", "mod+alt+shift+h"],
      words: "collapse done finished filter shot scenes",
      availability: () => availableUnless(["loading", "dialog"], screenNow(), viewFlags().hideShot()),
      run: () => { toggleHideShotScenes(); }
    }
  ];
}

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
