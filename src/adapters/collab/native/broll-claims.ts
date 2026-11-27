import * as Y from "yjs";
import type { NativeDeltaItem } from "./inline.ts";
import { decodeNativeValue, nativeFieldKey } from "./values.ts";
import type { NativeRoots } from "./roots.ts";

export const NATIVE_BROLL_SOURCE = "brollSource";
export const NATIVE_BROLL_GAP = "brollGap";

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

interface NativeBrollFold {
  readonly embeds: readonly StoredEmbed[];
  readonly claims: ReturnType<typeof nativeBrollClaims>;
  readonly hidden: ReadonlySet<StoredEmbed>;
  readonly gaps: ReadonlySet<string>;
}

function fold(embeds: readonly StoredEmbed[], claims: NativeBrollFold["claims"]): NativeBrollFold {
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
  return { embeds, claims, hidden, gaps };
}

export function projectNativeBrollCell(items: NativeDeltaItem[], claims: NativeBrollFold["claims"], previous?: NativeBrollFold) {
  const embeds: StoredEmbed[] = [];
  for (const { insert } of items) {
    if (typeof insert !== "string" && typeof insert[NATIVE_BROLL_SOURCE] === "string" &&
      typeof insert.k === "string" && typeof insert.label === "string") embeds.push(insert);
  }
  if (!embeds.length) return { items };
  const layout = previous?.claims === claims && previous.embeds.length === embeds.length &&
    embeds.every((embed, index) => embed === previous.embeds[index]) ? previous : fold(embeds, claims);
  if (layout.hidden.size) for (const [index, item] of items.entries()) {
    const gap = item.attributes?.[NATIVE_BROLL_GAP];
    if (typeof item.insert === "string" ? typeof gap === "string" && layout.gaps.has(gap) : layout.hidden.has(item.insert)) {
      items[index] = { ...item, foldedBroll: true };
    }
  }
  return { items, layout };
}
