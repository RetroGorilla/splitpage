import type { Slot, VideoLink } from "../../core/document/gallery.ts";

export function slotPoster(slot: Pick<Slot, "links">): VideoLink | null {
  return slot.links.filter(function (l) { return l.poster; })[0] || null;
}
