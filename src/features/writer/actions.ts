import type { ActionDefinition, Availability } from "../../application/actions.ts";
import { VIEWING_ONLY } from "../../application/collaboration/review.ts";
import type { WriterActionPorts } from "./ports.ts";
import { availableUnless, everyOverlayBut } from "../../application/screen.ts";

const VIEWING_ONLY_LISTED = "Viewing only — the writer changes the script";

function shownButton(id: string): boolean {
  const button = document.getElementById(id);
  return button !== null && !button.hidden;
}

function withButton(id: string, availability: Availability): Availability {
  return shownButton(id) ? availability : { ...availability, visible: false };
}

export function writerActions(owner: () => { readonly openWriter: (keepMark?: number) => void } | null, ports: WriterActionPorts): ActionDefinition[] {
  const definitions: ActionDefinition[] = [
    {
      id: "write",
      label: "Write",
      group: "View",
      icon: "i-pen",
      words: "writer narration word processor audio column",
      availability: (source) => {
        const screen = availableUnless(["loading", ...everyOverlayBut("writer")], ports.screen());
        const refused: Availability = { enabled: false, reason: source === "command-menu" ? VIEWING_ONLY_LISTED : VIEWING_ONLY };
        const availability = screen.enabled && ports.review.reviewing() ? refused : screen;
        const mounted = owner() ? availability : { ...availability, enabled: false };
        return withButton("btn-write", mounted);
      },
      run: () => { owner()?.openWriter(); }
    }
  ];
  return definitions;
}
