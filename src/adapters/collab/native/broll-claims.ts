import * as Y from "yjs";
import { setNativeBrollHidden } from "./inline.ts";
import type { NativeBrollHidden, NativeDeltaItem } from "./inline.ts";
import { decodeNativeValue, nativeFieldKey } from "./values.ts";
import type { NativeRoots } from "./roots.ts";

export const NATIVE_BROLL_SOURCE = "brollSource";
export const NATIVE_BROLL_MARKER = "brollMarker";

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
  readonly offsets: number[];
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

export function readNativeBrollLayout(items: readonly NativeDeltaItem[]): NativeBrollCellLayout {
  const embeds: StoredEmbed[] = [], offsets: number[] = [];
  let offset = 0;
  for (const { insert } of items) {
    if (typeof insert === "string") { offset += insert.length; continue; }
    offsets.push(offset++);
    if (typeof insert[NATIVE_BROLL_SOURCE] === "string" && typeof insert.k === "string" && typeof insert.label === "string") embeds.push(insert);
  }
  return { offsets, embeds };
}

// why: text deltas move stored offsets without changing which claims are folded
export function advanceNativeBrollLayout(layout: NativeBrollCellLayout, changes: Y.YTextEvent["delta"]): boolean {
  let offset = 0, shift = 0, next = 0;
  const offsets = layout.offsets;
  for (const change of changes) {
    if (change.retain) {
      offset += change.retain;
      if (shift) {
        while (next < offsets.length && (offsets[next] ?? Infinity) < offset) {
          offsets[next] = (offsets[next] as number) + shift;
          next++;
        }
      } else {
        let high = offsets.length;
        while (next < high) {
          const mid = (next + high) >> 1;
          if ((offsets[mid] ?? Infinity) < offset) next = mid + 1;
          else high = mid;
        }
      }
    }
    if (change.delete) {
      offset += change.delete;
      if ((offsets[next] ?? Infinity) < offset) return false;
      shift -= change.delete;
    }
    if (change.insert !== undefined) {
      if (typeof change.insert !== "string") return false;
      shift += change.insert.length;
    }
  }
  if (shift) for (; next < offsets.length; next++) offsets[next] = (offsets[next] as number) + shift;
  return true;
}

export function projectNativeBrollCell(items: readonly NativeDeltaItem[], claims: Claims, layout: NativeBrollCellLayout): void {
  if (layout.embeds.length < 2) return;
  if (layout.fold?.claims !== claims) layout.fold = { claims, hidden: fold(layout.embeds, claims) };
  if (layout.fold.hidden.embeds.size) setNativeBrollHidden(items, layout.fold.hidden);
}
