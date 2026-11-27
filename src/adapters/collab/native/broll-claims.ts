import * as Y from "yjs";
import { setNativeBrollHidden } from "./inline.ts";
import type { NativeBrollHidden, NativeDeltaItem } from "./inline.ts";
import { decodeNativeValue, nativeClock, nativeFieldKey } from "./values.ts";
import type { NativeRoots } from "./roots.ts";

export const NATIVE_BROLL_SOURCE = "brollSource";
const NATIVE_BROLL_MARKER = "brollMarker";

export function nativeBrollMarkerAt(items: readonly NativeDeltaItem[], index: number): string | undefined {
  let at = 0;
  for (const item of items) {
    at += typeof item.insert === "string" ? item.insert.length : 1;
    if (index >= at) continue;
    const marker = item.attributes?.[NATIVE_BROLL_MARKER];
    return typeof marker === "string" && /^[a-z0-9]+-[a-z0-9]+$/.test(marker) ? marker : undefined;
  }
  return undefined;
}

const markerFormats = new WeakMap<Y.Doc, Map<number, Set<number>>>();

export function nativeBrollUndoFilter(doc: Y.Doc): (item: Y.Item) => boolean {
  const formats = markerFormats.get(doc) ?? new Map<number, Set<number>>();
  markerFormats.set(doc, formats);
  return ({ id }) => !formats.get(id.client)?.has(id.clock);
}

export function writeNativeBrollMarker(doc: Y.Doc, text: Y.Text, delimiter: number, marker: string): void {
  const formats = markerFormats.get(doc), client = doc.clientID;
  const first = formats ? nativeClock(doc) : 0;
  // why: the following space keeps the formatting span live while the delimiter is replaced
  text.format(delimiter, 2, { [NATIVE_BROLL_MARKER]: marker });
  if (!formats) return;
  const end = nativeClock(doc);
  const clocks = formats.get(client) ?? new Set<number>();
  formats.set(client, clocks);
  // why: keep only the delimiter's identity through Undo, including after another copy opens that state
  for (let clock = first; clock < end; clock++) clocks.add(clock);
}

interface Claim {
  readonly source: string;
  readonly state: "removed" | "unnamed" | "named";
}

const NAME = nativeFieldKey("name");
const PRIORITY = { removed: 0, unnamed: 1, named: 2 } as const;

export function nativeBrollClaims(root: NativeRoots["shots"]): ReadonlyMap<string, Claim> {
  const claims = new Map<string, Claim>();
  for (const [id, record] of root) {
    if (!(record instanceof Y.Map)) continue;
    const source = record.get(NATIVE_BROLL_SOURCE);
    if (typeof source !== "string" || !source) continue;
    const name = decodeNativeValue(record.get(NAME))?.value;
    claims.set(id, { source, state: record.get("removed") === true ? "removed" : typeof name === "string" && name ? "named" : "unnamed" });
  }
  return claims;
}

export function nativeBrollClaimField(key: string): boolean {
  return key === NAME || key === NATIVE_BROLL_SOURCE || key === "removed";
}

type StoredEmbed = Readonly<Record<string, unknown>>;

type Claims = ReturnType<typeof nativeBrollClaims>;

export interface NativeBrollCellLayout {
  readonly objects: readonly StoredEmbed[];
  readonly embeds: readonly StoredEmbed[];
  fold?: { readonly claims: Claims; readonly hidden: NativeBrollHidden };
}

function fold(embeds: readonly StoredEmbed[], claims: Claims): NativeBrollHidden {
  const winners = new Map<string, { id: string; priority: number; embed: StoredEmbed }>();
  const hidden = new Set<StoredEmbed>(), gaps = new Set<string>();
  for (const embed of embeds) {
    const { k: id, [NATIVE_BROLL_SOURCE]: source } = embed;
    if (typeof id !== "string" || typeof source !== "string") continue;
    const stored = claims.get(id), priority = stored?.source === source ? PRIORITY[stored.state] : 0, winner = winners.get(source);
    if (!winner || priority > winner.priority || priority === winner.priority && id < winner.id) {
      if (winner) { hidden.add(winner.embed); gaps.add(winner.id); }
      winners.set(source, { id, priority, embed });
    } else {
      hidden.add(embed);
      gaps.add(id);
    }
  }
  return { embeds: hidden, gaps };
}

const NO_EMBEDS: readonly StoredEmbed[] = Object.freeze([]);

export function readNativeBrollLayout(items: readonly NativeDeltaItem[], previous?: NativeBrollCellLayout): NativeBrollCellLayout {
  const prior = previous?.objects ?? NO_EMBEDS;
  let count = 0, changed: StoredEmbed[] | undefined;
  for (const { insert } of items) {
    if (typeof insert === "string") continue;
    if (!changed && prior[count] !== insert) changed = prior.slice(0, count);
    changed?.push(insert);
    count++;
  }
  if (previous && !changed && count === prior.length) return previous;
  const objects = changed ?? (count ? prior.slice(0, count) : NO_EMBEDS);
  const embeds = objects.length ? objects.filter(embed => typeof embed[NATIVE_BROLL_SOURCE] === "string" &&
    typeof embed.k === "string" && typeof embed.label === "string") : NO_EMBEDS;
  return { objects, embeds };
}

export function projectNativeBrollCell(items: readonly NativeDeltaItem[], claims: Claims, layout: NativeBrollCellLayout): void {
  if (layout.embeds.length < 2) return;
  if (layout.fold?.claims !== claims) layout.fold = { claims, hidden: fold(layout.embeds, claims) };
  if (layout.fold.hidden.embeds.size) setNativeBrollHidden(items, layout.fold.hidden);
}
