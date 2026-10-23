import { normalizeImageRef } from "../../../shared/blob-policy.js";
import { rowImage } from "./media.ts";
import type { ImageRef, ImageSource } from "./ports.ts";
import { cappedLongText, codePointPrefix, plainText, safeHref, safeImageSrc, settledNames, unitSafePrefix } from "./text-policy.ts";

export interface VideoLink {
  href?: string;
  name?: string;
  size?: number;
  duration?: number;
  poster?: boolean;
}

export interface PenMark {
  kind: "pen" | "highlight";
  color: string;
  width: number;
  points: number[];
}

export interface TextMark {
  kind: "text";
  color: string;
  size: number;
  x: number;
  y: number;
  text: string;
}

export type Mark = PenMark | TextMark;

export interface Annotation {
  imageRef: ImageRef;
  marks: unknown[];
}

export interface GalleryItem {
  imageRef?: ImageRef;
  name?: string;
  links?: VideoLink[];
  annotation?: Annotation;
}

export interface Slot {
  ref: ImageRef | null;
  dataUrl?: string | null | undefined;
  links: VideoLink[];
  name: string;
  annotation?: Annotation | null | undefined;
}

export interface GalleryRow {
  visualImage?: unknown;
  imageRef?: unknown;
  imageName?: unknown;
  imageLinks?: unknown;
  imageAnnotation?: unknown;
  moreImages?: unknown;
  [key: string]: unknown;
}

interface MarkInput {
  kind?: unknown;
  color?: unknown;
  width?: unknown;
  points?: unknown;
  size?: unknown;
  x?: unknown;
  y?: unknown;
  text?: unknown;
}

interface AnnotationInput {
  visualImage?: unknown;
  imageRef?: unknown;
  marks?: unknown;
}

interface VideoLinkInput {
  href?: unknown;
  name?: unknown;
  size?: unknown;
  duration?: unknown;
  poster?: unknown;
}

interface GalleryItemInput {
  visualImage?: unknown;
  imageRef?: unknown;
  name?: unknown;
  links?: unknown;
  annotation?: unknown;
}

export type GalleryField = "imageLinks" | "moreImages";

const MAX_LINKS = 20;
const MAX_MORE = 60;
const MAX_MARKS = 500;
const MAX_POINTS = 2000;
const MAX_TEXT = 500;

export const ANNOTATION_COLORS: readonly string[] = ["#e5383b", "#ffb703", "#2a9d8f", "#3a86ff", "#111111", "#ffffff"];

function fraction(v: unknown, lo: number, hi: number): number | null {
  if (typeof v !== "number" || !isFinite(v)) return null;
  return Math.round(Math.min(hi, Math.max(lo, v)) * 10000) / 10000;
}

function normalizeMark(input: unknown): Mark | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const m = input as MarkInput;
  const color = typeof m.color === "string" ? m.color.toLowerCase() : "";
  if (ANNOTATION_COLORS.indexOf(color) === -1) return null;
  if (m.kind === "pen" || m.kind === "highlight") {
    const width = fraction(m.width, 0.001, 0.2);
    if (width === null || !Array.isArray(m.points) || m.points.length < 2) return null;
    const points = m.points as unknown[];
    const pts: number[] = [];
    for (let i = 0; i + 1 < points.length && pts.length < MAX_POINTS * 2; i += 2) {
      const x = fraction(points[i], 0, 1), y = fraction(points[i + 1], 0, 1);
      if (x === null || y === null) return null;
      pts.push(x, y);
    }
    return { kind: m.kind, color: color, width: width, points: pts };
  }
  if (m.kind === "text") {
    const size = fraction(m.size, 0.01, 0.3);
    const tx = fraction(m.x, 0, 1), ty = fraction(m.y, 0, 1);
    if (size === null || tx === null || ty === null || typeof m.text !== "string") return null;
    const raw = m.text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000B-\u001F\u007F]+/g, " ");
    const cut = cappedLongText(raw, MAX_TEXT);
    const text = cut.trim() ? cut : codePointPrefix(raw, MAX_TEXT);
    if (!text.trim()) return null;
    return { kind: "text", color: color, size: size, x: tx, y: ty, text: text };
  }
  return null;
}

