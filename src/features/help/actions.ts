import type { ActionDefinition } from "../../application/actions.ts";
import { availableUnless, EVERY_OVERLAY } from "../../application/screen.ts";
import type { HelpActionPorts, HelpControls } from "./ports.ts";

export function helpActions(current: () => HelpControls | null, ports: HelpActionPorts): ActionDefinition[] {
  const availability = () => current() ? availableUnless(["dialog"], ports.screen()) : { enabled: false };
  return [
    {
      id: "help",
      label: "User guide",
      group: "Help",
      icon: "i-help",
      keys: () => (ports.desktop() ? ["F1"] : []),
      bindKeys: () => false,
      words: "guide manual docs user guide how",
      aliases: ["Help"],
      availability,
      run: () => { current()?.openHelp(); }
    },
    {
      id: "tour",
      label: "Take the tour",
      group: "Help",
      icon: "i-compass",
      words: "tutorial walkthrough introduction",
      availability: () => current() ? availableUnless(["loading", ...EVERY_OVERLAY], ports.screen()) : { enabled: false },
      run: () => { current()?.startTour(); }
    }
  ];
}
