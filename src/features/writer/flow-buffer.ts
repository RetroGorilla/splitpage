import { createBufferedField } from "../../application/editing/buffered-field.ts";
import type { BufferedFieldBinding, BufferedFieldPorts, BufferedFieldSurface } from "../../application/editing/buffered-field.ts";
import { bufferedFieldTarget, headingFieldKey } from "../../application/editing/buffered-field-key.ts";
import { beatPos, headingPos } from "../../core/flow/flow.ts";

export function createWriterBuffer(ports: BufferedFieldPorts,
  surface: Omit<BufferedFieldSurface<HTMLElement>, "fields" | "field" | "rowId" | "key" | "position"> & { readonly root: HTMLElement }): BufferedFieldBinding {
  const root = surface.root;
  return createBufferedField(ports, {
    ...surface,
    fields: () => root.querySelectorAll<HTMLElement>(".wr-beat, .wr-heading"),
    field: key => {
      const target = bufferedFieldTarget(key);
      return target?.field === "heading" ? root.querySelector<HTMLElement>('.wr-heading[data-scene="' + CSS.escape(target.owner) + '"]')
        : target?.field === "audioText" ? root.querySelector<HTMLElement>('.wr-beat[data-id="' + CSS.escape(target.owner) + '"]') : null;
    },
    rowId: field => field.classList.contains("wr-heading") ? headingFieldKey(field.dataset.scene ?? "") : field.dataset.id ?? "",
    key: pos => pos.kind === "beat" ? pos.rowId : headingFieldKey(pos.sceneId),
    position: (key, offset) => {
      const target = bufferedFieldTarget(key);
      return target?.field === "heading" ? headingPos(target.owner, offset) : beatPos(key, offset);
    }
  });
}
