import type { ActionRegistry, RefusalPresenter } from "../application/actions.ts";
import { localFileMenuControls } from "./wiring/local-files.ts";
import { exportFormats } from "./wiring/export-registry.ts";
import { availableUnless } from "../application/screen.ts";
import { screenNow } from "../legacy/screen-state.ts";

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

function formatRefused(id: string, present: RefusalPresenter): boolean {
  if (!exportFormats.isAction(id)) return false;
  localFileMenuControls().noteFileMenuChoice(id);
  const a = availableUnless(["dialog", "launcher"], screenNow());
  if (a.enabled) return false;
  present({ kind: "unavailable", id, reason: a.reason ?? "" }, "native-menu");
  return true;
}

export function nativeMenuRunner(registry: ActionRegistry, present: RefusalPresenter, closeFileMenu: () => void): (command: string) => boolean {
  return (command) => {
    const header = HEADER_ACTIONS[command];
    const id = header ?? command;
    if (!registry.has(id)) return formatRefused(id, present);
    const view = registry.view(id, "native-menu");
    if (view && !view.enabled && !view.reason) return true;
    if (header !== undefined) {
      registry.invoke(id, "native-menu");
      closeFileMenu();
    } else if (isFileMenuItem(id)) {
      localFileMenuControls().handleFileMenuAction(id, "native-menu");
    } else {
      registry.invoke(id, "native-menu");
    }
    return true;
  };
}
