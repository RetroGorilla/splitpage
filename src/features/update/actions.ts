import type { ActionDefinition } from "../../application/actions.ts";
import { OPENS_A_DIALOG, availableUnless } from "../../application/screen.ts";
import type { UpdateActionPorts } from "./ports.ts";

export function updateActions(ports: UpdateActionPorts): ActionDefinition[] {
  const { showAbout } = ports;
  return [
    {
      id: "about",
      label: "About Splitpage",
      group: "Help",
      icon: "i-info",
      words: "version about",
      availability: () => availableUnless(OPENS_A_DIALOG, ports.screen()),
      run: () => { showAbout(); }
    }
  ];
}
