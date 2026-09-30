import type { Availability } from "../application/actions.ts";

export function menuItemAvailability(action: string): Availability | null {
  const item = document.querySelector(`#file-menu [data-file-action="${action}"]`);
  if (!(item instanceof HTMLButtonElement)) return null;
  if (item.hidden) return { enabled: false, visible: false };
  if (!item.disabled) return null;
  const why = item.querySelector(".mi-why");
  const reason = why instanceof HTMLElement && !why.hidden ? why.textContent ?? "" : "";
  return { enabled: false, reason: reason || item.title || "" };
}
