import type { ActionDefinition, Availability } from "../application/actions.ts";
import { openSettings, settingsAction } from "../application/settings-actions.ts";
import { openServersDialog, serversMenuLabel } from "../js/20e-connect.js";
import { OPENS_A_DIALOG, availableUnless } from "../application/screen.ts";
import { onlyDialogOpen } from "./screen.ts";
import { screenNow } from "./screen-state.ts";

function overDialogs(): Availability {
  return availableUnless(OPENS_A_DIALOG, screenNow());
}

function overDialogsButThePinPrompt(): Availability {
  return onlyDialogOpen("pin-modal") ? availableUnless(["tour"], screenNow()) : overDialogs();
}

export function helpMenuActions(): ActionDefinition[] {
  const definitions: ActionDefinition[] = [
    {
      id: "servers",
      label: () => serversMenuLabel(),
      group: "Share",
      icon: "i-globe",
      words: "server connect bookmark address pin join",
      availability: overDialogsButThePinPrompt,
      run: () => { openServersDialog(); }
    },
    {
      id: "show-servers-dialog",
      label: "Show the servers dialog",
      group: "Share",
      availability: () => ({ enabled: true, visible: false }),
      run: () => { openServersDialog(); }
    },
    settingsAction(() => ({ openSettings }), screenNow)
  ];
  return definitions;
}
