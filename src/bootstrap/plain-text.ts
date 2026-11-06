import { toHtml } from "../core/text/html.ts";
import { withoutWho } from "../core/text/who.ts";
import { inertBody, scriptCellOf } from "./richtext.ts";

export function htmlToPlainText(html: unknown): string {
  if (!html) return "";
  const text = String(html);
  const shown = text.indexOf("who-anchor") === -1 ? text : toHtml(withoutWho(scriptCellOf(text)));
  const c = inertBody(shown.replace(/<br\s*\/?>/gi, "\n"));
  return (c.textContent || "").replace(/\xA0/g, " ").trim();
}
