import type { ActionDefinition } from "../application/actions.ts";
import { openHistoryPanel } from "../js/03-sync.js";
import { openFindBar } from "../js/09-find-replace.js";
import { viewFlags } from "./preferences-bridge.ts";
import { EVERY_OVERLAY, availableUnless, everyOverlayBut } from "../application/screen.ts";
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
    },
    {
      id: "find",
      label: "Find & replace",
      group: "This document",
      icon: "i-find",
      keys: ["mod+f", "mod+shift+f", "mod+alt+f", "mod+alt+shift+f"],
      words: "search replace look for",
      availability: () => availableUnless(["loading", ...everyOverlayBut("launcher")], screenNow()),
      run: (source) => {
        const input = document.getElementById("find-input");
        if (source === "shortcut" && viewFlags().findOpen() && input instanceof HTMLInputElement) input.select();
        else openFindBar();
      }
    }
  ];
}
