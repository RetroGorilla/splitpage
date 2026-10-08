import { cappedText, hasLoneSurrogate, plainText, settledNames } from "./text-policy.ts";
import { isTagId, normalizeTagName } from "./tags.ts";
import type { TagRecord } from "./tags.ts";

export const BROLL_STATUS_IDS = ["unshot", "shot"] as const;

export type BrollStatusId = (typeof BROLL_STATUS_IDS)[number];

export interface BrollProp {
  id: string;
  name: string;
}

interface BrollPropInput {
  id?: unknown;
  name?: unknown;
}

export function brollStatusId(id: unknown): BrollStatusId | null {
  for (const status of BROLL_STATUS_IDS) {
    if (status === id) return status;
  }
  return null;
}

export const BROLL_MARKER_RE = /^[ \t]*(b[ \t]?-?[ \t]?roll)[ \t]*([:—–-])[ \t]*/i;
export const BROLL_CLOSERS = ":—–-";

export const BROLL_NAME_MAX = 200;
export const BROLL_TEXT_MAX = 2000;
export const BROLL_PROP_NAME_MAX = 80;
export const BROLL_PROPS_MAX = 40;

function registryPropName(name: unknown): string {
  const text = plainText(name);
  return hasLoneSurrogate(text) ? text.trim() : cappedText(text, BROLL_PROP_NAME_MAX);
}

export function normalizeBrollProps(list: unknown,registry: readonly (TagRecord | null | undefined)[] | null | undefined): BrollProp[] {
  const byId: Record<string, TagRecord> = Object.create(null), byName: Record<string, TagRecord> = Object.create(null);
  (registry || []).forEach(function (t) {
    if (!t || !t.id || !t.name) return;
    byId[t.id] = t;
    if (t.cat === "prop" && !byName[normalizeTagName(t.name)]) byName[normalizeTagName(t.name)] = t;
  });
  const out: BrollProp[] = [], seen: Record<string, boolean> = Object.create(null), items: BrollPropInput[] = [];
  (Array.isArray(list) ? list as unknown[] : []).forEach(function (p) {
    if (typeof p === "string") p = { name: p };
    if (p && typeof p === "object") items.push(p as BrollPropInput);
  });
  const names = settledNames(items.map(function (p) { return plainText(p.name); }), BROLL_PROP_NAME_MAX, normalizeTagName);
  items.forEach(function (prop, at) {
    if (out.length >= BROLL_PROPS_MAX) return;
    let id = isTagId(prop.id) ? prop.id : "";
    let name = names[at] as string;
    if (!id && name && byName[normalizeTagName(name)]) id = (byName[normalizeTagName(name)] as TagRecord).id as string;
    if (id && byId[id]) name = registryPropName((byId[id] as TagRecord).name);
    if (!name) return;
    const key = brollPropKey(id, name);
    if (seen[key]) return;
    seen[key] = true;
    out.push({ id: id, name: name });
  });
  return out;
}

export function brollPropKey(id: string, name: unknown): string {
  return id ? id : "n:" + normalizeTagName(name);
}
