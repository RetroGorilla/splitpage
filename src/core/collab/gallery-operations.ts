import type { SharedContentRef, SharedJsonFields, SharedJsonValue, SharedOperation } from "./operations.ts";
import { projectSharedGalleryFields, projectSharedGallerySlots, sharedProjectionExtra } from "./projection/fields.ts";
import { projectSharedGroupGallery } from "./projection/gallery.ts";
import { videoLinkKey } from "../document/gallery.ts";
import type { VideoLink } from "../document/gallery.ts";

type Bag = Readonly<Record<string, unknown>>;

export interface SharedPictureRecord { readonly key: string; readonly fields: Bag }
export interface SharedGalleryEdit {
  readonly beat: string;
  readonly before: Bag;
  readonly after: Bag;
  readonly records: readonly SharedPictureRecord[];
  readonly author: { readonly id: string; readonly by: string };
}
export type SharedGalleryOperations = { readonly operations: readonly SharedOperation[] } | { readonly refused: string };

function pictureFields(): readonly string[] { return ["imageRef", "name", "annotation"]; }

function bag(value: unknown): Bag {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Bag : {};
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, (item as Bag)[key]])) : item);
}
function galleryOf(row: Bag): string {
  return canonical({ imageRef: row.imageRef ?? null, imageName: row.imageName, imageAnnotation: row.imageAnnotation, imageLinks: row.imageLinks, moreImages: row.moreImages });
}
function slotsOf(row: Bag): Bag[] {
  const more = Array.isArray(row.moreImages) ? row.moreImages.map(bag) : [], links = Array.isArray(row.imageLinks) ? row.imageLinks as unknown[] : [];
  if (!row.imageRef && !links.length && !more.length) return [];
  const head: Record<string, unknown> = {};
  if (row.imageRef) head.imageRef = row.imageRef;
  if (row.imageName !== undefined) head.name = row.imageName;
  if (row.imageAnnotation !== undefined) head.annotation = row.imageAnnotation;
  if (links.length) head.links = links;
  return [head, ...more];
}
function linksOf(slot: Bag): Bag[] { return Array.isArray(slot.links) ? slot.links.map(bag) : []; }
function identity(slot: Bag): string {
  const sha = bag(slot.imageRef).sha256;
  if (typeof sha === "string") return "i:" + sha;
  const poster = linksOf(slot).find(link => link.poster === true);
  return poster ? "v:" + videoLinkKey(poster as VideoLink) : "";
}
// why: the projection drops a slot that holds no picture and no link, as hydration leaves one in every beat without pictures.
function placeholder(slot: Bag): boolean { return Object.keys(slot).every(key => key === "imageRef") && !slot.imageRef; }
function contentReference(value: unknown): boolean { return typeof bag(value).sha256 === "string" && /^[0-9a-f]{64}$/.test(bag(value).sha256 as string); }

export function sharedRankBetween(low: string, high: string | null): string | null {
  let out = "", bound = high;
  for (let index = 0; ; index++) {
    const below = index < low.length ? low.charCodeAt(index) - 48 : 0;
    const above = bound === null ? 10 : index < bound.length ? bound.charCodeAt(index) - 48 : -1;
    if (above < below) return null;
    if (above - below > 1) return out + String(Math.floor((below + above) / 2));
    if (above - below === 1) bound = null;
    out += String(below);
  }
}

function ranked(order: readonly (string | null)[], keys: readonly string[], ties: boolean): (string | null)[] | null {
  const before = (a: number, b: number) => {
    const first = order[a] as string, second = order[b] as string;
    return first < second || ties && first === second && (keys[a] as string) < (keys[b] as string);
  };
  const length: number[] = [], previous: number[] = [];
  order.forEach((rank, index) => {
    length[index] = rank === null ? 0 : 1; previous[index] = -1;
    if (rank === null) return;
    for (let earlier = 0; earlier < index; earlier++) if (order[earlier] !== null && before(earlier, index) && (length[earlier] as number) + 1 > (length[index] as number)) {
      length[index] = (length[earlier] as number) + 1; previous[index] = earlier;
    }
  });
  const kept = new Set<number>();
  let at = length.reduce((best, value, index) => value > (length[best] ?? 0) ? index : best, -1);
  while (at !== -1 && (length[at] ?? 0) > 0) { kept.add(at); at = previous[at] as number; }
  const out: (string | null)[] = [];
  for (let index = 0; index < order.length; index++) {
    if (kept.has(index)) { out.push(order[index] as string); continue; }
    let next = index + 1;
    while (next < order.length && !kept.has(next)) next++;
    const low = index ? out[index - 1] as string : "", high = next < order.length ? order[next] as string : null;
    const rank = high !== null && low === high ? null : sharedRankBetween(low, high);
    if (rank === null) return null;
    out.push(rank);
  }
  return out;
}

