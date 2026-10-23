import type { ActionDefinition, Availability } from "../application/actions.ts";
import { openSettings, settingsAction } from "../application/settings-actions.ts";
import { showTaggingHelp } from "../js/10-comments.js";
import { openLongDemo } from "../js/18b-file-menu.js";
import { openOnboarding } from "../js/20b-onboarding.js";
import { openServersDialog, serversMenuLabel } from "../js/20e-connect.js";
import { appDataImportShown } from "../js/20f-desktop.js";
import { exportAppData, openImportAppData } from "../js/20h-appdata.js";
import { OPENS_A_DIALOG, availableUnless } from "../application/screen.ts";
import { onlyDialogOpen } from "./screen.ts";
import { screenNow } from "./screen-state.ts";

function overDialogs(): Availability {
  return availableUnless(OPENS_A_DIALOG, screenNow());
}

function overDialogsButThePinPrompt(): Availability {
  return onlyDialogOpen("pin-modal") ? availableUnless(["tour"], screenNow()) : overDialogs();
}

export function helpMenuActions(): ActionDefinition[] {
  const definitions: ActionDefinition[] = [
    {
      id: "servers",
      label: () => serversMenuLabel(),
      group: "Share",
      icon: "i-globe",
      words: "server connect bookmark address pin join",
      availability: overDialogsButThePinPrompt,
      run: () => { openServersDialog(); }
    },
    {
      id: "show-servers-dialog",
      label: "Show the servers dialog",
      group: "Share",
      availability: () => ({ enabled: true, visible: false }),
      run: () => { openServersDialog(); }
    },
    settingsAction(() => ({ openSettings }), screenNow),
    {
      id: "long-demo",
      label: "Open the long demo (30 scenes)",
      group: "Help",
      icon: "i-file-plus",
      words: "demo example sample long thirty 30 scenes test try every feature",
      run: () => { openLongDemo(); }
    },
    {
      id: "setup",
      label: "Set up Splitpage…",
      group: "Help",
      icon: "i-sliders",
      words: "setup settings wizard install",
      availability: overDialogs,
      run: () => { openOnboarding(); }
    },
    {
      id: "tagging-help",
      label: "Tagging reference",
      group: "Tags",
      icon: "i-tag",
      words: "tags tagging reference shortcuts brackets help",
      availability: overDialogs,
      run: () => { showTaggingHelp(); }
    },
    {
      id: "export-app-data",
      label: "Export app data…",
      group: "Help",
      icon: "i-box",
      words: "backup move desktop app data history bookmarks",
      availability: () => availableUnless(["loading"], screenNow()),
      run: () => exportAppData()
    },
    {
      id: "import-app-data",
      label: "Import app data…",
      group: "Help",
      icon: "i-box",
      words: "restore move desktop app data history bookmarks",
      availability: () => {
        const screen = availableUnless(["loading"], screenNow());
        return appDataImportShown() ? screen : { ...screen, visible: false };
      },
      run: () => { openImportAppData(); }
    }
  ];
  return definitions;
}
