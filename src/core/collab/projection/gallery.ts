import { MAX_MORE, videoLinkKey } from "../../document/gallery.ts";
import type { VideoLink } from "../../document/gallery.ts";
import { projectSharedGalleryFields, projectSharedGallerySlots } from "./fields.ts";

type GalleryBag = Readonly<Record<string, unknown>>;
export interface SharedProjectionGalleryOverflow {
  readonly itemId: string;
  readonly beat: string;
  readonly slot: GalleryBag;
}
function links(slot: GalleryBag): readonly VideoLink[] { return Array.isArray(slot.links) ? slot.links as VideoLink[] : []; }
function compareGallery(a: { readonly key: string; readonly fields: GalleryBag }, b: { readonly key: string; readonly fields: GalleryBag }): number {
  const first = typeof a.fields.rank === "string" ? a.fields.rank : "", second = typeof b.fields.rank === "string" ? b.fields.rank : "";
  return first < second ? -1 : first > second ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}
function fold(first: GalleryBag, later: GalleryBag): GalleryBag {
  const kept = new Map<string, VideoLink>();
  for (const link of [...links(first), ...links(later)]) {
    const key = videoLinkKey(link), previous = kept.get(key);
    if (!previous) kept.set(key, { ...link });
    else {
      if (link.poster && !previous.poster) previous.poster = true;
      if (link.location && !previous.location) previous.location = link.location;
    }
  }
  const slot = { ...first };
  if (!slot.name && later.name) slot.name = later.name;
  const annotation = slot.annotation as { readonly marks?: readonly unknown[] } | null | undefined;
  const candidate = later.annotation as { readonly marks?: readonly unknown[] } | null | undefined;
  if (!annotation?.marks?.length && candidate?.marks?.length) slot.annotation = later.annotation;
  if (kept.size) slot.links = [...kept.values()];
  return slot;
}
export function projectSharedGroupGallery(root: GalleryBag, members: readonly GalleryBag[],
  records: readonly { readonly key: string; readonly fields: GalleryBag }[]) {
  const ordered = members.flatMap(member => records.filter(record => record.fields.beat === member.id).sort(compareGallery).map(record => {
    const slot = projectSharedGallerySlots([record])[0];
    return { itemId: record.key, beat: String(member.id), slot: slot ?? {} };
  })).filter(entry => !Object.keys(entry.slot).every(key => key === "imageRef") || !!entry.slot.imageRef);
  const folded: SharedProjectionGalleryOverflow[] = [], pictures = new Map<string, number>();
  let changed = false;
  for (const entry of ordered) {
    const ref = entry.slot.imageRef as { readonly sha256?: string } | null | undefined;
    const at = ref?.sha256 ? pictures.get(ref.sha256) : undefined, first = at === undefined ? undefined : folded[at];
    if (first && at !== undefined) { folded[at] = { ...first, slot: fold(first.slot, entry.slot) }; changed = true; }
    else { if (ref?.sha256) pictures.set(ref.sha256, folded.length); folded.push(entry); }
  }
  const overflow = folded.slice(MAX_MORE + 1);
  if (members.length === 1 && !changed && !overflow.length) return { row: { ...root }, overflow };
  const row = { ...root };
  delete row.imageRef; delete row.imageName; delete row.imageAnnotation; delete row.imageLinks; delete row.moreImages;
  if (Object.hasOwn(root, "imageRef")) row.imageRef = null;
  return { row: projectSharedGalleryFields(row, folded.slice(0, MAX_MORE + 1).map(entry => entry.slot)), overflow };
}
