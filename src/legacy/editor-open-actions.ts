import type { ActionDefinition, ActionRegistry, Availability } from "../application/actions.ts";
import { registerAll } from "../application/actions.ts";
import { goToScene } from "../js/05f-rundown.js";
import { openAnnotator } from "../js/05w-annotate.js";
import { openGalleryLink } from "../js/06-rows.js";
import { openTagComposer } from "../js/07-production-tags.js";

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

export function registerEditorOpenActions(registry: ActionRegistry, section: "before-comment" | "after-comment" | "all" = "all"): () => void {
  const definitions = [
    opener("go-to-scene", "Go to scene", (input) => {
      if (input !== null && typeof input !== "string") throw new TypeError("go-to-scene needs a scene id");
      goToScene(input);
    }),
    opener("annotate-picture", "Draw on picture", (input) => {
      const at = fields("annotate-picture", input, ["rowId"], ["slot"]);
      openAnnotator(at["rowId"], at["slot"]);
    }),
    opener("open-picture-link", "Open picture link", (input) => {
      const at = fields("open-picture-link", input, ["rowId"], ["slot"]);
      openGalleryLink(at["rowId"], at["slot"], at["key"]);
    }),
    opener("tag-selection", "Tag selection", (input) => {
      openTagComposer(fields("tag-selection", input, ["rowId", "field", "quotedText"], ["occurrenceIndex"]));
    })
  ];
  return registerAll(registry, section === "before-comment" ? definitions.slice(0, 3) : section === "after-comment" ? definitions.slice(3) : definitions);
}
