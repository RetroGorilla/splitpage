import { ROW_STATUS_IDS } from "../document/timing.ts";
import type { RowStatusId } from "../document/timing.ts";
import { TAG_CATEGORY_IDS, TAG_STATUS_IDS } from "../document/tags.ts";
import type { TagCategoryId, TagStatusId } from "../document/tags.ts";

export interface RowStatusLook {
  id: RowStatusId;
  label: string;
  cls: string;
  color: string;
}

const ROW_STATUS_LOOKS: Record<RowStatusId, { label: string; cls: string; color: string }> = {
  todo: { label: "To do", cls: "is-open", color: "var(--text-faint)" },
  ready: { label: "Ready", cls: "is-half", color: "var(--audio)" },
  shot: { label: "Shot", cls: "", color: "var(--text)" }
};

export const ROW_STATUSES: readonly RowStatusLook[] = ROW_STATUS_IDS.map(function (id) {
  const look = ROW_STATUS_LOOKS[id];
  return { id: id, label: look.label, cls: look.cls, color: look.color };
});

export function rowStatus(id: unknown): RowStatusLook | null {
  for (let i = 0; i < ROW_STATUSES.length; i++) {
    const status = ROW_STATUSES[i];
    if (status && status.id === id) return status;
  }
  return null;
}

export interface TagCategoryLook {
  id: TagCategoryId;
  label: string;
  plural: string;
  color: string;
  icon: string;
}

const TAG_ICON_PATHS: Record<TagCategoryId, string> = {
  prop: '<path d="M20.5 7.5L12 3 3.5 7.5v9L12 21l8.5-4.5z"/><path d="M3.5 7.5L12 12l8.5-4.5M12 12v9"/>',
  location: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.25"/>',
  cast: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  vfx: '<path d="M11 3c.6 4.6 2.4 6.4 7 7-4.6.6-6.4 2.4-7 7-.6-4.6-2.4-6.4-7-7 4.6-.6 6.4-2.4 7-7z"/><path d="M19 15.5v5M16.5 18h5"/>',
  sound: '<path d="M9 18V5.5l11-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  gear: '<rect x="3" y="6.5" width="12.5" height="11" rx="2"/><path d="M15.5 10.5l5-3v9l-5-3z"/>'
};

const TAG_CATEGORY_LOOKS: Record<TagCategoryId, { label: string; plural: string; color: string; icon: string }> = {
  prop: { label: "Prop", plural: "Props & set dressing", color: "var(--tag-prop)", icon: TAG_ICON_PATHS.prop },
  location: { label: "Location", plural: "Locations & shots", color: "var(--tag-location)", icon: TAG_ICON_PATHS.location },
  cast: { label: "Cast", plural: "Cast & wardrobe", color: "var(--tag-cast)", icon: TAG_ICON_PATHS.cast },
  vfx: { label: "VFX", plural: "VFX & graphics", color: "var(--tag-vfx)", icon: TAG_ICON_PATHS.vfx },
  sound: { label: "Music/SFX", plural: "Music & SFX", color: "var(--tag-sound)", icon: TAG_ICON_PATHS.sound },
  gear: { label: "Gear", plural: "Gear", color: "var(--tag-gear)", icon: TAG_ICON_PATHS.gear }
};

export const TAG_CATEGORIES: readonly TagCategoryLook[] = TAG_CATEGORY_IDS.map(function (id) {
  const look = TAG_CATEGORY_LOOKS[id];
  return { id: id, label: look.label, plural: look.plural, color: look.color, icon: look.icon };
});

export function tagCategory(id: unknown): TagCategoryLook | null {
  for (let i = 0; i < TAG_CATEGORIES.length; i++) {
    const cat = TAG_CATEGORIES[i];
    if (cat && cat.id === id) return cat;
  }
  return null;
}

export interface TagStatusLook {
  id: TagStatusId;
  label: string;
  color: string;
}

const TAG_STATUS_LOOKS: Record<TagStatusId, { label: string; color: string }> = {
  needed: { label: "Needed", color: "var(--text-faint)" },
  sourcing: { label: "Sourcing", color: "var(--audio)" },
  have: { label: "Have it", color: "var(--text)" },
  returned: { label: "Returned", color: "var(--text-faint)" }
};

export const TAG_STATUSES: readonly TagStatusLook[] = TAG_STATUS_IDS.map(function (id) {
  const look = TAG_STATUS_LOOKS[id];
  return { id: id, label: look.label, color: look.color };
});

export function tagStatus(id: unknown): TagStatusLook | null {
  for (let i = 0; i < TAG_STATUSES.length; i++) {
    const status = TAG_STATUSES[i];
    if (status && status.id === id) return status;
  }
  return null;
}

export interface CategorisedTag {
  cat: { id: string };
  orphaned?: boolean | undefined;
  mentions: readonly unknown[];
  name: string;
}

export function groupTagsByCategory<T extends CategorisedTag>(all: readonly T[]): { cat: TagCategoryLook; items: T[] }[] {
  return TAG_CATEGORIES.map(function (cat) {
    const items = all.filter(function (t) { return t.cat.id === cat.id; });
    items.sort(function (a, b) {
      if (!!a.orphaned !== !!b.orphaned) return a.orphaned ? 1 : -1;
      if (b.mentions.length !== a.mentions.length) return b.mentions.length - a.mentions.length;
      return a.name.localeCompare(b.name);
    });
    return { cat: cat, items: items };
  }).filter(function (g) { return g.items.length; });
}
