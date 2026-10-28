import type { ActionDefinition, Availability } from "../../application/actions.ts";
import type { WriterActionPorts } from "./ports.ts";
import { availableUnless, everyOverlayBut } from "../../application/screen.ts";

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
      availability: () => {
        const screen = availableUnless(["loading", ...everyOverlayBut("writer")], ports.screen());
        const mounted = owner() ? screen : { ...screen, enabled: false };
        return withButton("btn-write", mounted);
      },
      run: () => { owner()?.openWriter(); }
    }
  ];
  return definitions;
}
