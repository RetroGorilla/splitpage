import type { ActionDefinition, Availability } from "../application/actions.ts";
import { promptForTarget } from "../js/03-sync.js";
import { openGdocModal, openImportModal } from "../js/11-import.js";
import { openDriveModal, openServerPicker, publishToServer, serverOpenItemState, serverPublishItemState } from "../js/13-hosted.js";
import { collaborateBlockedReason, maybeAskGuestName, openCollaborate } from "../js/13b-collaborate.js";
import { autoSavePolicy, savesStarted, toggleAutoSave } from "./save-bridge.ts";
import { saveBackItemState, saveBackToFile } from "../js/18-local-files.js";
import { pasteItemState, startNewScript } from "../js/18b-file-menu.js";
import { canOpenPrompterInBrowser, canOpenPrompterInChromium } from "../adapters/desktop/desktop-port.ts";
import {
  driveOpenShown,
  openPrompterInBrowser,
  openPrompterInChromium
} from "../js/20f-desktop.js";
import { greyedOut, itemAvailability, shownWhen } from "./menu-items.ts";
import { OPENS_A_DIALOG, availableUnless, firstRefusal } from "../application/screen.ts";
import type { Blocker } from "../application/screen.ts";
import { inDesktopApp, screenNow } from "./screen-state.ts";
import { reviewMode } from "./location-bridge.ts";

const LOADED: readonly Blocker[] = ["loading"];

const NO_DIALOG: readonly Blocker[] = ["loading", "dialog", "launcher"];

const OPENS_ONE: readonly Blocker[] = ["loading", ...OPENS_A_DIALOG];

function loaded(own: Availability = { enabled: true }, blockers: readonly Blocker[] = LOADED): Availability {
  return firstRefusal(availableUnless(blockers, screenNow()), own);
}

function desktopKeys(keys: readonly string[]): () => readonly string[] {
  return () => (inDesktopApp() ? keys : []);
}

export function shareActions(): ActionDefinition[] {
  const definitions: ActionDefinition[] = [
    {
      id: "save-back",
      label: () => saveBackItemState().label,
      group: "File",
      icon: "i-save",
      words: "write back original docx csv txt",
      availability: (source) => {
        const a = loaded(itemAvailability(saveBackItemState(), source), NO_DIALOG);
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
      availability: () => ({ ...loaded(), checked: savesStarted() && autoSavePolicy().enabled() }),
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
      availability: (source) => loaded(itemAvailability(serverOpenItemState(), source), OPENS_ONE),
      run: () => openServerPicker()
    },
    {
      id: "paste",
      label: "Import: paste a script…",
      group: "File",
      icon: "i-clipboard",
      words: "import revised draft text",
      availability: (source) => loaded(itemAvailability(pasteItemState(), source), OPENS_ONE),
      run: () => { openImportModal(); }
    },
    {
      id: "gdoc-import",
      label: "Import: Google Doc link…",
      group: "File",
      icon: "i-link",
      words: "import google docs link url",
      availability: () => loaded(undefined, OPENS_ONE),
      run: () => { openGdocModal(); }
    },
    {
      id: "show-gdoc-import",
      label: "Show the Google Docs import",
      group: "File",
      availability: () => ({ enabled: true, visible: false }),
      run: () => { openGdocModal(); }
    },
    {
      id: "drive-open",
      label: "Import: Google Drive…",
      group: "File",
      icon: "i-cloud",
      words: "import google drive cloud files",
      availability: () => loaded(shownWhen(driveOpenShown()), OPENS_A_DIALOG),
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
        return loaded(why ? greyedOut(why, source) : { enabled: true }, OPENS_ONE);
      },
      run: () => openCollaborate()
    },
    {
      id: "ask-guest-name",
      label: "Ask a link guest for their name",
      group: "Share",
      availability: () => ({ enabled: true, visible: false }),
      run: () => { maybeAskGuestName(); }
    },
    {
      id: "server-publish",
      label: "Put this script on the server",
      group: "Share",
      icon: "i-cloud-up",
      words: "publish upload server hosted",
      availability: (source) => loaded(itemAvailability(serverPublishItemState(), source), NO_DIALOG),
      run: async () => { await publishToServer(); }
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
      availability: () => loaded(shownWhen(canOpenPrompterInBrowser()), NO_DIALOG),
      run: async () => { await openPrompterInBrowser(); }
    },
    {
      id: "prompter-open-in-chromium",
      label: "Use Chromium Speech Recognition",
      group: "This document",
      icon: "i-mic",
      words: "teleprompter chrome edge chromium speech recognition voice",
      availability: () => loaded(shownWhen(canOpenPrompterInChromium()), NO_DIALOG),
      run: async () => { await openPrompterInChromium(); }
    }
  ];
  return definitions;
}
