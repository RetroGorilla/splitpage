import type { Availability } from "../application/actions.ts";

export function menuItemAvailability(action: string): Availability | null {
  const item = document.querySelector(`#file-menu [data-file-action="${action}"]`);
  if (!(item instanceof HTMLButtonElement)) return null;
  const visible = !item.hidden;
  if (!item.disabled) return visible ? null : { enabled: true, visible };
  const why = item.querySelector(".mi-why");
  const reason = why instanceof HTMLElement && !why.hidden ? why.textContent ?? "" : "";
  return { enabled: false, visible, reason: reason || item.title || "" };
}

export function menuItemLabel(action: string, fallback: string): string {
  const item = document.querySelector(`#file-menu [data-file-action="${action}"]`);
  const label = item?.querySelector(".mi-label") ?? item;
  const text = label?.textContent?.trim() ?? "";
  return text || fallback;
}
