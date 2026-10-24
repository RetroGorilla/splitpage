import type { ActionDefinition } from "../../application/actions.ts";
import type { GalleryControls } from "./ports.ts";

export function galleryActions(current: () => GalleryControls | null): ActionDefinition[] {
  return [{
    id: "annotate-picture",
    label: "Draw on picture",
    group: "Open",
    availability: () => ({ enabled: current() !== null, visible: false }),
    run: (_source, input) => {
      if (typeof input !== "object" || input === null) throw new TypeError("annotate-picture needs what to open");
      const at = input as Readonly<Record<string, unknown>>;
      const rowId = at["rowId"];
      const slot = at["slot"];
      if (typeof rowId !== "string") throw new TypeError("annotate-picture needs rowId as text");
      if (typeof slot !== "number") throw new TypeError("annotate-picture needs slot as a number");
      current()?.openAnnotator(rowId, slot);
    }
  }];
}
