import { galleryFieldKey, galleryItemKey, mergeGalleryField, videoLinkKey, videoLinkLabel, withoutVideoLocations } from "../document/gallery.ts";
import type { GallerySide, VideoLink } from "../document/gallery.ts";
import { idMap } from "../document/id-map.ts";
import { escapeHtml } from "../document/text-policy.ts";
import { rowContentEqual } from "./rows.ts";

type ReviewRow = Readonly<Record<string, unknown>> | null | undefined;

type FieldOutcome = "theirs" | "mine" | "conflict";

interface DiffOp {
  op: "same" | "del" | "add";
  text: string;
}

interface DiffPair {
  mine: string;
  theirs: string;
}

interface ReviewEntry {
  label: string;
  outcome: string;
  mineHtml: string;
  theirsHtml: string;
}

interface GalleryItem extends VideoLink {
  links?: readonly (VideoLink | null | undefined)[] | null | undefined;
}

export function mergeFieldOutcome(b: unknown, m: unknown, t: unknown): FieldOutcome | null {
  if (m === t) return null;
  if (b !== null && m === b) return "theirs";
  if (b !== null && t === b) return "mine";
  return "conflict";
}

export function mergeRowFate(b: ReviewRow, m: ReviewRow, t: ReviewRow): string | null {
  if (m && t) return null;
  if (m && !t) {
    if (b && rowContentEqual(b, m)) return "Deleted in the file on disk — it goes.";
    return b ? "Deleted in the file on disk, but you changed it — your version stays."
             : "A beat you added — it stays.";
  }
  if (b && rowContentEqual(b, t)) return "You deleted this beat — it stays deleted.";
  return b ? "You deleted this beat, but it changed on disk — it comes back."
           : "A new beat from the file on disk.";
}

export function mergeItemSummary(bits: readonly unknown[]): string {
  return bits.filter(function (b) { return b; }).join(" · ");
}

export function mergeListEntries<T>(
  label: string,
  mineList: readonly (T | null | undefined)[] | null | undefined,
  theirList: readonly (T | null | undefined)[] | null | undefined,
  keyOf: (it: T) => string,
  nameOf: (it: T) => string,
  summaryOf: (it: T) => string
): ReviewEntry[] {
  const mineMap = idMap<T>(), theirMap = idMap<T>(), order: string[] = [], seen = idMap<boolean>();
  (mineList || []).forEach(function (it) { if (it) mineMap[keyOf(it)] = it; });
  (theirList || []).forEach(function (it) { if (it) theirMap[keyOf(it)] = it; });
  (theirList || []).concat(mineList || []).forEach(function (it) {
    if (!it) return;
    const k = keyOf(it);
    if (seen[k]) return;
    seen[k] = true;
    order.push(k);
  });
  const entries: ReviewEntry[] = [];
  order.forEach(function (k) {
    const m = mineMap[k], t = theirMap[k];
    const ms = m ? summaryOf(m) : "", ts = t ? summaryOf(t) : "";
    if (ms === ts) return;
    const pair = mergeDiffPairHtml(ms, ts);
    entries.push({
      label: label + ": " + nameOf((m || t) as T),
      outcome: "both",
      mineHtml: pair.mine,
      theirsHtml: pair.theirs
    });
  });
  return entries;
}

export const MERGE_DIFF_TOKEN_CAP = 600;

export function mergeDiffTokenize(s: unknown): string[] {
  return String(s == null ? "" : s).split(/(\s+)/).filter(function (t) { return t !== ""; });
}

export function mergeDiffOps(a: readonly string[], b: readonly string[]): DiffOp[] | null {
  const n = a.length, m = b.length;
  if (n > MERGE_DIFF_TOKEN_CAP || m > MERGE_DIFF_TOKEN_CAP) return null;
  const w = m + 1;
  const lcs = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j]
        ? (lcs[(i + 1) * w + j + 1] as number) + 1
        : Math.max(lcs[(i + 1) * w + j] as number, lcs[i * w + j + 1] as number);
    }
  }
  const out: DiffOp[] = [];
  let x = 0, y = 0;
  while (x < n && y < m) {
    if (a[x] === b[y]) { out.push({ op: "same", text: a[x] as string }); x++; y++; }
    else if ((lcs[(x + 1) * w + y] as number) >= (lcs[x * w + y + 1] as number)) { out.push({ op: "del", text: a[x] as string }); x++; }
    else { out.push({ op: "add", text: b[y] as string }); y++; }
  }
  while (x < n) out.push({ op: "del", text: a[x++] as string });
  while (y < m) out.push({ op: "add", text: b[y++] as string });
  return out;
}

function mergeDiffSideHtml(ops: readonly DiffOp[], want: "del" | "add"): string {
  let html = "", any = false;
  ops.forEach(function (o) {
    if (o.op !== "same" && o.op !== want) return;
    if (o.text.trim()) any = true;
    html += o.op === "same"
      ? escapeHtml(o.text)
      : '<span class="diff-' + want + '">' + escapeHtml(o.text) + "</span>";
  });
  return any ? html : '<em class="diff-empty">(empty)</em>';
}

