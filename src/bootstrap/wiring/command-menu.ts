import type { ActionDefinition } from "../../application/actions.ts";
import { commandMenuActions as definitions } from "../../features/command-menu/actions.ts";
import { __init as mountCommandMenu } from "../../features/command-menu/command-menu.js";
import type { CommandMenuMount, CommandMenuPorts } from "../../features/command-menu/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { actions } from "./ports/actions.ts";
import { selection } from "./ports/editing.ts";
import { exports } from "./ports/files.ts";
import { askingFromLauncher, launcherShown, screen } from "./ports/screen.ts";
import { exportActionName, exportActionReason } from "./file-menu-export-controls.ts";
import { runExportAction } from "../../js/18-local-files.js";
import { fileMenuOpen, refreshFileMenu } from "./file-menu-controls.ts";

const commandMenu = owned<CommandMenuMount>();

export function mountCommandMenuFeature(): CommandMenuMount {
  return commandMenu.replace(() => {
    const ports: CommandMenuPorts = {
      actions, selection, exports,
      screen: { askingFromLauncher, launcherShown },
      exportActionName, exportActionReason, runExportAction, fileMenuOpen, refreshFileMenu
    };
    return mountCommandMenu(ports);
  });
}

export const stopCommandMenuFeature = commandMenu.stop;

export function commandMenuActions(): ActionDefinition[] {
  return definitions(commandMenu.owner, screen);
}
