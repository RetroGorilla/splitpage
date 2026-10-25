import type { ActionDefinition } from "../../application/actions.ts";
import type { ScreenState } from "../../application/screen.ts";
import { EVERY_OVERLAY, availableUnless, firstRefusal } from "../../application/screen.ts";
import type { SidePanels } from "../../application/side-panels.ts";
import type { TagPanelMount } from "./ports.ts";

export function tagPanelActions(current: () => TagPanelMount | null, screen: () => ScreenState, panels: Pick<SidePanels, "close">): ActionDefinition[] {
  function panel(id: string, label: string, buttonId: string, panelId: string, words: string, open: (owner: TagPanelMount) => void): ActionDefinition {
    return {
      id,
      label,
      group: "View",
      icon: "i-panel",
      words,
      availability: () => {
        if (!current()) return { enabled: false };
        const button = document.getElementById(buttonId);
        const availability = firstRefusal(availableUnless(["loading"], screen()), availableUnless(EVERY_OVERLAY, screen()));
        return button !== null && !button.hidden ? availability : { ...availability, visible: false };
      },
      run: () => {
        const owner = current();
        if (!owner) return;
        const target = document.getElementById(panelId);
        if (target !== null && !target.hidden) panels.close(panelId);
        else open(owner);
      }
    };
  }
  return [
    panel("panel-production", "Production panel", "btn-production", "production-panel",
      "breakdown tags props locations cast show hide toggle", (owner) => { owner.openProductionPanel(); }),
    panel("panel-gear", "Gear panel", "btn-gear", "gear-panel",
      "gear equipment kit camera show hide toggle", (owner) => { owner.openGearPanel(); })
  ];
}
