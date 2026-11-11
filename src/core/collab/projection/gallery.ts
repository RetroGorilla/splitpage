import { MAX_MORE, readAnnotation, videoLinkKey } from "../../document/gallery.ts";
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
function foldLinks(kept: Map<string, VideoLink>, slot: GalleryBag): void {
  for (const link of links(slot)) {
    const key = videoLinkKey(link), previous = kept.get(key);
    if (!previous) kept.set(key, { ...link });
    else {
      if (link.poster && !previous.poster) previous.poster = true;
      if (link.location && !previous.location) previous.location = link.location;
    }
  }
}
export function projectSharedGroupGallery(root: GalleryBag, members: readonly GalleryBag[],
  records: readonly { readonly key: string; readonly fields: GalleryBag }[]) {
  const entries = members.flatMap(member => records.filter(record => record.fields.beat === member.id).sort(compareGallery).map(record => {
    const slot = projectSharedGallerySlots([record])[0];
    return { itemId: record.key, beat: String(member.id), slot: slot ?? {} };
  }));
  const ordered = entries.filter(entry => !Object.keys(entry.slot).every(key => key === "imageRef") || !!entry.slot.imageRef);
  const accumulators: { itemId: string; beat: string; slot: Record<string, unknown>; links: Map<string, VideoLink> }[] = [];
  const pictures = new Map<string, number>();
  let changed = entries.length !== ordered.length;
  for (const entry of ordered) {
    const slot = { ...entry.slot };
    if (Object.hasOwn(slot, "annotation") && !readAnnotation(slot.annotation)) { delete slot.annotation; changed = true; }
    const ref = entry.slot.imageRef as { readonly sha256?: string } | null | undefined;
    const at = ref?.sha256 ? pictures.get(ref.sha256) : undefined, first = at === undefined ? undefined : accumulators[at];
    if (first && at !== undefined) {
      if (!first.slot.name && slot.name) first.slot.name = slot.name;
      if (!first.slot.annotation && slot.annotation) first.slot.annotation = slot.annotation;
      foldLinks(first.links, slot); changed = true;
    } else {
      if (ref?.sha256) pictures.set(ref.sha256, accumulators.length);
      const kept = new Map<string, VideoLink>(); foldLinks(kept, slot);
      accumulators.push({ ...entry, slot, links: kept });
    }
  }
  const folded: SharedProjectionGalleryOverflow[] = accumulators.map(entry => ({ itemId: entry.itemId, beat: entry.beat,
    slot: entry.links.size ? { ...entry.slot, links: [...entry.links.values()] } : entry.slot }));
  const overflow = folded.slice(MAX_MORE + 1);
  if (members.length === 1 && !changed && !overflow.length) return { row: { ...root }, overflow };
  const row = { ...root };
  delete row.imageRef; delete row.imageName; delete row.imageAnnotation; delete row.imageLinks; delete row.moreImages;
  if (Object.hasOwn(root, "imageRef")) row.imageRef = null;
  return { row: projectSharedGalleryFields(row, folded.slice(0, MAX_MORE + 1).map(entry => entry.slot)), overflow };
}
