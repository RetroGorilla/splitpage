import { desktopPort } from "../../adapters/desktop/desktop-port.ts";
import { screen as portScreen } from "./ports/screen.ts";
import type { ActionDefinition } from "../../application/actions.ts";
import { updateActions as definitions } from "../../features/update/actions.ts";
import type { UpdatePorts, UpdateStatus } from "../../features/update/ports.ts";
import { mountUpdate } from "../../features/update/update.js";
import type { UpdateMount } from "../../features/update/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { runningOnDesktop } from "../../application/desktop-presence.ts";
import { updatePreferences } from "./ports/preferences.ts";
import { externalLinks } from "./ports/desktop.ts";

const update = owned<UpdateMount>();

export function mountUpdateFeature(): UpdateMount {
  return update.replace(() => mountUpdate({ updates, preferences: updatePreferences, externalLinks, desktop: runningOnDesktop }));
}

export const stopUpdateFeature = update.stop;

export function updateControls(): UpdateMount | null {
  return update.owner();
}

export function updateActions(): ActionDefinition[] {
  return definitions({ screen: portScreen, showAbout: () => { update.owner()?.showAbout(); } });
}

export const updates: UpdatePorts["updates"] = {
  status: () => (desktopPort()?.getUpdateStatus?.() ?? Promise.resolve(null)) as Promise<UpdateStatus | null>,
  onStatus: (listener) => { desktopPort()?.onUpdateStatus?.(listener as (status: unknown) => void); },
  stopStatus: () => { desktopPort()?.onUpdateStatus?.(null); },
  download: () => desktopPort()?.downloadUpdate?.() ?? Promise.resolve(null),
  install: () => desktopPort()?.installUpdate?.() ?? Promise.resolve(null)
};
