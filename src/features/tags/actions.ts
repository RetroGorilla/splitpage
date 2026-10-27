import { openTagComposer } from "./production-tags.js";
import type { Availability, ActionDefinition } from "../../application/actions.ts";
import type { ScreenState } from "../../application/screen.ts";
import { EVERY_OVERLAY, availableUnless, firstRefusal } from "../../application/screen.ts";
import type { SidePanels } from "../../application/side-panels.ts";
import type { TagPanelMount } from "./ports.ts";

export function tagPanelActions(current: () => TagPanelMount | null, screen: () => ScreenState, panels: Pick<SidePanels, "close">): ActionDefinition[] {
  function panel(id: string, label: string, buttonId: string, panelId: string, words: string, open: (owner: TagPanelMount) => void): ActionDefinition {
    return {
      id,
      label,
      group: "View",
      icon: "i-panel",
      words,
      availability: () => {
        if (!current()) return { enabled: false };
        const button = document.getElementById(buttonId);
        const availability = firstRefusal(availableUnless(["loading"], screen()), availableUnless(EVERY_OVERLAY, screen()));
        return button !== null && !button.hidden ? availability : { ...availability, visible: false };
      },
      run: () => {
        const owner = current();
        if (!owner) return;
        const target = document.getElementById(panelId);
        if (target !== null && !target.hidden) panels.close(panelId);
        else open(owner);
      }
    };
  }
  return [
    panel("panel-production", "Production panel", "btn-production", "production-panel",
      "breakdown tags props locations cast show hide toggle", (owner) => { owner.openProductionPanel(); }),
    panel("panel-gear", "Gear panel", "btn-gear", "gear-panel",
      "gear equipment kit camera show hide toggle", (owner) => { owner.openGearPanel(); })
  ];
}

const OPENED_FROM_ITS_VIEW: Availability = { enabled: true, visible: false };

type Fields = Readonly<Record<string, unknown>>;

function fields(id: string, input: unknown, strings: readonly string[], numbers: readonly string[] = []): Fields {
  if (typeof input !== "object" || input === null) throw new TypeError(`${id} needs what to open`);
  const record = input as Fields;
  for (const key of strings) {
    if (typeof record[key] !== "string") throw new TypeError(`${id} needs ${key} as text`);
  }
  for (const key of numbers) {
    if (typeof record[key] !== "number") throw new TypeError(`${id} needs ${key} as a number`);
  }
  return record;
}

function opener(id: string, label: string, run: (input: unknown) => void): ActionDefinition {
  return {
    id,
    label,
    group: "Open",
    availability: () => OPENED_FROM_ITS_VIEW,
    run: (_source, input) => { run(input); }
  };
}

export function tagComposerActions(): ActionDefinition[] {
  return [opener("tag-selection", "Tag selection", (input) => {
    openTagComposer(fields("tag-selection", input, ["rowId", "field", "quotedText"], ["occurrenceIndex"]));
  })];
}
