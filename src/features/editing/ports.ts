import type { TextServices } from "../../application/text/services.ts";

export interface DraftEditPorts {
  readonly text: Pick<TextServices<HTMLElement>, "fromHtml" | "inertBody" | "sanitizeHtml" | "storedHtmlFromDom">;
}
