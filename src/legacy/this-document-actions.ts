import type { ActionRegistry } from "../application/actions.ts";
import { hideShotScenes, toggleHideShotScenes } from "../js/01b-hide-shot.js";
import { openHistoryPanel } from "../js/03-sync.js";
import { isRundownMinimized, toggleRundownMinimized } from "../js/05f-rundown.js";
import { findOpen, openFindBar } from "../js/09-find-replace.js";
import { availableUnless } from "./screen.ts";
import { screenNow } from "./screen-state.ts";

export function registerThisDocumentActions(registry: ActionRegistry): () => void {
  const disposers = [
    registry.register({
      id: "toggle-hide-shot",
      label: "Hide shot scenes",
      group: "This document",
      icon: "i-eye-off",
      keys: ["mod+alt+h", "mod+alt+shift+h"],
      words: "collapse done finished filter shot scenes",
      availability: () => availableUnless(["loading", "dialog"], screenNow(), Boolean(hideShotScenes)),
      run: () => { toggleHideShotScenes(); }
    }),
    registry.register({
      id: "toggle-rundown-min",
      label: "Minimise the rundown",
      group: "This document",
      icon: "i-rundown-min",
      words: "rundown strip timeline minimize collapse thin bar more room",
      availability: (source) => availableUnless(source === "button" ? [] : ["loading"], screenNow(), isRundownMinimized()),
      run: () => { toggleRundownMinimized(); }
    }),
    registry.register({
      id: "history",
      label: "Version history…",
      group: "This document",
      icon: "i-history",
      words: "versions restore snapshot backup older undo",
      run: () => { openHistoryPanel(); }
    }),
    registry.register({
      id: "find",
      label: "Find & replace",
      group: "This document",
      icon: "i-find",
      keys: ["mod+f", "mod+shift+f", "mod+alt+f", "mod+alt+shift+f"],
      words: "search replace look for",
      availability: () => availableUnless(["loading", "dialog", "writer"], screenNow()),
      run: () => {
        const input = document.getElementById("find-input");
        if (findOpen && input instanceof HTMLInputElement) input.select();
        else openFindBar();
      }
    })
  ];
  return () => { for (const dispose of disposers) dispose(); };
}
