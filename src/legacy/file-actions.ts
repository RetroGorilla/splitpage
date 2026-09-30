import type { ActionRegistry } from "../application/actions.ts";
import { fileMenuOpen, toggleFileMenu } from "../js/18b-file-menu.js";
import { openExportDialog } from "../js/18c-export-dialog.js";
import { closeCommandMenu, commandMenuOpen, openCommandMenu } from "../js/18d-command-menu.js";
import { screenNow } from "./document-actions.ts";
import { availableUnless } from "./screen.ts";

export function registerFileActions(registry: ActionRegistry): () => void {
  const disposers = [
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
