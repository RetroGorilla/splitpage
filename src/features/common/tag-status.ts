import { tagStatus } from "../../core/production/looks.ts";

export function tagStatusLampHtml(id: string): string {
  const st = tagStatus(id) || tagStatus("needed");
  if (!st) throw new Error("Missing default tag status");
  if (st.id === "returned") {
    return '<svg class="item-lamp is-returned" aria-hidden="true" focusable="false"><use href="#i-return"/></svg>';
  }
  return '<span class="item-lamp is-' + st.id + '" aria-hidden="true"></span>';
}