export function normalizeMarks(list: unknown): Mark[] {
  const out: Mark[] = [];
  (Array.isArray(list) ? list as unknown[] : []).forEach(function (m) {
    if (out.length >= MAX_MARKS) return;
    const n = normalizeMark(m);
    if (n) out.push(n);
  });
  return out;
}

function normalizeAnnotation(input: unknown, flat: ImageRef | null | undefined, images: ImageSource): { imageRef: ImageRef; marks: Mark[] } | null {
  if (!input || typeof input !== "object" || Array.isArray(input) || !flat) return null;
  const a = input as AnnotationInput;
  const legacy = safeImageSrc(a.visualImage);
  const rec = legacy ? images.fromDataUrl(legacy) : null;
  const ref: ImageRef | null = rec || normalizeImageRef(a.imageRef);
  if (!ref || ref.sha256 === flat.sha256) return null;
  const marks = normalizeMarks(a.marks);
  return marks.length ? { imageRef: ref, marks: marks } : null;
}

export function slotOriginal(slot: Slot | null | undefined): ImageRef | null {
  return slot && slot.annotation ? slot.annotation.imageRef : (slot ? slot.ref : null);
}

export function normalizeVideoLink(input: unknown): VideoLink | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const x = input as VideoLinkInput;
  let out: VideoLink;
  if (typeof x.href === "string") {
    const href = safeHref(x.href);
    if (!href || !/^https?:\/\//i.test(href) || href.length > 2048) return null;
    out = { href: href };
  } else if (typeof x.name === "string") {
    const name = normalizePictureName(x.name);
    if (!name) return null;
    out = { name: name };
    if (typeof x.size === "number" && isFinite(x.size) && x.size >= 0) out.size = Math.floor(x.size);
  } else {
    return null;
  }
  if (typeof x.duration === "number" && isFinite(x.duration) && x.duration > 0 && x.duration < 1e7) {
    out.duration = Math.round(x.duration * 10) / 10;
  }
  if (x.poster === true) out.poster = true;
  return out;
}

export function normalizePictureName(v: unknown): string {
  if (typeof v !== "string") return "";
  return settledNames([plainText(v).replace(/[\u0000-\u001F]+/g, " ")], 200, String)[0] as string;
}

export function videoLinkKey(l: VideoLink | null | undefined): string {
  if (!l) return "";
  return l.href ? "u:" + l.href : "f:" + l.name + ":" + (l.size || 0);
}

export function videoLinkLabel(l: VideoLink | null | undefined): string {
  if (!l) return "";
  if (!l.href) return l.name as string;
  const s = String(l.href).replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
  return s.length > 48 ? unitSafePrefix(s, 45) + "…" : s;
}

export function normalizeVideoLinks(list: unknown): VideoLink[] {
  const out: VideoLink[] = [], seen: Record<string, boolean> = {};
  let poster = false;
  (Array.isArray(list) ? list as unknown[] : []).forEach(function (x) {
    const l = normalizeVideoLink(x);
    if (!l || out.length >= MAX_LINKS) return;
    const k = videoLinkKey(l);
    if (seen[k]) return;
    seen[k] = true;
    if (l.poster) { if (poster) delete l.poster; poster = true; }
    out.push(l);
  });
  return out;
}

function normalizeGalleryItem(input: unknown, images: ImageSource): GalleryItem | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const it = input as GalleryItemInput;
  const legacy = safeImageSrc(it.visualImage);
  const rec = legacy ? images.fromDataUrl(legacy) : null;
  const ref: ImageRef | null = rec || normalizeImageRef(it.imageRef);
  const links = normalizeVideoLinks(it.links);
  if (!ref && !links.some(function (l) { return l.poster; })) return null;
  const out: GalleryItem = {};
  if (ref) out.imageRef = ref;
  const name = ref ? normalizePictureName(it.name) : "";
  if (name) out.name = name;
  if (links.length) out.links = links;
  const ann = normalizeAnnotation(it.annotation, ref, images);
  if (ann) out.annotation = ann;
  return out;
}

