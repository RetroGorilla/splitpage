import * as Y from "yjs";
import { createEncoder, toUint8Array, writeAny } from "lib0/encoding";
import { createDecoder, readAny } from "lib0/decoding";
import type { CollabMarks } from "../model.ts";
import { compareCodeUnits } from "./order.ts";

export function rootMap(doc: Y.Doc, name: string): Y.Map<unknown> | null {
  try { return doc.getMap(name); } catch { return null; }
}

export function sharedMapRecord(raw: unknown): Y.Map<unknown> | null { return raw instanceof Y.Map ? raw : null; }

export function stringKeys(raw: unknown): string[] {
  const keys = readWireValue(raw);
  return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [];
}

export function rootText(doc: Y.Doc, name: string): Y.Text | null {
  try { return doc.getText(name); } catch { return null; }
}

export function rootOrder(doc: Y.Doc): string[] {
  try { return doc.getArray<unknown>("order").toArray().filter((id): id is string => typeof id === "string"); } catch { return []; }
}

export function readWireValue(raw: unknown): unknown {
  try {
    const source: unknown = raw instanceof Y.AbstractType ? raw.toJSON() : raw;
    const encoded = createEncoder(); writeAny(encoded, source as Parameters<typeof writeAny>[1]);
    return readAny(createDecoder(toUint8Array(encoded))) as unknown;
  } catch { return undefined; }
}

export function readWireRecord(raw: unknown): Record<string, unknown> | null {
  const decoded = readWireValue(raw);
  return decoded && typeof decoded === "object" && !Array.isArray(decoded) && !(decoded instanceof Uint8Array)
    ? Object.fromEntries(Object.entries(decoded)) : null;
}

export function readRankedRecord(raw: unknown): { source: Y.Map<unknown>; rank: string } | null {
  if (!(raw instanceof Y.Map)) return null;
  const rank = readWireValue(raw.get("rank"));
  return rank === undefined || typeof rank === "string" ? { source: raw, rank: rank ?? "" } : null;
}

export function readGallerySlotRecord(raw: unknown): { beat: string } | null {
  if (!(raw instanceof Y.Map)) return null;
  const metadata = readWireRecord({ beat: raw.get("beat") });
  return typeof metadata?.beat === "string" ? { beat: metadata.beat } : null;
}

export function sameProjectionValue(left: unknown, right: unknown): boolean {
  const stack: [unknown, unknown][] = [[left, right]], seen = new Map<object, Set<object>>();
  while (stack.length) {
    const pair = stack.pop(); if (!pair) continue;
    const [a, b] = pair;
    if (Object.is(a, b)) continue;
    if (!a || !b || typeof a !== "object" || typeof b !== "object" || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    if (seen.get(a)?.has(b)) continue;
    const matches = seen.get(a) ?? new Set<object>(); matches.add(b); seen.set(a, matches);
    const keys = Object.keys(a), left = a as Record<string, unknown>, right = b as Record<string, unknown>;
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) { if (!Object.hasOwn(b, key)) return false; stack.push([left[key], right[key]]); }
  }
  return true;
}

export function readCommentRecord(raw: unknown): Record<string, unknown> | null {
  const data = readWireRecord(raw);
  if (!data) return null;
  for (const key of ["author", "rowId", "field"]) if (data[key] != null && typeof data[key] !== "string") return null;
  return data;
}

export function readVisualRecord(raw: unknown): { beat: string; rank: string; text: Y.Text } | null {
  if (!(raw instanceof Y.Map)) return null;
  const metadata = readWireRecord({ beat: raw.get("beat"), rank: raw.get("rank") ?? "" }), text: unknown = raw.get("text");
  return metadata && typeof metadata.beat === "string" && typeof metadata.rank === "string" && text instanceof Y.Text
    ? { beat: metadata.beat, rank: metadata.rank, text } : null;
}

export function readReplyRecord(raw: unknown): { data: Record<string, unknown>; commentId: string; createdAt: number } | null {
  const data = readWireRecord(raw);
  if (!data || typeof data.commentId !== "string" || data.id !== undefined && typeof data.id !== "string") return null;
  const value = data.createdAt;
  if (value !== undefined && value !== null && !["number", "string", "boolean"].includes(typeof value)) return null;
  const number = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) ? Date.parse(value) : value === undefined ? 0 : Number(value);
  return { data, commentId: data.commentId, createdAt: Number.isFinite(number) ? number : 0 };
}

export function readBoundaryRecord(raw: unknown): { id: string; kind?: "heading" } | null {
  const value = readWireRecord(raw);
  if (!value) return null;
  if (typeof value.b === "string" && value.b) return { id: value.b };
  return typeof value.h === "string" && value.h ? { id: value.h, kind: "heading" } : null;
}

export function readMarkRecord(raw: unknown): CollabMarks {
  const value = readWireRecord(raw);
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string | boolean] => typeof entry[1] === "string" || typeof entry[1] === "boolean"));
}

