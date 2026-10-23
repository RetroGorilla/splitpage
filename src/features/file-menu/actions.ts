import type { ActionDefinition } from "../../application/actions.ts";
import { EVERY_OVERLAY, availableUnless, firstRefusal } from "../../application/screen.ts";
import type { FileMenuExportActionPorts, FileMenuExportControls } from "./ports.ts";

export function fileMenuExportActions(current: () => FileMenuExportControls | null, ports: FileMenuExportActionPorts): ActionDefinition[] {
  return [
    {
      id: "export",
      label: "Export…",
      group: "File",
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
