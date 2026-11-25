import { addNoticeEffects, currentNoticeEffects, noticeEffects } from "./notice-effects.ts";
import type { NativeNoticePeriods } from "./notice-effects.ts";
import type { NativeReadBeat, NativeScriptReader } from "./reader.ts";
import { deepFrozen, sameNativeValue } from "./values.ts";

export interface NativeBeatPlacement {
  readonly scene: string | null;
  readonly left: string | null;
  readonly right: string | null;
  readonly sceneOrder: readonly string[];
}

export interface NativeSavedBeat extends NativeReadBeat {
  readonly placement: NativeBeatPlacement;
}

interface PendingBeat {
  readonly id: string;
  first: number;
  last: number;
  before: NativeReadBeat | null;
  split?: { readonly parent: string; readonly at: number };
  created?: number;
  restored?: number;
  landingId?: string;
  heading?: true;
  periods?: NativeNoticePeriods;
}

export interface NativePendingEdit extends Readonly<PendingBeat> {
  readonly after: NativeSavedBeat | null;
  readonly landing: NativeReadBeat | null;
  readonly peer: boolean;
}

interface EncodedPendingEdit extends Omit<NativePendingEdit, "after"> {
  readonly after: (NativeReadBeat & {
    readonly placement: Omit<NativeBeatPlacement, "sceneOrder"> & { readonly order: number };
  }) | null;
}

export const NATIVE_PENDING_EDITS_SCHEMA_VERSION = 1;

export interface NativePendingEditsData {
  readonly through: number;
  readonly entries: readonly EncodedPendingEdit[];
  readonly orders?: readonly (readonly string[])[];
  readonly checkpoint?: {
    readonly through: number;
    readonly beats: readonly (readonly [string, NativeReadBeat | null])[];
  };
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isReadBeat(value: unknown): value is NativeReadBeat {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.row === "string"
    && Array.isArray(value.narration)
    && Array.isArray(value.visual)
    && isRecord(value.fields)
    && isNullableString(value.joined);
}

function isPeriods(value: unknown): value is NativeNoticePeriods {
  return isRecord(value)
    && (value.start === undefined || isNonNegativeInt(value.start))
    && (value.settled === undefined || isNonNegativeInt(value.settled))
    && (value.prefix === undefined || isNonNegativeInt(value.prefix))
    && (value.peer === undefined || isNonNegativeInt(value.peer));
}

function isEncodedPlacement(value: unknown, orderCount: number): boolean {
  return isRecord(value)
    && isNullableString(value.scene)
    && isNullableString(value.left)
    && isNullableString(value.right)
    && isNonNegativeInt(value.order)
    && value.order < orderCount;
}

export function encodeNativePendingEdits(data: NativePendingEditsData): Uint8Array {
  return textEncoder.encode(JSON.stringify({ version: NATIVE_PENDING_EDITS_SCHEMA_VERSION, data }));
}

export function decodeNativePendingEdits(bytes: Uint8Array): NativePendingEditsData {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new TypeError("Invalid pending edits journal");
  let parsed: unknown;
  try { parsed = JSON.parse(textDecoder.decode(bytes)); }
  catch { throw new TypeError("Invalid pending edits journal"); }
  if (!isRecord(parsed) || !isNonNegativeInt(parsed.version) || parsed.version < 1) {
    throw new TypeError("Invalid pending edits journal");
  }
  if (parsed.version !== NATIVE_PENDING_EDITS_SCHEMA_VERSION) {
    throw new DOMException(`Unsupported pending edits journal version: ${parsed.version}`, "VersionError");
  }
  const { data } = parsed;
  if (!isRecord(data) || !isNonNegativeInt(data.through) || !Array.isArray(data.entries)) {
    throw new TypeError("Invalid pending edits journal");
  }
  if (data.orders !== undefined && (!Array.isArray(data.orders)
    || data.orders.some(order => !Array.isArray(order) || order.some(id => typeof id !== "string")))) {
    throw new TypeError("Invalid pending edits journal");
  }
  const orderCount = Array.isArray(data.orders) ? data.orders.length : 0;
  for (const entry of data.entries) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !isNonNegativeInt(entry.first)
      || !isNonNegativeInt(entry.last) || typeof entry.peer !== "boolean"
      || (entry.before !== null && !isReadBeat(entry.before))
      || (entry.after !== null && (!isRecord(entry.after) || !isEncodedPlacement(entry.after["placement"], orderCount) || !isReadBeat(entry.after)))
      || (entry.landing !== null && !isReadBeat(entry.landing))
      || (entry.split !== undefined && (!isRecord(entry.split) || typeof entry.split.parent !== "string"
        || !isNonNegativeInt(entry.split.at)))
      || (entry.created !== undefined && !isNonNegativeInt(entry.created))
      || (entry.restored !== undefined && !isNonNegativeInt(entry.restored))
      || (entry.landingId !== undefined && typeof entry.landingId !== "string")
      || (entry.heading !== undefined && entry.heading !== true)
      || (entry.periods !== undefined && !isPeriods(entry.periods))) {
      throw new TypeError("Invalid pending edits journal");
    }
  }
  if (data.checkpoint !== undefined && (!isRecord(data.checkpoint) || !isNonNegativeInt(data.checkpoint.through)
    || !Array.isArray(data.checkpoint.beats)
    || data.checkpoint.beats.some(pair => !Array.isArray(pair) || pair.length !== 2
      || typeof pair[0] !== "string" || (pair[1] !== null && !isReadBeat(pair[1]))))) {
    throw new TypeError("Invalid pending edits journal");
  }
  return data as unknown as NativePendingEditsData;
}

