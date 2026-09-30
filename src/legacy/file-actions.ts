import type { ActionRegistry } from "../application/actions.ts";
import { saveDoc } from "../js/14-export.js";
import { openLocalFile } from "../js/18-local-files.js";
import { fileMenuOpen, toggleFileMenu } from "../js/18b-file-menu.js";
import { openExportDialog } from "../js/18c-export-dialog.js";
import { closeCommandMenu, commandMenuOpen, openCommandMenu } from "../js/18d-command-menu.js";
import { availableUnless, firstRefusal } from "./screen.ts";
import { inDesktopApp, saveInProgress, screenNow } from "./screen-state.ts";

function pageOwnsKeys(): boolean {
  return !inDesktopApp();
}

function closeFileMenu(): void {
  if (fileMenuOpen()) toggleFileMenu(false);
}

export function registerFileActions(registry: ActionRegistry): () => void {
  const disposers = [
    registry.register({
      id: "save",
      label: "Save",
      group: "File",
      icon: "i-save",
      keys: ["mod+s"],
      bindKeys: pageOwnsKeys,
      claimKeys: true,
      words: "store keep write disk",
      availability: () => firstRefusal(availableUnless(["loading", "dialog", "launcher"], screenNow()),
        saveInProgress() ? { enabled: false, reason: "" } : { enabled: true }),
      run: () => {
        closeFileMenu();
        return saveDoc();
      }
    }),
    registry.register({
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
    }),
    registry.register({
      id: "open",
      label: "Open…",
      group: "File",
      icon: "i-folder",
      keys: ["mod+o"],
      bindKeys: pageOwnsKeys,
      claimKeys: true,
      words: "load file document project md splitpage docx",
      availability: () => availableUnless(["loading", "dialog", "launcher", "prompter", "writer"], screenNow()),
      run: async () => {
        closeFileMenu();
        await openLocalFile();
      }
    }),
    registry.register({
      id: "export",
      label: "Export…",
      group: "Export",
      icon: "i-export",
      keys: ["mod+e"],
      words: "download save as format dialog",
      availability: () => availableUnless(["loading", "dialog", "launcher", "prompter", "writer"], screenNow()),
      run: () => {
        closeFileMenu();
        openExportDialog();
      }
    }),
    registry.register({
      id: "command-menu",
      label: "Search commands…",
      group: "File",
      icon: "i-search",
      keys: ["mod+k"],
      words: "command palette search run",
      availability: () => (commandMenuOpen() ? { enabled: true } : availableUnless(["loading", "prompter", "writer", "dialog", "tour"], screenNow())),
      run: () => {
        if (commandMenuOpen()) closeCommandMenu();
        else openCommandMenu();
      }
    })
  ];
  return () => { for (const dispose of disposers) dispose(); };
}
