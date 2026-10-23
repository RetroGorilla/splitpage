import type { ActionDefinition } from "../../application/actions.ts";
import { availableUnless } from "../../application/screen.ts";
import type { HelpActionPorts, HelpControls } from "./ports.ts";

export function helpActions(current: () => HelpControls | null, ports: HelpActionPorts): ActionDefinition[] {
  const availability = () => current() ? availableUnless(["dialog"], ports.screen()) : { enabled: false };
  return [
    {
      id: "help",
      label: "Help",
      group: "Help",
      icon: "i-help",
      keys: () => (ports.desktop() ? ["F1"] : []),
      bindKeys: () => false,
      words: "guide manual docs user guide how",
      availability,
      run: () => { current()?.openHelp(); }
    },
    {
      id: "tour",
      label: "Take the tour",
      group: "Help",
      icon: "i-compass",
      words: "tutorial walkthrough introduction",
      availability,
      run: () => { current()?.startTour(); }
    }
  ];
}
