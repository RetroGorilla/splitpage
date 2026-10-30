import type { DesktopPresence } from "../../../application/desktop-presence.ts";
import { runningOnDesktop } from "../../../adapters/desktop/desktop-port.ts";

export const presence: DesktopPresence = {
  running: runningOnDesktop
};
