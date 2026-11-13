import { createBufferedField } from "../../application/editing/buffered-field.ts";
import type { BufferedFieldBinding, BufferedFieldPorts, BufferedFieldSurface } from "../../application/editing/buffered-field.ts";

export function createWriterBuffer(ports: BufferedFieldPorts,
  surface: Omit<BufferedFieldSurface<HTMLElement>, "fields" | "field" | "rowId"> & { readonly root: HTMLElement }): BufferedFieldBinding {
  const root = surface.root;
  return createBufferedField(ports, {
    ...surface,
    fields: () => root.querySelectorAll<HTMLElement>(".wr-beat"),
    field: rowId => root.querySelector<HTMLElement>('.wr-beat[data-id="' + CSS.escape(rowId) + '"]'),
    rowId: beat => beat.dataset.id ?? ""
  });
}
