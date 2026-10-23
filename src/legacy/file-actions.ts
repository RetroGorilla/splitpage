import type { ActionRegistry } from "../application/actions.ts";
import { registerAll } from "../application/actions.ts";
import { saveDoc } from "./save-bridge.ts";
import { openLocalFile } from "../js/18-local-files.js";
import { fileMenuOpen, toggleFileMenu } from "../js/18b-file-menu.js";
import { openExportDialog } from "../js/18c-export-dialog.js";
import { closeCommandMenu, commandMenuOpen, openCommandMenu } from "../js/18d-command-menu.js";
import { EVERY_OVERLAY, availableUnless, everyOverlayBut, firstRefusal } from "./screen.ts";
import { inDesktopApp, saveInProgress, screenNow } from "./screen-state.ts";

function pageOwnsKeys(): boolean {
  return !inDesktopApp();
}

function closeFileMenu(): void {
  if (fileMenuOpen()) toggleFileMenu(false);
}

export function registerFileActions(registry: ActionRegistry): () => void {
  return registerAll(registry, [
    {
      id: "save",
      label: "Save",
      group: "File",
      icon: "i-save",
      keys: ["mod+s"],
      bindKeys: pageOwnsKeys,
      claimKeys: true,
      words: "store keep write disk",
      availability: () => firstRefusal(
        availableUnless(["loading", "dialog", "launcher"], screenNow()),
        saveInProgress() ? { enabled: false, reason: "" } : { enabled: true }),
      run: () => {
        closeFileMenu();
        return saveDoc();
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
      availability: () => availableUnless(["loading", "dialog", "launcher"], screenNow()),
      run: () => {
        closeFileMenu();
        return saveDoc({ saveAs: true });
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
      availability: () => availableUnless(["loading", ...EVERY_OVERLAY], screenNow()),
      run: async () => {
        closeFileMenu();
        await openLocalFile();
      }
    },
    {
      id: "export",
      label: "Export…",
      group: "Export",
      icon: "i-export",
      keys: ["mod+e"],
      words: "download save as format dialog",
      availability: () => availableUnless(["loading", ...EVERY_OVERLAY], screenNow()),
      run: () => {
        closeFileMenu();
        openExportDialog();
      }
    },
    {
      id: "command-menu",
      label: "Search commands…",
      group: "File",
      icon: "i-search",
      keys: ["mod+k"],
      words: "command palette search run",
      availability: (source) => {
        if (commandMenuOpen()) return { enabled: true };
        const screen = availableUnless(["loading", ...everyOverlayBut("launcher")], screenNow());
        return !screen.enabled && source === "button" ? { enabled: false, reason: "" } : screen;
      },
      run: (source) => {
        if (!commandMenuOpen()) openCommandMenu();
        else if (source === "shortcut") closeCommandMenu();
      }
    }
  ]);
}
