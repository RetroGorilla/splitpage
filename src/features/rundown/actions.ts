import type { ActionDefinition, Availability } from "../../application/actions.ts";
import { availableUnless } from "../../application/screen.ts";
import type { ScreenState } from "../../application/screen.ts";

export interface RundownControls {
  readonly minimized: () => boolean;
  readonly toggleMinimized: () => void;
  readonly goToScene: (rowId: string | null) => void;
}

const OFF: Availability = { enabled: false };
const OPENED_FROM_ITS_VIEW: Availability = { enabled: true, visible: false };

export function rundownMinimizeActions(current: () => RundownControls | null, screen: () => ScreenState): ActionDefinition[] {
  return [
    {
      id: "toggle-rundown-min",
      label: "Minimise the rundown",
      group: "This document",
      icon: "i-rundown-min",
      words: "rundown strip timeline minimize collapse thin bar more room",
      availability: (source) => {
        const rundown = current();
        return rundown ? availableUnless(source === "button" ? [] : ["loading"], screen(), rundown.minimized()) : OFF;
      },
      run: () => { current()?.toggleMinimized(); }
    }
  ];
}

export function rundownSceneActions(current: () => RundownControls | null): ActionDefinition[] {
  return [
    {
      id: "go-to-scene",
      label: "Go to scene",
      group: "Open",
      availability: () => current() ? OPENED_FROM_ITS_VIEW : { enabled: false, visible: false },
      run: (_source, input) => {
        if (input !== null && typeof input !== "string") throw new TypeError("go-to-scene needs a scene id");
        current()?.goToScene(input);
      }
    }
  ];
}
