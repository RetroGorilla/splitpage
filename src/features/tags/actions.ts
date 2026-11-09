import { openTagComposer } from "./production-tags.ts";
import type { Availability, ActionDefinition } from "../../application/actions.ts";
import type { ScreenState } from "../../application/screen.ts";
import { EVERY_OVERLAY, availableUnless, firstRefusal } from "../../application/screen.ts";
import type { SidePanels } from "../../application/side-panels.ts";
import type { PlainTagControl, TagCaretRefusal, TagPanelMount } from "./ports.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import { cleanMarks } from "../../core/text/runs.ts";

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

const CARET_REFUSAL_NOTICE: Readonly<Record<TagCaretRefusal, string>> = {
  audio: "Tags go in the Visual column. Put the cursor there, or select words to label.",
  link: "A tag can't start inside a link. Move the cursor outside the link first.",
  tag: "Select the tag and choose Edit tag first.",
  "tag-selection": "Select complete tags, or words within an opened tag.",
  open: "A tag is already open. Type its name and press Tab, or Esc to cancel.",
  elsewhere: "Select the words you want to label first."
};

export function tagComposerActions(current: () => PlainTagControl | null, notices: Pick<NoticePort, "show">): ActionDefinition[] {
  return [opener("tag-selection", "Tag selection", (input) => {
    if (typeof input === "object" && input !== null && "caret" in input) {
      if (!(input.caret instanceof HTMLElement)) throw new TypeError("tag-selection needs a caret cell");
      const marks = cleanMarks("marks" in input ? input.marks : {}, false);
      const owner = current();
      const refusal = owner ? owner.openCategoryAtCaret(input.caret, marks) : "elsewhere";
      if (refusal) notices.show(CARET_REFUSAL_NOTICE[refusal], "warn");
      return;
    }
    openTagComposer(fields("tag-selection", input, ["rowId", "field", "quotedText"], ["occurrenceIndex"]) as Parameters<typeof openTagComposer>[0]);
  })];
}
