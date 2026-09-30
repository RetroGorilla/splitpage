import type { ActionDefinition, ActionRegistry, Availability } from "../application/actions.ts";
import { promptForTarget } from "../js/03-sync.js";
import { openGdocModal, openImportModal } from "../js/11-import.js";
import { openDriveModal, openServerPicker, publishToServer, reviewMode, serverOpenItemState, serverPublishItemState } from "../js/13-hosted.js";
import { collaborateBlockedReason, openCollaborate } from "../js/13b-collaborate.js";
import { autoSaveEnabled, toggleAutoSave } from "../js/14-export.js";
import { saveBackItemState, saveBackToFile } from "../js/18-local-files.js";
import { pasteItemState, startNewScript } from "../js/18b-file-menu.js";
import { exportAgain, exportAgainItemState } from "../js/18c-export-dialog.js";
import {
  canOpenPrompterInBrowser,
  canOpenPrompterInChromium,
  driveOpenShown,
  openPrompterInBrowser,
  openPrompterInChromium
} from "../js/20f-desktop.js";
import { greyedOut, itemAvailability, shownWhen } from "./menu-items.ts";
import { availableUnless, firstRefusal } from "./screen.ts";
import { inDesktopApp, screenNow } from "./screen-state.ts";

function loaded(own: Availability = { enabled: true }): Availability {
  return firstRefusal(availableUnless(["loading"], screenNow()), own);
}

function desktopKeys(keys: readonly string[]): () => readonly string[] {
  return () => (inDesktopApp() ? keys : []);
}

export function registerShareActions(registry: ActionRegistry): () => void {
  const definitions: ActionDefinition[] = [
    {
      id: "save-back",
      label: () => saveBackItemState().label,
      group: "File",
      icon: "i-save",
      words: "write back original docx csv txt",
      availability: (source) => {
        const a = loaded(itemAvailability(saveBackItemState(), source));
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
      availability: () => ({ ...loaded(), checked: Boolean(autoSaveEnabled) }),
      run: () => { toggleAutoSave(); }
    },
    {
      id: "new",
      label: "New script",
      group: "File",
      icon: "i-file-plus",
      words: "blank empty create start fresh document",
      availability: () => loaded(),
      run: () => { startNewScript(); }
    },
    {
      id: "server-open",
      label: "Open from the server…",
      group: "File",
      icon: "i-server",
      words: "server hosted shared documents",
      availability: (source) => loaded(itemAvailability(serverOpenItemState(), source)),
      run: () => openServerPicker()
    },
    {
      id: "paste",
      label: "Import: paste a script…",
      group: "File",
      icon: "i-clipboard",
      words: "import revised draft text",
      availability: (source) => loaded(itemAvailability(pasteItemState(), source)),
      run: () => { openImportModal(); }
    },
    {
      id: "gdoc-import",
      label: "Import: Google Doc link…",
      group: "File",
      icon: "i-link",
      words: "import google docs link url",
      availability: () => loaded(),
      run: () => { openGdocModal(); }
    },
    {
      id: "drive-open",
      label: "Import: Google Drive…",
      group: "File",
      icon: "i-cloud",
      words: "import google drive cloud files",
      availability: () => shownWhen(driveOpenShown()),
      run: () => { openDriveModal(); }
    },
    {
      id: "collaborate",
      label: "Collaborate…",
      group: "Share",
      icon: "i-people",
      words: "collaborate share invite link url people live together send edit comment publish",
      availability: (source) => {
        const why = collaborateBlockedReason();
        return loaded(why ? greyedOut(why, source) : { enabled: true });
      },
      run: () => openCollaborate()
    },
    {
      id: "server-publish",
      label: "Put this script on the server",
      group: "Share",
      icon: "i-cloud-up",
      words: "publish upload server hosted",
      availability: (source) => loaded(itemAvailability(serverPublishItemState(), source)),
      run: async () => { await publishToServer(); }
    },
    {
      id: "export-again",
      label: () => exportAgainItemState().label || "Export again",
      group: "Export",
      icon: "i-repeat",
      words: "export again repeat last",
      availability: (source) => ({ ...loaded(itemAvailability(exportAgainItemState(), source)), visible: false }),
      run: () => { exportAgain(); }
    },
    {
      id: "set-target",
      label: "Set target length…",
      group: "This document",
      icon: "i-clock",
      words: "target length goal duration aim runtime running time clock back timing over under minutes",
      availability: () => loaded(reviewMode() ? { enabled: false, reason: "Viewing only — the writer sets the target" } : { enabled: true }),
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
      availability: () => loaded(shownWhen(canOpenPrompterInBrowser())),
      run: async () => { await openPrompterInBrowser(); }
    },
    {
      id: "prompter-open-in-chromium",
      label: "Use Chromium Speech Recognition",
      group: "This document",
      icon: "i-mic",
      words: "teleprompter chrome edge chromium speech recognition voice",
      availability: () => loaded(shownWhen(canOpenPrompterInChromium())),
      run: async () => { await openPrompterInChromium(); }
    }
  ];
  const disposers = definitions.map((d) => registry.register(d));
  return () => { for (const dispose of disposers) dispose(); };
}