function mergeDiffWholeHtml(text: string, cls: string): string {
  return text ? '<span class="diff-' + cls + '">' + escapeHtml(text) + "</span>"
              : '<em class="diff-empty">(empty)</em>';
}

export function mergeDiffPairHtml(mineText: string, theirText: string): DiffPair {
  const ops = mergeDiffOps(mergeDiffTokenize(mineText), mergeDiffTokenize(theirText));
  if (!ops) return { mine: mergeDiffWholeHtml(mineText, "del"), theirs: mergeDiffWholeHtml(theirText, "add") };
  return { mine: mergeDiffSideHtml(ops, "del"), theirs: mergeDiffSideHtml(ops, "add") };
}

export interface GalleryMoves {
  keys: ReadonlySet<string>;
  kept: "theirs" | "mine" | "mixed" | null;
  bundled: boolean;
  only: boolean;
}

function linkPlace(l: VideoLink | null | undefined): string {
  return JSON.stringify((l && l.location) || null);
}

function fileLinksOf(row: ReviewRow, f: string): Map<string, VideoLink> {
  const out = new Map<string, VideoLink>();
  const v = (row && Array.isArray(row[f]) ? row[f] : []) as readonly (GalleryItem | null | undefined)[];
  function add(prefix: string, links: readonly (VideoLink | null | undefined)[] | null | undefined): void {
    const list: readonly (VideoLink | null | undefined)[] = Array.isArray(links) ? links : [];
    list.forEach(function (l) { if (l && !l.href) out.set(prefix + videoLinkKey(l), l); });
  }
  if (f === "imageLinks") add("", v);
  else v.forEach(function (it) { if (it && typeof it === "object") add(galleryItemKey(it) + "\n", it.links); });
  return out;
}

function unlocatedKey(row: Readonly<Record<string, unknown>>, f: string): string | null {
  const probe = JSON.parse(JSON.stringify({ [f]: row[f] ?? null })) as Record<string, unknown>;
  withoutVideoLocations([probe]);
  return galleryFieldKey(probe, f);
}

export function mergeGalleryMoves(f: string, b: ReviewRow, m: Readonly<Record<string, unknown>>, t: Readonly<Record<string, unknown>>): GalleryMoves {
  const mine = fileLinksOf(m, f), theirs = fileLinksOf(t, f);
  const merged = fileLinksOf({ [f]: mergeGalleryField(f, (b || null) as GallerySide | null, m as GallerySide, t as GallerySide) }, f);
  const keys = new Set<string>(), sides = new Set<"theirs" | "mine">();
  let bundled = true;
  mine.forEach(function (ml, k) {
    const tl = theirs.get(k);
    if (!tl || linkPlace(ml) === linkPlace(tl)) return;
    keys.add(k);
    const kept = merged.get(k);
    const side = kept && linkPlace(kept) === linkPlace(ml) ? "mine" : "theirs";
    sides.add(side);
    const won = side === "mine" ? ml : tl, lost = side === "mine" ? tl : ml;
    if (!(won.location && won.location.kind === "bundled" && !(lost.location && lost.location.kind === "bundled"))) bundled = false;
  });
  const kept = !keys.size ? null : sides.size > 1 ? "mixed" : sides.has("mine") ? "mine" : "theirs";
  return { keys, kept, bundled: keys.size > 0 && bundled, only: keys.size > 0 && unlocatedKey(m, f) === unlocatedKey(t, f) };
}

function videoPlaceLabel(l: VideoLink): string {
  const at = l.location;
  if (!at) return "";
  if (at.kind === "bundled") return at.name === l.name ? "beside the script" : "beside the script as " + at.name;
  const i = Math.max(at.path.lastIndexOf("\\"), at.path.lastIndexOf("/"));
  if (at.path.slice(i + 1) !== l.name) return at.path;
  const folder = i <= 0 ? at.path.slice(0, i + 1) : at.path.slice(0, i);
  return /^[A-Za-z]:$/.test(folder) ? folder + at.path.charAt(i) : folder;
}

export function mergeGallerySummary(row: ReviewRow, f: string, shown?: ReadonlySet<string>): string {
  const v = (row && Array.isArray(row[f]) ? row[f] : []) as readonly GalleryItem[];
  function label(prefix: string, l: VideoLink | null | undefined): string {
    const placed = !!l && !l.href && !!l.location && !!shown && shown.has(prefix + videoLinkKey(l));
    return videoLinkLabel(l) + (placed ? " (" + videoPlaceLabel(l as VideoLink) + ")" : "");
  }
  if (f === "imageLinks") return v.map(function (l) { return label("", l); }).join(", ");
  if (!v.length) return "";
  const links: string[] = [];
  v.forEach(function (it) { (it.links || []).forEach(function (l) { links.push(label(galleryItemKey(it) + "\n", l)); }); });
  return v.length + (v.length === 1 ? " picture" : " pictures") + (links.length ? " · " + links.join(", ") : "");
}