export function readContentAtom(raw: unknown): Record<string, string> | null {
  const value = readWireRecord(raw); if (!value) return null;
  if (typeof value.k === "string") return { k: value.k, ...(typeof value.label === "string" ? { label: value.label } : {}) };
  if (typeof value.w === "string") return { w: value.w };
  const boundary = readBoundaryRecord(value);
  return boundary ? { [boundary.kind ? "h" : "b"]: boundary.id } : null;
}

export function readSegmentRecord(raw: unknown): { text: Y.Text; head: { id: string; kind?: "heading" } | null } | null {
  if (!(raw instanceof Y.Map)) return null;
  const text: unknown = raw.get("text");
  return text instanceof Y.Text ? { text, head: readBoundaryRecord(raw.get("head")) } : null;
}

export interface ReaderJoinRecord { into: string; glue: string }

export function readJoinRecord(raw: unknown): ReaderJoinRecord | null {
  const value = readWireRecord(raw);
  return value && typeof value.into === "string" && typeof value.glue === "string" ? { into: value.into, glue: value.glue } : null;
}

export interface ReaderBeatRecord {
  status?: string;
  splitBy?: string;
  paragraphStart?: boolean;
  lengthSeconds?: number;
  removals: [string, boolean][];
  joins: [string, ReaderJoinRecord][];
}

export function readBeatRecord(raw: unknown): ReaderBeatRecord {
  const result: ReaderBeatRecord = { removals: [], joins: [] };
  if (!(raw instanceof Y.Map)) return result;
  const value = readWireRecord({ status: raw.get("status"), splitBy: raw.get("splitBy"), paragraphStart: raw.get("paragraphStart"), lengthSeconds: raw.get("lengthSeconds") });
  if (typeof value?.status === "string") result.status = value.status;
  if (typeof value?.splitBy === "string") result.splitBy = value.splitBy;
  if (value?.paragraphStart === true) result.paragraphStart = true;
  if (typeof value?.lengthSeconds === "number" && Number.isFinite(value.lengthSeconds)) result.lengthSeconds = value.lengthSeconds;
  const removals: unknown = raw.get("removals"), joins: unknown = raw.get("joins");
  if (removals instanceof Y.Map) for (const [id, flag] of removals) if (typeof id === "string" && typeof flag === "boolean") result.removals.push([id, flag]);
  if (joins instanceof Y.Map) for (const [id, entry] of joins) {
    const join = readJoinRecord(entry); if (typeof id === "string" && join) result.joins.push([id, join]);
  }
  return result;
}

export function readGalleryRecord(id: string, raw: unknown): { id: string; beat: string; rank: string; ref: string; name: string; annotation: string; links: { href: string; poster?: string }[]; data: Record<string, unknown> } | null {
  const value = readWireRecord(raw);
  if (!value || typeof value.beat !== "string" || typeof value.rank !== "string" || typeof value.ref !== "string") return null;
  if (value.name !== undefined && typeof value.name !== "string" || value.annotation !== undefined && typeof value.annotation !== "string" || !Array.isArray(value.links)) return null;
  const links: { href: string; poster?: string }[] = [];
  for (let index = 0; index < value.links.length; index++) {
    const link = readWireRecord(value.links[index]);
    if (!link || typeof link.href !== "string" || link.poster !== undefined && typeof link.poster !== "string") return null;
    links.push({ href: link.href, ...(typeof link.poster === "string" ? { poster: link.poster } : {}) });
  }
  return { id, beat: value.beat, rank: value.rank, ref: value.ref, name: value.name ?? "", annotation: value.annotation ?? "", links, data: value };
}

export function readCaretRecord(raw: unknown): { position: Y.RelativePosition; selectionEnd?: Y.RelativePosition } | null {
  const value = readWireRecord(raw);
  const position = (raw: unknown): Y.RelativePosition | null => {
    const data = readWireRecord(raw); if (!data) return null;
    const identifier = (raw: unknown): Y.ID | null => {
      const id = readWireRecord(raw);
      return id && typeof id.client === "number" && Number.isSafeInteger(id.client) && id.client >= 0
        && typeof id.clock === "number" && Number.isSafeInteger(id.clock) && id.clock >= 0 ? new Y.ID(id.client, id.clock) : null;
    };
    if (data.type != null && !identifier(data.type) || data.item != null && !identifier(data.item)
      || data.tname != null && typeof data.tname !== "string" || typeof data.assoc !== "number" || !Number.isSafeInteger(data.assoc)) return null;
    return new Y.RelativePosition(identifier(data.type), typeof data.tname === "string" ? data.tname : null, identifier(data.item), data.assoc);
  };
  const start = position(value?.position), end = position(value?.selectionEnd);
  return start ? { position: start, ...(end ? { selectionEnd: end } : {}) } : null;
}

export function firstLiveJoin(beat: ReaderBeatRecord, retired: { has: (id: string) => boolean }): ReaderJoinRecord | null {
  return beat.joins.filter(([id]) => !retired.has(id)).sort(([a], [b]) => compareCodeUnits(a, b))[0]?.[1] ?? null;
}
