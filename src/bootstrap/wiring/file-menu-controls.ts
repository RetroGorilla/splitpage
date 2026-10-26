import type { FileMenuDropdownMount, MenuItemState } from "../../features/file-menu/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import type { Owned } from "../../features/routing/owned.ts";

const ownFileMenu: () => Owned<FileMenuDropdownMount> = owned;

export const fileMenu = ownFileMenu();

function current(): FileMenuDropdownMount {
  const owner = fileMenu.owner();
  if (!owner) throw new Error("The file menu is not mounted");
  return owner;
}

export function toggleFileMenu(force?: boolean, options?: { focusFirst?: boolean; returnFocus?: boolean }): void { fileMenu.owner()?.toggleFileMenu(force, options); }
export function fileMenuOpen(): boolean { return fileMenu.owner()?.fileMenuOpen() ?? false; }
export function toggleSubmenu(name: string | null, force?: boolean, focusFirst?: boolean): void { fileMenu.owner()?.toggleSubmenu(name, force, focusFirst); }
export function refreshFileMenu(): void { fileMenu.owner()?.refreshFileMenu(); }
export function refreshOpenFileMenu(): void { fileMenu.owner()?.refreshOpenFileMenu(); }
export function onFileMenuRefresh(listener: () => void): () => void { return current().onFileMenuRefresh(listener); }
export function pasteItemState(): MenuItemState { return current().pasteItemState(); }
export function startNewScript(): boolean { return current().startNewScript(); }
export function openLongDemo(): boolean { return current().openLongDemo(); }
