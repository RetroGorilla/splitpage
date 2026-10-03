export const TAG_CATEGORY_IDS = ["prop", "location", "cast", "vfx", "sound", "gear"] as const;

export type TagCategoryId = (typeof TAG_CATEGORY_IDS)[number];

export const TAG_STATUS_IDS = ["needed", "sourcing", "have", "returned"] as const;

export type TagStatusId = (typeof TAG_STATUS_IDS)[number];

export interface TagIdHolder {
  id?: string | undefined;
}

export interface TagRecord extends TagIdHolder {
  cat: string;
  name: string;
}

export interface TagName {
  cat: string;
  name: string;
}

export interface TagHooks {
  tagId: (cat: string, name: string) => string;
  tagOf: (id: unknown) => TagName | null;
}

export function tagCategoryId(id: unknown): TagCategoryId | null {
  for (const cat of TAG_CATEGORY_IDS) {
    if (cat === id) return cat;
  }
  return null;
}

export function tagStatusId(id: unknown): TagStatusId | null {
  for (const status of TAG_STATUS_IDS) {
    if (status === id) return status;
  }
  return null;
}

export function tagStatusRank(id: unknown): number {
  for (let i = 0; i < TAG_STATUS_IDS.length; i++) {
    if (TAG_STATUS_IDS[i] === id) return i;
  }
  return 0;
}

export function nextTagStatus(id: unknown): TagStatusId {
  return TAG_STATUS_IDS[(tagStatusRank(id) + 1) % TAG_STATUS_IDS.length] as TagStatusId;
}

export function normalizeTagName(name: unknown): string {
  return String(name == null ? "" : name).trim().toLowerCase().replace(/\s+/g, " ");
}

export function tagKey(cat: string, name: unknown): string {
  return cat + " " + normalizeTagName(name);
}

export function registryKey(cat: string, name: unknown): string {
  return cat + " " + normalizeTagName(name);
}

const TAG_ID_RE = /^t_[a-z0-9]{1,16}(-[0-9]{1,6})?$/;

export function isTagId(id: unknown): id is string {
  return typeof id === "string" && TAG_ID_RE.test(id);
}

function tagKeyHash(key: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

export function mintTagId(cat: string, name: unknown, taken?: readonly (TagIdHolder | null | undefined)[] | null): string {
  const used: Record<string, boolean> = Object.create(null);
  (taken || []).forEach(function (t) { if (t && t.id) used[t.id] = true; });
  const base = "t_" + tagKeyHash(registryKey(cat, name)).slice(0, 16);
  if (!used[base]) return base;
  for (let n = 2; ; n++) if (!used[base + "-" + n]) return base + "-" + n;
}

export function ensureTagIds<T extends TagRecord | null | undefined>(registry: T[] | null | undefined): T[] | null | undefined {
  const seen: Record<string, boolean> = Object.create(null);
  const need: TagRecord[] = [];
  (registry || []).forEach(function (t) {
    if (!t) return;
    if (isTagId(t.id) && !seen[t.id]) { seen[t.id] = true; return; }
    need.push(t);
  });
  need.forEach(function (t) {
    t.id = mintTagId(t.cat, t.name, registry);
  });
  return registry;
}

export function registryTagHooks(registry: readonly (TagRecord | null | undefined)[] | null | undefined): TagHooks {
  const byKey: Record<string, TagRecord> = Object.create(null), byId: Record<string, TagRecord> = Object.create(null);
  (registry || []).forEach(function (t) {
    if (!t || !t.id || !t.name) return;
    const k = registryKey(t.cat, t.name);
    if (!byKey[k]) byKey[k] = t;
    byId[t.id] = t;
  });
  return {
    tagId: function (cat, name) {
      const t = byKey[registryKey(cat, name)];
      return t ? t.id as string : "t:" + cat + ":" + name;
    },
    tagOf: function (id) {
      const t = byId[id as string];
      if (t) return { cat: t.cat, name: t.name };
      const m = /^t:([a-z]+):([\s\S]+)$/.exec(String(id));
      return m ? { cat: m[1] as string, name: m[2] as string } : null;
    }
  };
}
