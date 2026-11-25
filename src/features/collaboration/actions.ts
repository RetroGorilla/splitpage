import type { ActionDefinition } from "../../application/actions.ts";
import { availableUnless, OPENS_A_DIALOG } from "../../application/screen.ts";
import type { ShareActionPorts } from "./ports.ts";

export const SHARING_COMMAND = { id: "sharing-and-people", label: "Sharing & people…" } as const;
export const LEAVE_SHARED_COMMAND = { id: "leave-shared-script", label: "Leave shared script" } as const;

export const SHARE_SCRIPT_COMMAND = { id: "share-script", label: "Share this script…" } as const;

export function sharedScriptActions(ports: ShareActionPorts & { readonly leave: () => Promise<void> }): ActionDefinition[] {
  const availability = () => ports.visible()
    ? availableUnless(["loading", ...OPENS_A_DIALOG], ports.screen()) : { enabled: false, visible: false };
  return [
    { ...SHARING_COMMAND, group: "Share", icon: "i-link", availability, run: ports.open },
    { ...LEAVE_SHARED_COMMAND, group: "Share", availability, run: ports.leave }
  ];
}

export function shareScriptAction(ports: ShareActionPorts): ActionDefinition {
  return {
    ...SHARE_SCRIPT_COMMAND, group: "Share", icon: "i-link",
    words: "collaborate invite relay",
    availability: () => ports.visible() ? availableUnless(["loading", ...OPENS_A_DIALOG], ports.screen()) : { enabled: false, visible: false },
    run: ports.open
  };
}