interface KeyedItem {
  imageRef?: unknown;
  links?: unknown;
}

function itemKey(it: KeyedItem | null | undefined): string {
  if (!it) return "";
  const ref = it.imageRef as { sha256?: unknown } | null | undefined;
  if (ref && ref.sha256) return ref.sha256 as string;
  const poster = (Array.isArray(it.links) ? it.links as (VideoLink | null | undefined)[] : []).filter(function (l) { return l && l.poster; })[0];
  return poster ? "v:" + videoLinkKey(poster) : "";
}

export function migrateGallery(r: GalleryRow, images: ImageSource): void {
  const imageName = r.imageRef ? normalizePictureName(r.imageName) : "";
  if (imageName) r.imageName = imageName; else delete r.imageName;
  const links = normalizeVideoLinks(r.imageLinks);
  if (links.length) r.imageLinks = links; else delete r.imageLinks;
  const ann = normalizeAnnotation(r.imageAnnotation, normalizeImageRef(r.imageRef), images);
  if (ann) r.imageAnnotation = ann; else delete r.imageAnnotation;
  const seen: Record<string, boolean> = {};
  const firstKey = itemKey({ imageRef: r.imageRef, links: r.imageLinks });
  if (firstKey) seen[firstKey] = true;
  const more: GalleryItem[] = [];
  (Array.isArray(r.moreImages) ? r.moreImages as unknown[] : []).forEach(function (x) {
    const it = normalizeGalleryItem(x, images);
    if (!it || seen[itemKey(it)] || more.length >= MAX_MORE) return;
    seen[itemKey(it)] = true;
    more.push(it);
  });
  if (!r.imageRef && !r.imageLinks && more.length) {
    const first = more.shift() as GalleryItem;
    r.imageRef = first.imageRef || null;
    if (first.name) r.imageName = first.name;
    if (first.links) r.imageLinks = first.links;
    if (first.annotation) r.imageAnnotation = first.annotation;
  }
  if (more.length) r.moreImages = more; else delete r.moreImages;
}

export function rowSlots(row: unknown): Slot[] {
  const out: Slot[] = [];
  if (!row || typeof row !== "object") return out;
  const r = row as GalleryRow;
  const img = rowImage(r);
  const links = Array.isArray(r.imageLinks) ? r.imageLinks as VideoLink[] : [];
  if (img || links.length) {
    out.push({ ref: img ? img.ref : null, dataUrl: img ? img.dataUrl : null, links: links,
               name: img && typeof r.imageName === "string" ? r.imageName : "",
               annotation: img && img.ref ? readAnnotation(r.imageAnnotation) : null });
  }
  (Array.isArray(r.moreImages) ? r.moreImages as unknown[] : []).forEach(function (entry) {
    if (!entry || typeof entry !== "object") return;
    const it = entry as GalleryItemInput;
    const ref: ImageRef | null = normalizeImageRef(it.imageRef);
    const itLinks = Array.isArray(it.links) ? it.links as VideoLink[] : [];
    if (!ref && !itLinks.some(function (l) { return l && l.poster; })) return;
    out.push({ ref: ref, dataUrl: null, links: itLinks, name: ref && typeof it.name === "string" ? it.name : "",
               annotation: ref ? readAnnotation(it.annotation) : null });
  });
  return out;
}

function readAnnotation(input: unknown): Annotation | null {
  if (!input || typeof input !== "object") return null;
  const a = input as AnnotationInput;
  const ref: ImageRef | null = normalizeImageRef(a.imageRef);
  return ref && Array.isArray(a.marks) && a.marks.length ? { imageRef: ref, marks: a.marks as unknown[] } : null;
}

function isVideoSlot(s: Slot): boolean {
  return s.links.some(function (l) { return l.poster; });
}

export function gallerySize(row: unknown): number {
  return rowSlots(row).length;
}

export function morePictureRefs(row: unknown): ImageRef[] {
  return rowSlots(row).slice(1).map(function (s) { return s.ref; }).filter(Boolean) as ImageRef[];
}

export function rowVideoLinks(row: unknown): VideoLink[] {
  let out: VideoLink[] = [];
  rowSlots(row).forEach(function (s) { out = out.concat(s.links); });
  return out;
}

