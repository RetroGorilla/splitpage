import type { ActionDefinition } from "../../application/actions.ts";
import { EVERY_OVERLAY, availableUnless } from "../../application/screen.ts";
import type { ScreenState } from "../../application/screen.ts";
import type { SidePanels } from "../../application/side-panels.ts";
import type { BrollPanelState } from "./ports.ts";

export function brollPanelActions(current: () => BrollPanelState | null, ports: {
  readonly screen: () => ScreenState;
  readonly panels: Pick<SidePanels, "close">;
}): ActionDefinition[] {
  return [{
    id: "panel-broll",
    label: "B-roll panel",
    group: "View",
    icon: "i-panel",
    words: "broll b roll shots cutaways show hide toggle",
    availability: () => {
      if (!current()) return { enabled: false };
      const button = document.getElementById("btn-broll");
      const availability = availableUnless(EVERY_OVERLAY, ports.screen());
      return button && !button.hidden ? availability : { ...availability, visible: false };
    },
    run: () => {
      const panel = document.getElementById("broll-panel");
      if (panel && !panel.hidden) ports.panels.close("broll-panel");
      else current()?.openBrollPanel();
    }
  }];
}
