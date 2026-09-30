import type { ActionDefinition, ActionRegistry, Availability } from "../application/actions.ts";
import { S } from "../js/_state.js";
import { promptForTarget } from "../js/03-sync.js";
import { openGdocModal, openImportModal } from "../js/11-import.js";
import { openDriveModal, openServerPicker, publishToServer, reviewMode } from "../js/13-hosted.js";
import { collaborateBlockedReason, openCollaborate } from "../js/13b-collaborate.js";
import { toggleAutoSave } from "../js/14-export.js";
import { saveBackToFile } from "../js/18-local-files.js";
import { startNewScript } from "../js/18b-file-menu.js";
import { exportAgain } from "../js/18c-export-dialog.js";
import { openPrompterInBrowser, openPrompterInChromium } from "../js/20f-desktop.js";
import { screenNow } from "./document-actions.ts";
import { menuItemAvailability, menuItemLabel } from "./menu-items.ts";
import { availableUnless } from "./screen.ts";

function loadedMenuItem(action: string): Availability {
  const screen = availableUnless(["loading"], screenNow());
  return screen.enabled ? menuItemAvailability(action) ?? screen : screen;
}

function menuChecked(action: string): boolean {
  const item = document.querySelector(`#file-menu [data-file-action="${action}"]`);
  return item?.getAttribute("aria-checked") === "true";
}

function desktopKeys(keys: readonly string[]): () => readonly string[] {
  return () => (S.DESKTOP ? keys : []);
}

function menuAction(id: string, label: string | (() => string), group: string, icon: string, words: string, run: () => void | Promise<void>): ActionDefinition {
  return { id, label, group, icon, words, availability: () => loadedMenuItem(id), run };
}

export function registerShareActions(registry: ActionRegistry): () => void {
  const definitions: ActionDefinition[] = [
    {
      id: "save-back",
      label: () => menuItemLabel("save-back", "Save to file"),
      group: "File",
      icon: "i-save",
      words: "write back original docx csv txt",
      availability: () => {
        const a = loadedMenuItem("save-back");
        return a.enabled ? a : { ...a, visible: false };
      },
      run: async () => { await saveBackToFile(); }
    },
    {
      id: "autosave",
      label: "Autosave",
      group: "File",
      icon: "i-autosave",
      words: "automatic save saving",
      availability: () => ({ ...loadedMenuItem("autosave"), checked: menuChecked("autosave") }),
      run: () => { toggleAutoSave(); }
    },
    menuAction("new", "New script", "File", "i-file-plus", "blank empty create start fresh document", () => { startNewScript(); }),
    menuAction("server-open", "Open from the server…", "File", "i-server", "server hosted shared documents", () => openServerPicker()),
    menuAction("paste", "Import: paste a script…", "File", "i-clipboard", "import revised draft text", () => { openImportModal(); }),
    menuAction("gdoc-import", "Import: Google Doc link…", "File", "i-link", "import google docs link url", () => { openGdocModal(); }),
    {
      id: "drive-open",
      label: "Import: Google Drive…",
      group: "File",
      icon: "i-cloud",
      words: "import google drive cloud files",
      availability: () => menuItemAvailability("drive-open") ?? { enabled: true },
      run: () => { openDriveModal(); }
    },
    {
      id: "collaborate",
      label: "Collaborate…",
      group: "Share",
      icon: "i-people",
      words: "collaborate share invite link url people live together send edit comment publish",
      availability: () => {
        const screen = availableUnless(["loading"], screenNow());
        if (!screen.enabled) return screen;
        const why = collaborateBlockedReason();
        return why ? { enabled: false, reason: why } : { enabled: true };
      },
      run: () => openCollaborate()
    },
    menuAction("server-publish", "Put this script on the server", "Share", "i-cloud-up", "publish upload server hosted", async () => { await publishToServer(); }),
    menuAction("export-again", () => menuItemLabel("export-again", "Export again"), "Export", "i-repeat", "export again repeat last", () => { exportAgain(); }),
    {
      id: "set-target",
      label: "Set target length…",
      group: "This document",
      icon: "i-clock",
      words: "target length goal duration aim runtime running time clock back timing over under minutes",
      availability: () => {
        const screen = availableUnless(["loading"], screenNow());
        return screen.enabled && reviewMode() ? { enabled: false, reason: "Viewing only — the writer sets the target" } : screen;
      },
      run: () => { promptForTarget(); }
    },
    {
      id: "prompter-open-in-browser",
      label: "Present in browser (Follow My Voice)",
      group: "This document",
      icon: "i-present",
      keys: desktopKeys(["mod+shift+p"]),
      bindKeys: () => false,
      words: "teleprompter browser follow my voice present",
      availability: () => loadedMenuItem("prompter-open-in-browser"),
      run: async () => { await openPrompterInBrowser(); }
    },
    menuAction("prompter-open-in-chromium", "Use Chromium Speech Recognition", "This document",
      "i-mic", "teleprompter chrome edge chromium speech recognition voice", async () => { await openPrompterInChromium(); })
  ];
  const disposers = definitions.map((d) => registry.register(d));
  return () => { for (const dispose of disposers) dispose(); };
}
