import type { ActionDefinition, Availability } from "../application/actions.ts";
import type { VideoFiles } from "../application/media/video-files.ts";

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

export function editorOpenActions(openGalleryLink: VideoFiles["openGallery"]): ActionDefinition[] {
  return [
    opener("open-picture-link", "Open picture link", (input) => {
      const at = fields("open-picture-link", input, ["rowId"], ["slot"]);
      openGalleryLink(at["rowId"] as string, at["slot"] as number, at["key"]);
    })
  ];
}
