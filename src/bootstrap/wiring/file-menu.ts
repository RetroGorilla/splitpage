import type { ActionDefinition } from "../../application/actions.ts";
import { runningOnDesktop } from "../../application/desktop-presence.ts";
import { makeDesktopHandle } from "../../adapters/desktop/desktop-handle.ts";
import { fileMenuActions as definitions } from "../../features/file-menu/actions.ts";
import { startFileMenu as mountFileMenuDropdown } from "../../features/file-menu/file-menu.js";
import type { FileMenuDropdownMount, FileMenuDropdownPorts } from "../../features/file-menu/ports.ts";
import { saveDoc } from "../../legacy/save-bridge.ts";
import { documentReader } from "./ports/document.ts";
import { prompterWindows, recents } from "./ports/desktop.ts";
import { notices } from "./ports/effects.ts";
import { ids } from "./ports/identity.ts";
import { place } from "./ports/location.ts";
import { panelControl } from "./ports/panels.ts";
import { preferenceValues } from "./ports/preferences.ts";
import { resetProductionPanel } from "./ports/production.ts";
import { confirmation, saves } from "./ports/saving.ts";
import { screen } from "./ports/screen.ts";
import { history, opening, transitions } from "./ports/transitions.ts";
import { fileMenu } from "./file-menu-controls.ts";
import { migrateRows } from "../../legacy/document-ports.ts";
import { documentIdentity } from "./ports/document-identity-controls.ts";
import { importControls } from "./imports.ts";
import { localFilesOwner } from "./local-files.ts";
import { LONG_DEMO } from "../../starters/index.ts";

export function mountFileMenuDropdownFeature(): FileMenuDropdownMount {
  return fileMenu.replace(() => {
    const ports: FileMenuDropdownPorts = {
      document: documentReader,
      place,
      desktop: runningOnDesktop,
      recents,
      recentHandle: (entry) => makeDesktopHandle(entry),
      canOpenPrompter: prompterWindows,
      opening,
      transitions,
      history,
      notices,
      saves,
      saving: confirmation,
      preferences: preferenceValues,
      panels: panelControl,
      resetProductionPanel,
      ids,
      prepareDocument: (raw) => migrateRows(raw),
      syncIdentity: () => { documentIdentity.syncDocIdentity(); },
      longDemo: LONG_DEMO
    };
    return mountFileMenuDropdown(ports);
  });
}

export const stopFileMenuDropdownFeature = fileMenu.stop;

export function fileMenuActions(): ActionDefinition[] {
  return definitions(fileMenu.owner, {
    screen,
    desktop: runningOnDesktop,
    saves,
    save: (options) => saveDoc(options),
    openFile: () => localFilesOwner().openLocalFile(),
    openImport: () => { importControls()?.openImportModal(); }
  });
}
