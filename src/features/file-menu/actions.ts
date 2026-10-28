import type { ImportSavingOwner } from "../../application/save/import-saving-ports.ts";
import type { ScreenState } from "../../application/screen.ts";
import type { ActionDefinition, ActionSource, Availability } from "../../application/actions.ts";
import { EVERY_OVERLAY, OPENS_A_DIALOG, availableUnless, firstRefusal } from "../../application/screen.ts";
import type { Blocker } from "../../application/screen.ts";
import type { AutosaveActionPorts, FileMenuActionPorts, FileMenuControls, FileMenuExportActionPorts, FileMenuExportControls, MenuItemState } from "./ports.ts";

const UNMOUNTED: Availability = { enabled: false };

const OPENS_ONE: readonly Blocker[] = ["loading", ...OPENS_A_DIALOG];

function itemAvailability(state: MenuItemState, source: ActionSource): Availability {
  const visible = !state.hidden;
  if (state.disabled) return { enabled: false, reason: source === "native-menu" ? "" : state.reason, visible };
  return visible ? { enabled: true } : { enabled: true, visible };
}

export function fileMenuActions(current: () => FileMenuControls | null, ports: FileMenuActionPorts): ActionDefinition[] {
  const pageOwnsKeys = (): boolean => !ports.desktop();
  const closeFileMenu = (owner: FileMenuControls): void => {
    if (owner.fileMenuOpen()) owner.toggleFileMenu(false);
  };
  const loaded = (own: Availability = { enabled: true }, blockers: readonly Blocker[] = ["loading"]): Availability =>
    firstRefusal(availableUnless(blockers, ports.screen()), own);
  return [
    {
      id: "save",
      label: "Save",
      group: "File",
      icon: "i-save",
      keys: ["mod+s"],
      bindKeys: pageOwnsKeys,
      claimKeys: true,
      words: "store keep write disk",
      availability: () => current() ? firstRefusal(
        availableUnless(["loading", "dialog", "launcher"], ports.screen()),
        ports.saves.busy() ? { enabled: false, reason: "" } : { enabled: true }) : UNMOUNTED,
      run: () => {
        const owner = current();
        if (!owner) return;
        closeFileMenu(owner);
        return ports.save();
      }
    },
    {
      id: "save-as",
      label: "Save a copy…",
      group: "File",
      icon: "i-copy",
      keys: ["mod+shift+s"],
      bindKeys: pageOwnsKeys,
      claimKeys: true,
      words: "save as duplicate copy another file",
      availability: () => current() ? availableUnless(["loading", "dialog", "launcher"], ports.screen()) : UNMOUNTED,
      run: () => {
        const owner = current();
        if (!owner) return;
        closeFileMenu(owner);
        return ports.save({ saveAs: true });
      }
    },
    {
      id: "open",
      label: "Open…",
      group: "File",
      icon: "i-folder",
      keys: ["mod+o"],
      bindKeys: pageOwnsKeys,
      claimKeys: true,
      words: "load file document project md splitpage docx",
      availability: () => current() ? availableUnless(["loading", ...EVERY_OVERLAY], ports.screen()) : UNMOUNTED,
      run: async () => {
        const owner = current();
        if (!owner) return;
        closeFileMenu(owner);
        await ports.openFile();
      }
    },
    {
      id: "close-file-menu",
      label: "Close the file menu",
      group: "File",
      availability: () => current() ? { enabled: true, visible: false } : { enabled: false, visible: false },
      run: () => { current()?.toggleFileMenu(false); }
    },
    {
      id: "new",
      label: "New script",
      group: "File",
      icon: "i-file-plus",
      words: "blank empty create start fresh document",
      availability: () => current() ? loaded() : UNMOUNTED,
      run: () => { current()?.startNewScript(); }
    },
    {
      id: "paste",
      label: "Import: paste a script…",
      group: "File",
      icon: "i-clipboard",
      words: "import revised draft text",
      availability: () => current() ? loaded({ enabled: true }, OPENS_ONE) : UNMOUNTED,
      run: () => { ports.openImport(); }
    },
    {
      id: "long-demo",
      label: "Open the long demo (30 scenes)",
      group: "Help",
      icon: "i-file-plus",
      words: "demo example sample long thirty 30 scenes test try every feature",
      availability: () => current() ? { enabled: true } : UNMOUNTED,
      run: () => { current()?.openLongDemo(); }
    }
  ];
}

export function fileMenuExportActions(current: () => FileMenuExportControls | null, ports: FileMenuExportActionPorts): ActionDefinition[] {
  return [
    {
      id: "export",
      label: "Export…",
      group: "Export",
      icon: "i-export",
      keys: ["mod+e"],
      words: "download save as format dialog",
      availability: () => current() ? availableUnless(["loading", ...EVERY_OVERLAY], ports.screen()) : { enabled: false },
      run: () => {
        const owner = current();
        if (!owner) return;
        ports.closeMenu();
        owner.openExportDialog();
      }
    },
    {
      id: "export-again",
      label: () => current()?.exportAgainItemState().label || "Export again",
      group: "Export",
      icon: "i-repeat",
      words: "export again repeat last",
      availability: (source) => {
        const owner = current();
        if (!owner) return { enabled: false, visible: false };
        const state = owner.exportAgainItemState();
        const own = state.disabled
          ? { enabled: false, reason: source === "native-menu" ? "" : state.reason }
          : { enabled: true };
        return { ...firstRefusal(availableUnless(["loading"], ports.screen()), own), visible: false };
      },
      run: () => { current()?.exportAgain(); }
    }
  ];
}

export function fileWritebackActions(current: () => Pick<ImportSavingOwner, "saveBackItemState" | "saveBackToFile"> | null, screen: () => ScreenState): ActionDefinition[] {
  const saveBackItemState = () => current()?.saveBackItemState() ?? { hidden: false, disabled: true, reason: "", label: "Save to file" };
  const saveBackToFile = () => current()?.saveBackToFile();
  const loaded = (own: Availability, blockers: readonly Blocker[]) => firstRefusal(availableUnless(blockers, screen()), own);
  const NO_DIALOG: readonly Blocker[] = ["loading", "dialog", "launcher"];
  return [
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
    }
  ];
}

export function autosaveActions(ports: AutosaveActionPorts): ActionDefinition[] {
  return [
    {
      id: "autosave",
      label: "Autosave",
      group: "File",
      icon: "i-autosave",
      words: "automatic save saving",
      availability: () => ({ ...firstRefusal(availableUnless(["loading"], ports.screen()), { enabled: true }), checked: ports.autosave.on() }),
      run: () => { ports.autosave.toggle(); }
    }
  ];
}