interface NativeJournalCommand {
  readonly created?: string;
  readonly split?: boolean;
  readonly press?: "undo" | "redo";
}

interface Reading {
  readonly after: NativeSavedBeat | null;
  readonly landing: NativeReadBeat | null;
}

export function nativeBeatPlacements(reader: NativeScriptReader) {
  const placements = new Map<string, NativeBeatPlacement>(), headings = new Map<string, string>();
  let scene: string | null = null, previous: string | null = null;
  let sceneOrder: string[] = [];
  for (const entry of reader.outline()) {
    if (entry.kind === "heading") {
      Object.freeze(sceneOrder);
      sceneOrder = [];
      if (previous !== null) headings.set(entry.id, previous);
      scene = entry.id;
      continue;
    }
    for (const id of reader.row(entry.id)?.members ?? []) {
      const left = sceneOrder.at(-1) ?? null;
      const prior = left === null ? undefined : placements.get(left);
      if (left !== null && prior) placements.set(left, { ...prior, right: id });
      placements.set(id, { scene, left, right: null, sceneOrder });
      sceneOrder.push(id);
      previous = id;
    }
  }
  Object.freeze(sceneOrder);
  return { placements, headings };
}

export function openNativePendingEdits(reader: NativeScriptReader, saved?: NativePendingEditsData, onChange?: () => void) {
  const restored = deepFrozen(structuredClone(saved));
  let through = restored?.through ?? 0, checkpoint = restored?.checkpoint;
  let journalRevision = 0;
  let { placements, headings } = nativeBeatPlacements(reader);
  const beats = new Map<string, NativeReadBeat>();
  const entries = new Map<string, PendingBeat>(), held = new Map<string, Reading>();
  for (const id of placements.keys()) updateBeat(id);
  reader.refreshNotice();
  for (const { after, landing, peer, ...entry } of restored?.entries ?? []) {
    const key = entry.heading ? "h:" + entry.id : "b:" + entry.id;
    entries.set(key, entry);
    if (peer) {
      const saved = after && {
        ...after, placement: { scene: after.placement.scene, left: after.placement.left, right: after.placement.right,
          sceneOrder: restored?.orders?.[after.placement.order] ?? [] }
      };
      held.set(key, { after: saved, landing });
    }
  }

  function reading(entry: PendingBeat): Reading {
    const beat = entry.heading ? undefined : beats.get(entry.id), placement = placements.get(entry.id);
    return {
      after: beat && placement ? { ...beat, placement } : null,
      landing: entry.landingId === undefined ? null : beats.get(entry.landingId) ?? null
    };
  }

  function updateBeat(id: string): NativeReadBeat | null {
    const beat = reader.noticeBeat(id);
    if (beat) beats.set(id, beat); else beats.delete(id);
    return beat;
  }

  function note(key: string, id: string, old: NativeReadBeat | null): PendingBeat {
    const entry = entries.get(key) ?? { id, first: through + 1, last: through + 1, before: old };
    const prior = held.get(key);
    if (checkpoint && entry.last <= checkpoint.through) {
      entry.periods = {
        start: old, settled: {}, prefix: currentNoticeEffects(entry.before, prior ? prior.after : old, entry.periods),
        peer: !!prior || entry.periods?.peer === true
      };
    } else if (prior) {
      const periods = entry.periods;
      const start = periods ? periods.start : entry.before;
      entry.periods = {
        start: old, settled: addNoticeEffects(periods?.settled ?? {}, noticeEffects(start, prior.after)),
        ...periods?.prefix && { prefix: periods.prefix }, peer: true
      };
    }
    entry.last = through + 1;
    entries.set(key, entry);
    held.delete(key);
    return entry;
  }

  function pending(): NativePendingEdit[] {
    return [...entries].map(([key, entry]) => ({ ...entry, ...(held.get(key) ?? reading(entry)), peer: held.has(key) }));
  }

  function sync(command?: NativeJournalCommand): void {
    const changes = reader.refreshNotice(), oldPlacements = placements;
    let edited = false;
    if (changes.layout) {
      const oldHeadings = headings;
      ({ placements, headings } = nativeBeatPlacements(reader));
      if (command) for (const [id, above] of oldHeadings) {
        if (headings.has(id)) continue;
        const entry = note("h:" + id, id, null);
        entry.heading = true;
        entry.landingId = above;
        edited = true;
      }
    }
    for (const id of changes.beats) {
      const old = beats.get(id) ?? null, after = updateBeat(id);
      if (!command) continue;
      if (sameNativeValue(old, after) && sameNativeValue(oldPlacements.get(id), placements.get(id))) continue;
      const entry = note("b:" + id, id, old);
      const parent = placements.get(id)?.left;
      if (id === command.created && command.split && parent) {
        entry.split = { parent, at: entry.last };
        entry.before = after;
      }
      if (id === command.created && !command.split || command.press === "redo" && !old && after) entry.created = entry.last;
      if (command.press === "undo" && !old && after) entry.restored = entry.last;
      const above = oldPlacements.get(id)?.left;
      if (!after && command.press !== "undo" && above) entry.landingId = above;
      else delete entry.landingId;
      edited = true;
    }
    if (edited) {
      through++;
      journalRevision++;
      onChange?.();
    }
  }

  return Object.freeze({
    sync,
    pending,
    revision: () => journalRevision,
    through: () => through,
    hasPending: () => entries.size > 0,
    hasPendingThrough(limit: number): boolean {
      for (const entry of entries.values()) if (entry.first <= limit) return true;
      return false;
    },
    peer(): void {
      let changed = false;
      for (const [key, entry] of entries) {
        if (!held.has(key)) {
          held.set(key, reading(entry));
          changed = true;
        }
      }
      if (changed) {
        journalRevision++;
        onChange?.();
      }
    },
    data(): NativePendingEditsData {
      const indexes = new Map<string, number>(), orders: (readonly string[])[] = [];
      const packedOrders = new Map<readonly string[], number>();
      const packed = pending().map(({ after, ...entry }) => {
        if (!after) return { ...entry, after: null };
        const { sceneOrder, ...placement } = after.placement;
        let order = packedOrders.get(sceneOrder);
        if (order === undefined) {
          const key = JSON.stringify(sceneOrder);
          order = indexes.get(key) ?? orders.length;
          if (order === orders.length) orders.push(sceneOrder);
          indexes.set(key, order);
          packedOrders.set(sceneOrder, order);
        }
        return { ...entry, after: { ...after, placement: { ...placement, order } } };
      });
      return deepFrozen({
        through, entries: packed, ...orders.length && { orders }, ...checkpoint && { checkpoint }
      });
    },
    confirmationPoint(): number {
      if (!entries.size) return through;
      if (!checkpoint) {
        checkpoint = { through, beats: [...entries].map(([key, entry]) => {
          const after = (held.get(key) ?? reading(entry)).after;
          if (!after) return [key, null] as const;
          const { id, row, narration, visual, fields, joined } = after;
          return [key, { id, row, narration, visual, fields, joined }] as const;
        }) };
        journalRevision++;
        onChange?.();
      }
      return checkpoint.through;
    },
    clearThrough(confirmed: number): void {
      let changed = false;
      const confirmedBeats = new Map(checkpoint && confirmed >= checkpoint.through ? checkpoint.beats : []);
      if (checkpoint && confirmed >= checkpoint.through) {
        checkpoint = undefined;
        changed = true;
      }
      for (const [key, entry] of entries) {
        if (entry.last <= confirmed) {
          entries.delete(key);
          held.delete(key);
          changed = true;
        } else if (entry.first <= confirmed) {
          entry.first = confirmed + 1;
          if (confirmedBeats.has(key)) {
            entry.before = confirmedBeats.get(key) ?? null;
            if (entry.periods?.prefix) {
              const { start, settled } = entry.periods;
              entry.periods = { start, settled, peer: entry.periods.peer };
            }
          }
          if (entry.split && entry.split.at <= confirmed) delete entry.split;
          if (entry.created !== undefined && entry.created <= confirmed) delete entry.created;
          if (entry.restored !== undefined && entry.restored <= confirmed) delete entry.restored;
          changed = true;
        }
      }
      if (changed) {
        journalRevision++;
        onChange?.();
      }
    }
  });
}
