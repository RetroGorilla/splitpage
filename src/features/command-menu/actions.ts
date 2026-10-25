import type { ActionDefinition } from "../../application/actions.ts";
import { availableUnless, everyOverlayBut } from "../../application/screen.ts";
import type { ScreenState } from "../../application/screen.ts";
import type { CommandMenuControls } from "./ports.ts";

export function commandMenuActions(current: () => CommandMenuControls | null, screenNow: () => ScreenState): ActionDefinition[] {
  return [
    {
      id: "command-menu",
      label: "Search commands…",
      group: "File",
      icon: "i-search",
      keys: ["mod+k"],
      words: "command palette search run",
      availability: (source) => {
        if (current()?.commandMenuOpen()) return { enabled: true };
        const screen = availableUnless(["loading", ...everyOverlayBut("launcher")], screenNow());
        return !screen.enabled && source === "button" ? { enabled: false, reason: "" } : screen;
      },
      run: (source) => {
        if (!current()?.commandMenuOpen()) current()?.openCommandMenu();
        else if (source === "shortcut") current()?.closeCommandMenu();
      }
    }
  ];
}
