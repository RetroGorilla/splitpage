import type { ActionRegistry, Availability } from "../application/actions.ts";
import { S } from "../js/_state.js";
import { saveDoc } from "../js/14-export.js";
import { openLocalFile } from "../js/18-local-files.js";
import { fileMenuOpen, toggleFileMenu } from "../js/18b-file-menu.js";
import { openExportDialog } from "../js/18c-export-dialog.js";
import { closeCommandMenu, commandMenuOpen, openCommandMenu } from "../js/18d-command-menu.js";
import { screenNow } from "./document-actions.ts";
import { menuItemAvailability } from "./menu-items.ts";
import { availableUnless } from "./screen.ts";
import type { Blocker } from "./screen.ts";

function buttonAllows(id: string): Availability | null {
  const button = document.getElementById(id);
  return button instanceof HTMLButtonElement && button.disabled ? { enabled: false, reason: "" } : null;
}

function pageOwnsKeys(): boolean {
  return !S.DESKTOP;
}

function unless(blockers: readonly Blocker[], own: Availability | null): Availability {
  const screen = availableUnless(blockers, screenNow());
  return screen.enabled && own ? own : screen;
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
      availability: () => unless(["loading", "dialog"], buttonAllows("btn-save")),
      run: () => saveDoc()
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
      availability: () => unless(["loading", "dialog"], menuItemAvailability("save-as")),
      run: () => saveDoc({ saveAs: true })
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
      availability: () => unless(["loading", "dialog", "prompter", "writer"], menuItemAvailability("open")),
      run: async () => {
        if (fileMenuOpen()) toggleFileMenu(false);
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
      availability: () => availableUnless(["loading", "dialog", "prompter", "writer"], screenNow()),
      run: () => {
        if (fileMenuOpen()) toggleFileMenu(false);
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
