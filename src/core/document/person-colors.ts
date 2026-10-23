import { cappedName, settledNames } from "./text-policy.ts";

export type PersonColors = Record<string, string>;

export const PERSON_COLORS: readonly string[] = [
  "#80BDFB", "#F9B64F", "#CBA1FA", "#73D4AC",
  "#F89DC9", "#C8DE63", "#EF958E", "#64D1D7"
];

export const PERSON_NAME_MAX = 80;
export const PERSON_MAP_MAX = 200;

export function paletteColor(value: unknown): string {
  if (typeof value !== "string") return "";
  const up = value.trim().toUpperCase();
  return PERSON_COLORS.indexOf(up) === -1 ? "" : up;
}

export function personKey(name: unknown): string {
  return String(name == null ? "" : name).trim().toLowerCase();
}

export function normalizePersonColors(raw: unknown): PersonColors | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const map = raw as Record<string, unknown>;
  const out: PersonColors = {}, seen: Record<string, boolean> = Object.create(null);
  const keys = Object.keys(map).filter(function (name) { return !!paletteColor(map[name]); });
  const names = settledNames(keys.map(function (name) { return name.replace(/[\x00-\x1f\x7f]/g, ""); }), PERSON_NAME_MAX, personKey);
  let n = 0;
  keys.forEach(function (name, at) {
    if (n >= PERSON_MAP_MAX) return;
    const clean = names[at] as string;
    const color = paletteColor(map[name]);
    if (!clean || !color || clean === "__proto__" || clean === "constructor" || clean === "prototype") return;
    const key = personKey(clean);
    if (seen[key]) return;
    seen[key] = true;
    out[clean] = color;
    n++;
  });
  return n ? out : null;
}

export function lookupByName(map: Readonly<Record<string, unknown>> | null | undefined, name: string): string {
  if (!map) return "";
  if (Object.prototype.hasOwnProperty.call(map, name)) return paletteColor(map[name]);
  const key = personKey(name);
  let hit = "";
  Object.keys(map).some(function (k) {
    if (personKey(k) !== key) return false;
    hit = paletteColor(map[k]);
    return true;
  });
  return hit;
}

export function mergePersonColors(base: unknown, mine: unknown, theirs: unknown): PersonColors | null {
  const b = normalizePersonColors(base) || {};
  const m = normalizePersonColors(mine) || {};
  const t = normalizePersonColors(theirs) || {};
  const out: PersonColors = {}, taken: Record<string, boolean> = Object.create(null);
  function put(name: string, color: string): void {
    const key = personKey(name);
    if (taken[key]) return;
    taken[key] = true;
    out[name] = color;
  }
  Object.keys(m).forEach(function (name) {
    const mc = m[name] as string, tc = lookupByName(t, name), bc = lookupByName(b, name);
    put(name, tc && mc === bc ? tc : mc);
  });
  Object.keys(t).forEach(function (name) { put(name, t[name] as string); });
  Object.keys(b).forEach(function (name) { put(name, b[name] as string); });
  return normalizePersonColors(out);
}

export const PERSON_COLOR_NAMES: readonly string[] = ["Blue", "Amber", "Violet", "Green", "Pink", "Lime", "Coral", "Teal"];

export interface PersonColorContext {
  readonly self?: unknown;
  readonly selfColor?: unknown;
  readonly live?: Record<string, unknown> | null | undefined;
  readonly doc?: Readonly<Record<string, unknown>> | null | undefined;
}

export function hashedPersonColor(seed: unknown): string {
  const text = String(seed || "");
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return PERSON_COLORS[Math.abs(hash) % PERSON_COLORS.length] as string;
}

export function resolvePersonColor(name: unknown, ctx?: PersonColorContext | null): string {
  const given = ctx || {};
  const key = personKey(name);
  if (key) {
    const mine = paletteColor(given.selfColor);
    if (mine && given.self && personKey(given.self) === key) return mine;
    const live = given.live && Object.prototype.hasOwnProperty.call(given.live, key) ? paletteColor(given.live[key]) : "";
    if (live) return live;
    const doc = lookupByName(given.doc, name as string);
    if (doc) return doc;
  }
  return hashedPersonColor(name);
}

export function colorsWithMine(current: unknown, name: string, color: string): PersonColors | null {
  if (!name || !color) return null;
  const map = current && typeof current === "object" ? current as Readonly<Record<string, string>> : null;
  let have = "";
  if (map) {
    Object.keys(map).forEach(function (k) { if (personKey(k) === personKey(name)) have = k; });
    if (have && map[have] === color) return null;
  }
  const next: Record<string, string> = {};
  if (map) Object.keys(map).forEach(function (k) { if (k !== have) next[k] = map[k] as string; });
  next[cappedName(name, 80)] = color;
  return normalizePersonColors(next);
}
