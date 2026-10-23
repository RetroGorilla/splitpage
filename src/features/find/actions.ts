import type { ActionDefinition } from "../../application/actions.ts";
import { availableUnless, everyOverlayBut } from "../../application/screen.ts";
import type { FindActionPorts, FindControls } from "./ports.ts";

export function findActions(current: () => FindControls | null, ports: FindActionPorts): ActionDefinition[] {
  return [{
    id: "find",
    label: "Find & replace",
    group: "This document",
    icon: "i-find",
    keys: ["mod+f", "mod+shift+f", "mod+alt+f", "mod+alt+shift+f"],
    words: "search replace look for",
    availability: () => current() ? availableUnless(["loading", ...everyOverlayBut("launcher")], ports.screen()) : { enabled: false },
    run: (source, input) => {
      if (input === "close") { current()?.closeFindBar(); return; }
      const field = document.getElementById("find-input");
      if (source === "shortcut" && ports.flags.findOpen() && field instanceof HTMLInputElement) field.select();
      else current()?.openFindBar();
    }
  }];
}
