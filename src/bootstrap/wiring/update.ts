import { desktopPort } from "../../adapters/desktop/desktop-port.ts";
import { screen as portScreen } from "./ports/screen.ts";
import type { ActionDefinition } from "../../application/actions.ts";
import { updateActions as definitions } from "../../features/update/actions.ts";
import type { UpdatePorts, UpdateStatus } from "../../features/update/ports.ts";
import { showAbout } from "../../js/20a-update.js";

export function updateActions(): ActionDefinition[] {
  return definitions({ screen: portScreen, showAbout });
}

export const updates: UpdatePorts["updates"] = {
  status: () => (desktopPort()?.getUpdateStatus?.() ?? Promise.resolve(null)) as Promise<UpdateStatus | null>,
  onStatus: (listener) => { desktopPort()?.onUpdateStatus?.(listener as (status: unknown) => void); },
  stopStatus: () => { desktopPort()?.onUpdateStatus?.(null); },
  download: () => desktopPort()?.downloadUpdate?.() ?? Promise.resolve(null),
  install: () => desktopPort()?.installUpdate?.() ?? Promise.resolve(null)
};
