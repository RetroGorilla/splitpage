import type { ActionRegistry } from "../application/actions.ts";
import { registerAll } from "../application/actions.ts";
import { toggleHideShotScenes } from "../js/01b-hide-shot.js";
import { openHistoryPanel } from "../js/03-sync.js";
import { isRundownMinimized, toggleRundownMinimized } from "../js/05f-rundown.js";
import { openFindBar } from "../js/09-find-replace.js";
import { viewFlags } from "./preferences-bridge.ts";
import { EVERY_OVERLAY, availableUnless, everyOverlayBut } from "../application/screen.ts";
import { screenNow } from "./screen-state.ts";

export function registerThisDocumentActions(registry: ActionRegistry): () => void {
  return registerAll(registry, [
    {
      id: "toggle-hide-shot",
      label: "Hide shot scenes",
      group: "This document",
      icon: "i-eye-off",
      keys: ["mod+alt+h", "mod+alt+shift+h"],
      words: "collapse done finished filter shot scenes",
      availability: () => availableUnless(["loading", "dialog"], screenNow(), viewFlags().hideShot()),
      run: () => { toggleHideShotScenes(); }
    },
    {
      id: "toggle-rundown-min",
      label: "Minimise the rundown",
      group: "This document",
      icon: "i-rundown-min",
      words: "rundown strip timeline minimize collapse thin bar more room",
      availability: (source) => availableUnless(source === "button" ? [] : ["loading"], screenNow(), isRundownMinimized()),
      run: () => { toggleRundownMinimized(); }
    },
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
  ]);
}
