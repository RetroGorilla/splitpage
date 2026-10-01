import type { ActionRegistry } from "../application/actions.ts";
import { handleFileMenuAction } from "../js/18-local-files.js";
import { toggleFileMenu } from "../js/18b-file-menu.js";

const HEADER_ACTIONS: Readonly<Record<string, string>> = {
  "save": "save",
  "toggle-production": "panel-production",
  "toggle-gear": "panel-gear",
  "toggle-comments": "panel-comments",
  "write": "write",
  "present": "present"
};

function isFileMenuItem(id: string): boolean {
  return Array.prototype.some.call(document.querySelectorAll("#file-menu [data-file-action]"),
    (item: Element) => item.getAttribute("data-file-action") === id);
}

export function nativeMenuRunner(registry: ActionRegistry): (command: string) => boolean {
  return (command) => {
    const header = HEADER_ACTIONS[command];
    const id = header ?? command;
    if (!registry.has(id)) return false;
    const view = registry.view(id, "native-menu");
    if (view && !view.enabled && !view.reason) return true;
    if (header !== undefined) {
      registry.invoke(id, "native-menu");
      toggleFileMenu(false);
    } else if (isFileMenuItem(id)) {
      handleFileMenuAction(id, "native-menu");
    } else {
      registry.invoke(id, "native-menu");
    }
    return true;
  };
}
