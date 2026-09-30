import type { ActionRegistry, ActionDefinition, Availability } from "../application/actions.ts";
import { closeProductionPanel, closeGearPanel, openGearPanel, openProductionPanel } from "../js/08-production-panels.js";
import { closeBrollPanel, openBrollPanel } from "../js/08d-broll-panel.js";
import { closeCommentsPanel, openCommentsPanel } from "../js/10-comments.js";
import { reviewMode } from "../js/13-hosted.js";
import { openWriter } from "../js/19-writer.js";
import { openPrompter } from "../js/20-teleprompter.js";
import { availableUnless } from "./screen.ts";
import { screenNow } from "./screen-state.ts";

const VIEWING_ONLY = "Viewing only — you can comment on this script, but not change it.";

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

function panel(id: string, label: string, buttonId: string, panelId: string, words: string, open: () => void, close: () => void): ActionDefinition {
  return {
    id,
    label,
    group: "View",
    icon: "i-panel",
    words,
    availability: () => withButton(buttonId, availableUnless(["loading"], screenNow())),
    run: () => {
      if (panelOpen(panelId)) close();
      else open();
    }
  };
}

export function registerViewActions(registry: ActionRegistry): () => void {
  const definitions: ActionDefinition[] = [
    panel("panel-production", "Production panel", "btn-production", "production-panel",
      "breakdown tags props locations cast show hide toggle", openProductionPanel, closeProductionPanel),
    panel("panel-gear", "Gear panel", "btn-gear", "gear-panel",
      "gear equipment kit camera show hide toggle", openGearPanel, closeGearPanel),
    panel("panel-broll", "B-roll panel", "btn-broll", "broll-panel",
      "broll b roll shots cutaways show hide toggle", openBrollPanel, closeBrollPanel),
    panel("panel-comments", "Comments panel", "btn-comments", "comments-panel",
      "comments notes review feedback show hide toggle", openCommentsPanel, closeCommentsPanel),
    {
      id: "write",
      label: "Write",
      group: "View",
      icon: "i-pen",
      words: "writer narration word processor audio column",
      availability: () => {
        const screen = availableUnless(["loading"], screenNow());
        const allowed: Availability = screen.enabled && reviewMode() ? { enabled: false, reason: VIEWING_ONLY } : screen;
        return withButton("btn-write", allowed);
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
  const disposers = definitions.map((d) => registry.register(d));
  return () => { for (const dispose of disposers) dispose(); };
}
