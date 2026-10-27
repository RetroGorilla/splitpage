import type { ActionDefinition, Availability } from "../application/actions.ts";
import { openDriveModal, openServerPicker, publishToServer, serverOpenItemState, serverPublishItemState } from "../js/13-hosted.js";
import { collaborateBlockedReason, maybeAskGuestName, openCollaborate } from "../js/13b-collaborate.js";
import { autoSavePolicy, savesStarted, toggleAutoSave } from "./save-bridge.ts";
import { saveBackItemState, saveBackToFile } from "../js/18-local-files.js";
import { driveOpenShown } from "../adapters/desktop/desktop-port.ts";
import { greyedOut, itemAvailability, shownWhen } from "./menu-items.ts";
import { OPENS_A_DIALOG, availableUnless, firstRefusal } from "../application/screen.ts";
import type { Blocker } from "../application/screen.ts";
import { screenNow } from "./screen-state.ts";

const LOADED: readonly Blocker[] = ["loading"];

const NO_DIALOG: readonly Blocker[] = ["loading", "dialog", "launcher"];

const OPENS_ONE: readonly Blocker[] = ["loading", ...OPENS_A_DIALOG];

function loaded(own: Availability = { enabled: true }, blockers: readonly Blocker[] = LOADED): Availability {
  return firstRefusal(availableUnless(blockers, screenNow()), own);
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
      id: "server-open",
      label: "Open from the server…",
      group: "File",
      icon: "i-server",
      words: "server hosted shared documents",
      availability: (source) => loaded(itemAvailability(serverOpenItemState(), source), OPENS_ONE),
      run: () => openServerPicker()
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
    }
  ];
  return definitions;
}
