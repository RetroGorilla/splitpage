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

export const JOIN_SCRIPT_COMMAND = { id: "join-script", label: "Join a shared script…" } as const;
export const LEAVE_SCRIPT_COMMAND = { id: "leave-shared-script", label: "Leave shared script" } as const;

export function joinScriptAction(ports: ShareActionPorts): ActionDefinition {
  return {
    ...JOIN_SCRIPT_COMMAND, group: "Share", icon: "i-link", words: "collaborate invitation",
    availability: () => ports.visible() ? availableUnless(["loading", ...OPENS_A_DIALOG], ports.screen()) : { enabled: false, visible: false },
    run: ports.open
  };
}

export function leaveScriptAction(ports: ShareActionPorts): ActionDefinition {
  return {
    ...LEAVE_SCRIPT_COMMAND, group: "Share", words: "collaborate disconnect",
    availability: () => ports.visible() ? availableUnless(["loading", ...OPENS_A_DIALOG], ports.screen()) : { enabled: false, visible: false },
    run: ports.open
  };
}
