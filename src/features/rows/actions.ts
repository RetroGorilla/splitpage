import type { ActionDefinition } from "../../application/actions.ts";
import { availableUnless } from "../../application/screen.ts";
import type { ScreenState } from "../../application/screen.ts";

interface RowControls {
  readonly reveal: (rowId: string) => void;
}

export function rowActions(rows: RowControls): ActionDefinition[] {
  return [
    {
      id: "reveal-row",
      label: "Show beat",
      group: "Open",
      availability: () => ({ enabled: true, visible: false }),
      run: (_source, input) => {
        if (typeof input !== "string") throw new TypeError("reveal-row needs a scene id");
        rows.reveal(input);
      }
    }
  ];
}

interface HideShotActionPorts {
  readonly toggle: () => void;
  readonly hidden: () => boolean;
  readonly screen: () => ScreenState;
}

export function hideShotActions(ports: HideShotActionPorts): ActionDefinition[] {
  return [
    {
      id: "toggle-hide-shot",
      label: "Hide filmed beats",
      group: "This document",
      icon: "i-eye-off",
      keys: ["mod+alt+h", "mod+alt+shift+h"],
      words: "collapse done finished filter filmed beats",
      availability: () => availableUnless(["loading", "dialog"], ports.screen(), ports.hidden()),
      run: () => { ports.toggle(); }
    }
  ];
}
