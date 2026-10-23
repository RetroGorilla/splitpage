import type { ActionRegistry, ActionDefinition, Availability } from "../application/actions.ts";
import { registerAll } from "../application/actions.ts";
import { openGearPanel, openProductionPanel } from "../js/08-production-panels.js";
import { openBrollPanel } from "../js/08d-broll-panel.js";
import { VIEWING_ONLY } from "../js/13-hosted.js";
import { openWriter } from "../js/19-writer.js";
import { openPrompter } from "../js/20-teleprompter.js";
import { EVERY_OVERLAY, availableUnless, everyOverlayBut, firstRefusal } from "../application/screen.ts";
import { screenNow } from "./screen-state.ts";
import { reviewMode } from "./location-bridge.ts";
import { sidePanels } from "./panels-bridge.ts";

const VIEWING_ONLY_LISTED = "Viewing only — the writer changes the script";

function shownButton(id: string): boolean {
  const button = document.getElementById(id);
  return button !== null && !button.hidden;
}

function withButton(id: string, availability: Availability): Availability {
  return shownButton(id) ? availability : { ...availability, visible: false };
}

function panelOpen(id: string): boolean {
  const panel = document.getElementById(id);
  return panel !== null && !panel.hidden;
}

function loadingRefusal(waits: boolean): Availability {
  return waits ? availableUnless(["loading"], screenNow()) : { enabled: true };
}

function panel(id: string, label: string, buttonId: string, panelId: string, words: string, waitsForLoad: boolean,
  open: () => void): ActionDefinition {
  return {
    id,
    label,
    group: "View",
    icon: "i-panel",
    words,
    availability: () => withButton(buttonId, firstRefusal(loadingRefusal(waitsForLoad), availableUnless(EVERY_OVERLAY, screenNow()))),
    run: () => {
      if (panelOpen(panelId)) sidePanels().close(panelId);
      else open();
    }
  };
}

export function registerViewActions(registry: ActionRegistry, section: "panels" | "views" | "all" = "all"): () => void {
  const definitions: ActionDefinition[] = [
    panel("panel-production", "Production panel", "btn-production", "production-panel",
      "breakdown tags props locations cast show hide toggle", true, openProductionPanel),
    panel("panel-gear", "Gear panel", "btn-gear", "gear-panel",
      "gear equipment kit camera show hide toggle", true, openGearPanel),
    panel("panel-broll", "B-roll panel", "btn-broll", "broll-panel",
      "broll b roll shots cutaways show hide toggle", false, openBrollPanel),
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
    },
    {
      id: "present",
      label: "Present",
      group: "View",
      icon: "i-play",
      words: "teleprompter prompter autocue read play",
      availability: () => withButton("btn-present", availableUnless(["loading", ...everyOverlayBut("prompter")], screenNow())),
      run: () => { openPrompter(); }
    }
  ];
  return registerAll(registry, section === "panels" ? definitions.slice(0, 3) : section === "views" ? definitions.slice(3) : definitions);
}
