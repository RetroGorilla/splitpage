import { desktopPort } from "../../adapters/desktop/desktop-port.ts";
import type { UpdatePorts, UpdateStatus } from "../../features/update/ports.ts";

export const updates: UpdatePorts["updates"] = {
  status: () => (desktopPort()?.getUpdateStatus?.() ?? Promise.resolve(null)) as Promise<UpdateStatus | null>,
  onStatus: (listener) => { desktopPort()?.onUpdateStatus?.(listener as (status: unknown) => void); },
  stopStatus: () => { desktopPort()?.onUpdateStatus?.(null); },
  download: () => desktopPort()?.downloadUpdate?.() ?? Promise.resolve(null),
  install: () => desktopPort()?.installUpdate?.() ?? Promise.resolve(null)
};
