import type { ActionRegistry, Availability } from "../application/actions.ts";
import { S } from "../js/_state.js";
import { hideShotScenes, toggleHideShotScenes } from "../js/01b-hide-shot.js";
import { openHistoryPanel } from "../js/03-sync.js";
import { isRundownMinimized, toggleRundownMinimized } from "../js/05f-rundown.js";

const STILL_LOADING: Availability = { enabled: false, reason: "Still loading…" };

function dialogOpen(): boolean {
  return document.querySelector(".modal-backdrop:not([hidden])") !== null;
}

export function registerDocumentActions(registry: ActionRegistry): () => void {
  const disposers = [
    registry.register({
      id: "toggle-hide-shot",
      label: "Hide shot scenes",
      group: "This document",
      icon: "i-eye-off",
      keys: ["mod+alt+h"],
      words: "collapse done finished filter shot scenes",
      availability: () => {
        if (!S.state) return STILL_LOADING;
        if (dialogOpen()) return { enabled: false, reason: "Close the open dialog first", checked: Boolean(hideShotScenes) };
        return { enabled: true, checked: Boolean(hideShotScenes) };
      },
      run: () => { toggleHideShotScenes(); }
    }),
    registry.register({
      id: "toggle-rundown-min",
      label: "Minimise the rundown",
      group: "This document",
      icon: "i-rundown-min",
      words: "rundown strip timeline minimize collapse thin bar more room",
      availability: () => (S.state ? { enabled: true, checked: isRundownMinimized() } : STILL_LOADING),
      run: () => { toggleRundownMinimized(); }
    }),
    registry.register({
      id: "history",
      label: "Version history…",
      group: "This document",
      icon: "i-history",
      words: "versions restore snapshot backup older undo",
      run: () => { openHistoryPanel(); }
    })
  ];
  return () => { for (const dispose of disposers) dispose(); };
}
