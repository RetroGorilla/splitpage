import type { ActionDefinition } from "../../application/actions.ts";
import type { HistoryPanelControl } from "./ports.ts";
import { EVERY_OVERLAY, availableUnless } from "../../application/screen.ts";
import type { ScreenState } from "../../application/screen.ts";

export function historyActions(current: () => Pick<HistoryPanelControl, "openHistoryPanel">, screen: () => ScreenState): ActionDefinition[] {
  return [
    {
      id: "history",
      label: "Version history…",
      group: "This document",
      icon: "i-history",
      words: "versions restore snapshot backup older undo",
      availability: () => availableUnless(EVERY_OVERLAY, screen()),
      run: () => { current().openHistoryPanel(); }
    }
  ];
}
