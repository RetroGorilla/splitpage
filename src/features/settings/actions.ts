import type { ActionDefinition } from "../../application/actions.ts";
import { settingsAction } from "../../application/settings-actions.ts";
import type { SettingsActionPorts, SettingsControls } from "./ports.ts";

export function settingsActions(current: () => SettingsControls | null, ports: SettingsActionPorts): ActionDefinition[] {
  return [settingsAction(current, ports.screen)];
}
