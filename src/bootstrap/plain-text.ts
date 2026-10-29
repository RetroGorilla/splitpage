import { inertBody } from "./richtext.ts";

export function htmlToPlainText(html: unknown): string {
  if (!html) return "";
  const c = inertBody(String(html).replace(/<br\s*\/?>/gi, "\n"));
  return (c.textContent || "").replace(/\u00A0/g, " ").trim();
}
