import type { ActionRegistry, ActionDefinition, Availability } from "../application/actions.ts";
import { registerAll } from "../application/actions.ts";
import { closeProductionPanel, closeGearPanel, openGearPanel, openProductionPanel } from "../js/08-production-panels.js";
import { closeBrollPanel, openBrollPanel } from "../js/08d-broll-panel.js";
import { closeCommentsPanel, openCommentsPanel } from "../js/10-comments.js";
import { VIEWING_ONLY, reviewMode } from "../js/13-hosted.js";
import { openWriter } from "../js/19-writer.js";
import { openPrompter } from "../js/20-teleprompter.js";
import { availableUnless } from "./screen.ts";
import { screenNow } from "./screen-state.ts";

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

function loadingRefusal(reason: string | null): Availability {
  return reason !== null && screenNow().loading ? { enabled: false, reason } : { enabled: true };
}

function panel(id: string, label: string, buttonId: string, panelId: string, words: string, whileLoading: string | null,
  open: () => void, close: () => void): ActionDefinition {
  return {
    id,
    label,
    group: "View",
    icon: "i-panel",
    words,
    availability: () => withButton(buttonId, loadingRefusal(whileLoading)),
    run: () => {
      if (panelOpen(panelId)) close();
      else open();
    }
  };
}

export function registerViewActions(registry: ActionRegistry): () => void {
  const definitions: ActionDefinition[] = [
    panel("panel-production", "Production panel", "btn-production", "production-panel",
      "breakdown tags props locations cast show hide toggle", "Still loading...", openProductionPanel, closeProductionPanel),
    panel("panel-gear", "Gear panel", "btn-gear", "gear-panel",
      "gear equipment kit camera show hide toggle", "Still loading...", openGearPanel, closeGearPanel),
    panel("panel-broll", "B-roll panel", "btn-broll", "broll-panel",
      "broll b roll shots cutaways show hide toggle", null, openBrollPanel, closeBrollPanel),
    panel("panel-comments", "Comments panel", "btn-comments", "comments-panel",
      "comments notes review feedback show hide toggle", "Still loading…", openCommentsPanel, closeCommentsPanel),
    {
      id: "write",
      label: "Write",
      group: "View",
      icon: "i-pen",
      words: "writer narration word processor audio column",
      availability: (source) => {
        const screen = availableUnless(["loading"], screenNow());
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
      availability: () => withButton("btn-present", availableUnless(["loading"], screenNow())),
      run: () => { openPrompter(); }
    }
  ];
  return registerAll(registry, definitions);
}