function picture(slot: Bag): SharedJsonFields {
  return JSON.parse(JSON.stringify(Object.fromEntries(pictureFields().filter(key => slot[key] !== undefined).map(key => [key, slot[key]])))) as SharedJsonFields;
}
function storedLinks(record: SharedPictureRecord): Bag[] {
  return (Array.isArray(record.fields.links) ? record.fields.links : []).map(entry => {
    const { rank: _rank, extra: _extra, ...fields } = bag(bag(entry).fields);
    return fields;
  });
}
function extraOf(slot: Bag): Bag {
  return Object.fromEntries(Object.keys(slot).filter(key => !pictureFields().includes(key) && key !== "links").sort().map(key => [key, slot[key]]));
}
// why: the first picture's missing image shows as the row's empty imageRef either way; later ones show the key as stored.
function shownPicture(value: Bag): string {
  const { imageRef, ...rest } = value;
  return canonical(imageRef === null || imageRef === undefined ? rest : value);
}

export function sharedGalleryOperations(edit: SharedGalleryEdit): SharedGalleryOperations {
  const after = slotsOf(edit.after);
  if (edit.after.visualImage || after.some(slot => slot.imageRef !== undefined && !contentReference(slot.imageRef)
    || slot.annotation !== undefined && !contentReference(bag(slot.annotation).imageRef))) return { refused: "gallery-embedded-image" };
  if (after.some(slot => linksOf(slot).some(link => link.location !== undefined))) return { refused: "gallery-local-file" };
  const shown = edit.records.filter(record => !placeholder(projectSharedGallerySlots([record])[0] ?? {})), before = slotsOf(edit.before);
  const grouped = projectSharedGroupGallery(projectSharedGalleryFields({}, projectSharedGallerySlots(shown)), [{ id: edit.beat }], shown);
  if (grouped.overflow.length) return { refused: "gallery-overflow" };
  // why: the projection shows a picture held twice once, from its first record, so the others go when the gallery is edited.
  const seen = new Set<string>(), records = shown.filter(record => {
    const sha = bag(bag(record.fields.picture).imageRef).sha256;
    if (typeof sha !== "string") return true;
    if (seen.has(sha)) return false;
    seen.add(sha); return true;
  });
  if (galleryOf(grouped.row) !== galleryOf(edit.before) || before.length !== records.length) return { refused: "gallery-joined-beat" };
  const owner: (number | null)[] = after.map(() => null), used = new Set<number>();
  after.forEach((slot, index) => {
    const key = identity(slot), found = key ? before.findIndex((old, at) => !used.has(at) && identity(old) === key) : -1;
    if (found !== -1) { owner[index] = found; used.add(found); }
  });
  after.forEach((_slot, index) => { if (owner[index] === null && index < before.length && !used.has(index)) { owner[index] = index; used.add(index); } });
  const keys = after.map((_slot, index) => { const at = owner[index] ?? null; return at === null ? edit.author.id + "_picture_" + index : (records[at] as SharedPictureRecord).key; });
  const stored = after.map((_slot, index) => { const at = owner[index] ?? null; return at === null ? null : String((records[at] as SharedPictureRecord).fields.rank ?? ""); });
  const ranks = ranked(stored, keys, true) ?? ranked(stored, keys, false);
  if (!ranks) return { refused: "gallery-order-unavailable" };
  const operations: SharedOperation[] = [], author = edit.author;
  const id = () => (author.id + ":" + operations.length) as SharedContentRef, beat = edit.beat as SharedContentRef;
  const set = (record: string, field: string, value: SharedJsonValue) => operations.push({ kind: "record-set", id: id(), by: author.by,
    target: { collection: "gallery", record: record as SharedContentRef }, field, value });
  after.forEach((slot, index) => {
    const at = owner[index] ?? null, rank = ranks[index] as string, links = JSON.parse(JSON.stringify(linksOf(slot))) as SharedJsonValue;
    if (at === null) {
      operations.push({ kind: "record-create", id: id(), by: author.by, target: { collection: "gallery", record: keys[index] as SharedContentRef },
        fields: { beat, rank, picture: picture(slot), links, extra: JSON.stringify(extraOf(slot)) } });
      return;
    }
    const record = records[at] as SharedPictureRecord;
    if (rank !== record.fields.rank) set(record.key, "rank", rank);
    const shown = index ? canonical : shownPicture;
    if (shown(picture(slot)) !== shown(bag(record.fields.picture))) set(record.key, "picture", picture(slot));
    if (canonical(linksOf(slot)) !== canonical(storedLinks(record))) set(record.key, "links", links);
    if (canonical(extraOf(slot)) !== canonical(sharedProjectionExtra(record.fields))) set(record.key, "extra", JSON.stringify(extraOf(slot)));
  });
  const kept = new Set(records.filter((_record, at) => used.has(at)).map(record => record.key));
  shown.forEach(record => {
    if (!kept.has(record.key)) operations.push({ kind: "record-delete", id: id(), by: author.by, target: { collection: "gallery", record: record.key as SharedContentRef } });
  });
  // why: a hydrated beat shows its empty imageRef from a gallery record, so removing its last one leaves an empty one.
  if (!after.length && edit.records.every(record => !kept.has(record.key) && shown.includes(record))) {
    operations.push({ kind: "record-create", id: id(), by: author.by, target: { collection: "gallery", record: (author.id + "_picture_empty") as SharedContentRef },
      fields: { beat, rank: "0", picture: { imageRef: null }, links: [], extra: "{}" } });
  }
  return { operations };
}
