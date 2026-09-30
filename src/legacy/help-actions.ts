import type { ActionDefinition, ActionRegistry, Availability } from "../application/actions.ts";
import { showTaggingHelp } from "../js/10-comments.js";
import { openLongDemo } from "../js/18b-file-menu.js";
import { showAbout } from "../js/20a-update.js";
import { openOnboarding } from "../js/20b-onboarding.js";
import { openHelp, startTour } from "../js/20c-help.js";
import { openServersDialog } from "../js/20e-connect.js";
import { exportAppData, openImportAppData } from "../js/20h-appdata.js";
import { openSettings } from "../js/20s-settings.js";
import { menuItemAvailability, menuItemLabel } from "./menu-items.ts";
import { availableUnless } from "./screen.ts";
import { inDesktopApp, screenNow } from "./screen-state.ts";

function fromMenuItem(action: string): Availability {
  return menuItemAvailability(action) ?? { enabled: true };
}

function loadedMenuItem(action: string): Availability {
  const screen = availableUnless(["loading"], screenNow());
  return screen.enabled ? fromMenuItem(action) : screen;
}

export function registerHelpActions(registry: ActionRegistry): () => void {
  const definitions: ActionDefinition[] = [
    {
      id: "servers",
      label: () => menuItemLabel("servers", "Servers…"),
      group: "Share",
      icon: "i-globe",
      words: "server connect bookmark address pin join",
      availability: () => fromMenuItem("servers"),
      run: () => { openServersDialog(); }
    },
    {
      id: "settings",
      label: "Settings",
      group: "Help",
      icon: "i-settings",
      words: "settings preferences options theme dark light mode clock 12 24 hour colour color name zoom",
      availability: () => fromMenuItem("settings"),
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
      availability: () => fromMenuItem("help"),
      run: () => { openHelp(); }
    },
    {
      id: "tour",
      label: "Take the tour",
      group: "Help",
      icon: "i-compass",
      words: "tutorial walkthrough introduction",
      availability: () => fromMenuItem("tour"),
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
      availability: () => fromMenuItem("setup"),
      run: () => { openOnboarding(); }
    },
    {
      id: "about",
      label: "About Splitpage",
      group: "Help",
      icon: "i-info",
      words: "version about",
      availability: () => fromMenuItem("about"),
      run: () => { showAbout(); }
    },
    {
      id: "tagging-help",
      label: "Tagging reference",
      group: "Tags",
      icon: "i-tag",
      words: "tags tagging reference shortcuts brackets help",
      availability: () => fromMenuItem("tagging-help"),
      run: () => { showTaggingHelp(); }
    },
    {
      id: "export-app-data",
      label: "Export app data…",
      group: "Help",
      icon: "i-box",
      words: "backup move desktop app data history bookmarks",
      availability: () => loadedMenuItem("export-app-data"),
      run: () => exportAppData()
    },
    {
      id: "import-app-data",
      label: "Import app data…",
      group: "Help",
      icon: "i-box",
      words: "restore move desktop app data history bookmarks",
      availability: () => loadedMenuItem("import-app-data"),
      run: () => { openImportAppData(); }
    }
  ];
  const disposers = definitions.map((d) => registry.register(d));
  return () => { for (const dispose of disposers) dispose(); };
}
