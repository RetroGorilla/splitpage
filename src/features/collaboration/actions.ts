import type { ActionDefinition } from "../../application/actions.ts";
import { availableUnless, OPENS_A_DIALOG } from "../../application/screen.ts";
import type { ShareActionPorts } from "./ports.ts";

export const SHARE_SCRIPT_COMMAND = { id: "share-script", label: "Share this script…" } as const;

export function shareScriptAction(ports: ShareActionPorts): ActionDefinition {
  return {
    ...SHARE_SCRIPT_COMMAND, group: "Share", icon: "i-link",
    words: "collaborate invite relay",
    availability: () => ports.visible() ? availableUnless(["loading", ...OPENS_A_DIALOG], ports.screen()) : { enabled: false, visible: false },
    run: ports.open
  };
}
