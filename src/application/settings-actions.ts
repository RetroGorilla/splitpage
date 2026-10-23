import type { ActionDefinition } from "./actions.ts";
import { OPENS_A_DIALOG, availableUnless } from "./screen.ts";
import type { ScreenState } from "./screen.ts";

interface SettingsControls {
  readonly openSettings: (input?: unknown) => void;
}

let controls: SettingsControls | null = null;

export function installSettingsControls(current: SettingsControls): () => void {
  controls = current;
  return () => {
    if (controls === current) controls = null;
  };
}

export function openSettings(input?: unknown): void {
  controls?.openSettings(input);
}

export function settingsAction(current: () => SettingsControls | null, screen: () => ScreenState): ActionDefinition {
  return {
    id: "settings",
    label: "Settings",
    group: "Help",
    icon: "i-settings",
    words: "settings preferences options theme dark light mode clock 12 24 hour colour color name zoom",
    availability: () => current() ? availableUnless(OPENS_A_DIALOG, screen()) : { enabled: false },
    run: (_source, input) => { current()?.openSettings(input); }
  };
}