function copy<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

export function setRowSlots(row: GalleryRow, slots: readonly (Slot | null | undefined)[]): void {
  delete row.visualImage;
  const first = slots[0] || null;
  row.imageRef = first && first.ref ? copy(first.ref) : null;
  if (first && first.ref && first.name) row.imageName = first.name; else delete row.imageName;
  if (first && first.links && first.links.length) row.imageLinks = copy(first.links); else delete row.imageLinks;
  if (first && first.ref && first.annotation) row.imageAnnotation = copy(first.annotation); else delete row.imageAnnotation;
  const more: GalleryItem[] = [];
  slots.slice(1).forEach(function (s) {
    if (!s || (!s.ref && !isVideoSlot(s))) return;
    const it: GalleryItem = {};
    if (s.ref) it.imageRef = copy(s.ref);
    if (s.ref && s.name) it.name = s.name;
    if (s.links && s.links.length) it.links = copy(s.links);
    if (s.ref && s.annotation) it.annotation = copy(s.annotation);
    more.push(it);
  });
  if (more.length) row.moreImages = more; else delete row.moreImages;
}

function slotsOf(row: GalleryRow): Slot[] {
  return rowSlots(row).map(function (s) {
    return { ref: s.ref, links: s.links.slice(), name: s.name, annotation: s.annotation };
  });
}

export function addGalleryPicture(row: GalleryRow, ref: ImageRef, name: unknown): number {
  const slots = slotsOf(row);
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i] as Slot;
    if (s.ref && s.ref.sha256 === ref.sha256) return i;
  }
  let at;
  const clean = normalizePictureName(name);
  const head = slots[0] as Slot;
  if (!slots.length) { slots.push({ ref: ref, links: [], name: clean }); at = 0; }
  else if (!head.ref && !isVideoSlot(head)) { head.ref = ref; head.name = clean; at = 0; }
  else { slots.push({ ref: ref, links: [], name: clean }); at = slots.length - 1; }
  setRowSlots(row, slots);
  return at;
}

export function addGalleryVideo(row: GalleryRow, link: unknown, poster?: ImageRef | null): number {
  const l = normalizeVideoLink(link);
  if (!l) return -1;
  l.poster = true;
  const key = videoLinkKey(l);
  const slots = slotsOf(row);
  for (let i = 0; i < slots.length; i++) {
    if ((slots[i] as Slot).links.some(function (x) { return videoLinkKey(x) === key; })) return i;
  }
  const slot: Slot = { ref: poster || null, links: [l], name: "" };
  const head = slots[0] as Slot;
  if (slots.length === 1 && !head.ref && !isVideoSlot(head)) {
    slot.links = head.links.concat([l]);
    slots[0] = slot;
    setRowSlots(row, slots);
    return 0;
  }
  slots.push(slot);
  setRowSlots(row, slots);
  return slots.length - 1;
}

export function setVideoThumbnail(row: GalleryRow, key: string, ref: ImageRef | null | undefined): boolean {
  const slots = slotsOf(row);
  if (!ref || slots.some(function (s) { return s.ref && s.ref.sha256 === ref.sha256; })) return false;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i] as Slot;
    if (s.ref || !s.links.some(function (l) { return l.poster && videoLinkKey(l) === key; })) continue;
    s.ref = ref;
    setRowSlots(row, slots);
    return true;
  }
  return false;
}

export function replaceGalleryPicture(row: GalleryRow, i: number, ref: ImageRef, name: unknown): boolean {
  const slots = slotsOf(row);
  const slot = slots[i];
  if (!slot) return false;
  if (slots.some(function (s, k) { return k !== i && s.ref && s.ref.sha256 === ref.sha256; })) {
    slots.splice(i, 1);
  } else {
    slot.ref = ref;
    slot.name = normalizePictureName(name);
    slot.annotation = null;
  }
  setRowSlots(row, slots);
  return true;
}

