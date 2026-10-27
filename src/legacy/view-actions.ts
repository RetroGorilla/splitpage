import type { ActionDefinition, Availability } from "../application/actions.ts";
import { VIEWING_ONLY } from "../js/13-hosted.js";
import { openWriter } from "../js/19-writer.js";
import { availableUnless, everyOverlayBut } from "../application/screen.ts";
import { screenNow } from "./screen-state.ts";
import { reviewMode } from "./location-bridge.ts";

const VIEWING_ONLY_LISTED = "Viewing only — the writer changes the script";

function shownButton(id: string): boolean {
  const button = document.getElementById(id);
  return button !== null && !button.hidden;
}

function withButton(id: string, availability: Availability): Availability {
  return shownButton(id) ? availability : { ...availability, visible: false };
}

export function viewActions(): ActionDefinition[] {
  const definitions: ActionDefinition[] = [
    {
      id: "write",
      label: "Write",
      group: "View",
      icon: "i-pen",
      words: "writer narration word processor audio column",
      availability: (source) => {
        const screen = availableUnless(["loading", ...everyOverlayBut("writer")], screenNow());
        const refused: Availability = { enabled: false, reason: source === "command-menu" ? VIEWING_ONLY_LISTED : VIEWING_ONLY };
        return withButton("btn-write", screen.enabled && reviewMode() ? refused : screen);
      },
      run: () => { openWriter(); }
    }
  ];
  return definitions;
}
