import { escapeHtml } from "../../core/document/text-policy.ts";

export function numberHtml(number: string): string {
  return escapeHtml(number).replaceAll(".", '<span class="number-dot">.</span>');
}