export function annotateGallerySlot(row: GalleryRow, i: number, flat: unknown, original: unknown, marks: unknown): boolean {
  const slots = slotsOf(row);
  const s = slots[i];
  const orig: ImageRef | null = normalizeImageRef(original);
  if (!s || !s.ref || isVideoSlot(s) || !orig) return false;
  const clean = normalizeMarks(marks);
  const ref: ImageRef | null = clean.length ? normalizeImageRef(flat) : orig;
  if (!ref || (clean.length && ref.sha256 === orig.sha256)) return false;
  if (slots.some(function (o, k) { return k !== i && o.ref && o.ref.sha256 === ref.sha256; })) return false;
  s.ref = ref;
  s.annotation = clean.length ? { imageRef: orig, marks: clean } : null;
  setRowSlots(row, slots);
  return true;
}

export function moveGallerySlot(row: GalleryRow, from: number, to: number): boolean {
  const slots = slotsOf(row);
  if (!slots[from] || to < 0 || to >= slots.length || from === to) return false;
  const s = slots.splice(from, 1)[0] as Slot;
  slots.splice(to, 0, s);
  setRowSlots(row, slots);
  return true;
}

export function removeGallerySlot(row: GalleryRow, i: number): boolean {
  const slots = slotsOf(row);
  if (!slots[i]) return false;
  slots.splice(i, 1);
  setRowSlots(row, slots);
  return true;
}

export function removeGalleryLink(row: GalleryRow, i: number, key: string): boolean {
  const slots = slotsOf(row);
  const slot = slots[i];
  if (!slot) return false;
  const before = slot.links.length;
  slot.links = slot.links.filter(function (l) { return videoLinkKey(l) !== key; });
  if (slot.links.length === before) return false;
  if (!slot.ref && !slot.links.length) slots.splice(i, 1);
  setRowSlots(row, slots);
  return true;
}

function mergeSet<T>(base: readonly T[] | null | undefined, mine: readonly T[] | null | undefined, theirs: readonly T[] | null | undefined, key: (x: T) => string, both?: (b: T | undefined, m: T, t: T) => T): T[] {
  const b: Record<string, T> = {}, m: Record<string, T> = {}, t: Record<string, T> = {};
  (base || []).forEach(function (x) { b[key(x)] = x; });
  (mine || []).forEach(function (x) { m[key(x)] = x; });
  (theirs || []).forEach(function (x) { t[key(x)] = x; });
  const out: T[] = [];
  (theirs || []).forEach(function (x) {
    const k = key(x);
    const mk = m[k];
    if (!mk) { if (b[k]) return; out.push(copy(x)); return; }
    out.push(both ? both(b[k], mk, x) : copy(x));
  });
  (mine || []).forEach(function (x) {
    const k = key(x);
    if (t[k] || b[k]) return;
    out.push(copy(x));
  });
  return out;
}

export interface GallerySide {
  imageLinks?: VideoLink[] | undefined;
  moreImages?: GalleryItem[] | undefined;
}

export function mergeGalleryField(f: string, b: GallerySide | null | undefined, m: GallerySide, t: GallerySide): VideoLink[] | GalleryItem[] | undefined {
  let list: VideoLink[] | GalleryItem[];
  if (f === "imageLinks") {
    list = mergeSet(b && b.imageLinks, m.imageLinks, t.imageLinks, videoLinkKey);
  } else {
    list = mergeSet(b && b.moreImages, m.moreImages, t.moreImages, itemKey, function (bi, mi, ti) {
      const out = copy(ti);
      const links = mergeSet(bi && bi.links, mi.links, ti.links, videoLinkKey);
      if (links.length) out.links = links; else delete out.links;
      return out;
    });
  }
  return list.length ? list : undefined;
}

export function galleryFieldKey(row: Readonly<Record<string, unknown>> | null | undefined, f: string): string | null {
  const v = row && row[f];
  if (!Array.isArray(v) || !v.length) return null;
  if (f === "imageLinks") return (v as VideoLink[]).map(function (l) { return videoLinkKey(l) + (l.poster ? "*" : ""); }).join("\n");
  return (v as GalleryItem[]).map(function (it) {
    return itemKey(it) + "[" + (Array.isArray(it.links) ? it.links.map(videoLinkKey).join("\n") : "") + "]";
  }).join("\n");
}
