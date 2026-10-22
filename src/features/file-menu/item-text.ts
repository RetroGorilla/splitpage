import type { MenuItemPort } from "../../application/effects/ports.ts";

export function createMenuItemText(): MenuItemPort<Element> {
  return {
    setLabel(item, text) {
      const label = item && item.querySelector(".mi-label");
      if (label) label.textContent = text;
      else if (item) item.textContent = text;
    },
    setReason(item, reason) {
      const why = item && (item.querySelector(".mi-why") as HTMLElement | null);
      if (!why) return;
      why.textContent = reason || "";
      why.hidden = !reason;
    }
  };
}
