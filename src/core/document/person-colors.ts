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
  let n = 0;
  Object.keys(map).forEach(function (name) {
    if (n >= PERSON_MAP_MAX) return;
    const clean = String(name).replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, PERSON_NAME_MAX).trimEnd();
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
