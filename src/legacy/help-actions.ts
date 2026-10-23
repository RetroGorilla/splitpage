import type { ActionDefinition, ActionRegistry, Availability } from "../application/actions.ts";
import { registerAll } from "../application/actions.ts";
import { showTaggingHelp } from "../js/10-comments.js";
import { openLongDemo } from "../js/18b-file-menu.js";
import { showAbout } from "../js/20a-update.js";
import { openOnboarding } from "../js/20b-onboarding.js";
import { openHelp, startTour } from "../js/20c-help.js";
import { openServersDialog, serversMenuLabel } from "../js/20e-connect.js";
import { appDataImportShown } from "../js/20f-desktop.js";
import { exportAppData, openImportAppData } from "../js/20h-appdata.js";
import { openSettings } from "../js/20s-settings.js";
import { OPENS_A_DIALOG, availableUnless } from "../application/screen.ts";
import { onlyDialogOpen } from "./screen.ts";
import { inDesktopApp, screenNow } from "./screen-state.ts";

function overDialogs(): Availability {
  return availableUnless(OPENS_A_DIALOG, screenNow());
}

function overDialogsButThePinPrompt(): Availability {
  return onlyDialogOpen("pin-modal") ? availableUnless(["tour"], screenNow()) : overDialogs();
}

export function registerHelpActions(registry: ActionRegistry): () => void {
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
      id: "settings",
      label: "Settings",
      group: "Help",
      icon: "i-settings",
      words: "settings preferences options theme dark light mode clock 12 24 hour colour color name zoom",
      availability: overDialogs,
      run: () => { openSettings(); }
    },
    {
      id: "help",
      label: "Help",
      group: "Help",
      icon: "i-help",
      keys: () => (inDesktopApp() ? ["F1"] : []),
      bindKeys: () => false,
      words: "guide manual docs user guide how",
      availability: () => availableUnless(["dialog"], screenNow()),
      run: () => { openHelp(); }
    },
    {
      id: "tour",
      label: "Take the tour",
      group: "Help",
      icon: "i-compass",
      words: "tutorial walkthrough introduction",
      availability: () => availableUnless(["dialog"], screenNow()),
      run: () => { startTour(); }
    },
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
      id: "about",
      label: "About Splitpage",
      group: "Help",
      icon: "i-info",
      words: "version about",
      availability: overDialogs,
      run: () => { showAbout(); }
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
  return registerAll(registry, definitions);
}
