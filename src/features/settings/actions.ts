import type { ActionDefinition } from "../../application/actions.ts";
import { settingsAction } from "../../application/settings-actions.ts";
import type { SettingsControls } from "../../application/settings-actions.ts";
import { availableUnless, OPENS_A_DIALOG } from "../../application/screen.ts";
import type { AppDataActionPorts, AppDataMount, SettingsActionPorts } from "./ports.ts";

export function settingsActions(current: () => SettingsControls | null, ports: SettingsActionPorts): ActionDefinition[] {
  return [settingsAction(current, ports.screen)];
}

export function appDataActions(current: () => AppDataMount | null, ports: AppDataActionPorts): ActionDefinition[] {
  return [
    {
      id: "export-app-data",
      label: "Export app data…",
      group: "Help",
      icon: "i-box",
      words: "backup move desktop app data history",
      availability: () => current() ? availableUnless(["loading", ...OPENS_A_DIALOG], ports.screen()) : { enabled: false },
      run: () => current()?.exportAppData()
    },
    {
      id: "import-app-data",
      label: "Import app data…",
      group: "Help",
      icon: "i-box",
      words: "restore move desktop app data history",
      availability: () => {
        if (!current()) return { enabled: false };
        const screen = availableUnless(["loading", ...OPENS_A_DIALOG], ports.screen());
        return ports.importShown() ? screen : { ...screen, visible: false };
      },
      run: () => { current()?.openImportAppData(); }
    }
  ];
}
