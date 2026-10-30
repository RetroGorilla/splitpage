import { videoLinkLabel } from "../document/gallery.ts";
import type { VideoLink } from "../document/gallery.ts";
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
             : "A scene you added — it stays.";
  }
  if (b && rowContentEqual(b, t)) return "You deleted this scene — it stays deleted.";
  return b ? "You deleted this scene, but it changed on disk — it comes back."
           : "A new scene from the file on disk.";
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

export function mergeGallerySummary(row: ReviewRow, f: string): string {
  const v = (row && Array.isArray(row[f]) ? row[f] : []) as readonly GalleryItem[];
  if (f === "imageLinks") return v.map(videoLinkLabel).join(", ");
  if (!v.length) return "";
  const links: string[] = [];
  v.forEach(function (it) { (it.links || []).forEach(function (l) { links.push(videoLinkLabel(l)); }); });
  return v.length + (v.length === 1 ? " picture" : " pictures") + (links.length ? " · " + links.join(", ") : "");
}
