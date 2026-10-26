import { updateControls } from "./update.ts";
import { __init as mountNewTab } from "../../features/newtab/newtab.js";
import type { NewTabMount, NewTabPorts } from "../../features/newtab/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { runningOnDesktop } from "../../application/desktop-presence.ts";
import { makeDesktopHandle } from "../../adapters/desktop/desktop-handle.ts";
import { actions } from "./ports/actions.ts";
import { documentReader } from "./ports/document.ts";
import { launch, recents } from "./ports/desktop.ts";
import { notices } from "./ports/effects.ts";
import { lastFile } from "./ports/files.ts";
import { ids } from "./ports/identity.ts";
import { place } from "./ports/location.ts";
import { preferenceValues } from "./ports/preferences.ts";
import { resetProductionPanel } from "./ports/production.ts";
import { confirmation } from "./ports/saving.ts";
import { draftResume, seedCheck, startup } from "./ports/startup.ts";
import { text } from "./ports/text.ts";
import { opening, transitions } from "./ports/transitions.ts";
import { migrateRows } from "../../legacy/document-ports.ts";
import { syncDocIdentity } from "../../js/02b-doc-id.js";
import { openImportModal } from "../../js/11-import.js";
import { openLocalFile } from "../../js/18-local-files.js";
import { STARTERS, starterById } from "../../starters/index.ts";

const newTab = owned<NewTabMount>();

export function mountNewTabFeature(): NewTabMount {
  return newTab.replace(() => {
    const ports: NewTabPorts = {
      document: documentReader,
      place,
      desktop: runningOnDesktop,
      recents,
      launch,
      lastFile,
      seedCheck,
      draftResume,
      startup,
      transitions,
      opening,
      text,
      notices,
      actions,
      preferences: preferenceValues,
      saving: confirmation,
      resetProductionPanel,
      ids,
      prepareDocument: (raw) => migrateRows(raw),
      syncIdentity: () => { syncDocIdentity(); },
      importText: (options) => { openImportModal(options); },
      openFile: () => openLocalFile(),
      desktopDownload: { url: () => updateControls()?.desktopAppUrl() ?? "", offered: () => updateControls()?.desktopAppOffered() ?? false },
      starters: STARTERS,
      findStarter: (id) => starterById(id),
      recentHandle: (entry) => makeDesktopHandle(entry)
    };
    return mountNewTab(ports);
  });
}

export const stopNewTabFeature = newTab.stop;

export function newTabControls(): NewTabMount | null {
  return newTab.owner();
}
