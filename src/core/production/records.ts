import { BROLL_PROP_NAME_MAX, BROLL_PROPS_MAX, brollPropKey, normalizeBrollProps } from "../document/broll.ts";
import type { IdSource } from "../document/ports.ts";
import { normalizeTagName, registryKey, tagStatusRank } from "../document/tags.ts";
import { cappedText } from "../document/text-policy.ts";
import type { DocumentShot, DocumentTag } from "../document/validated.ts";
import { brollPropsRenamed } from "./broll.ts";
import { newRegistryTag, registryEntry, registryIndex } from "./tags.ts";
import type { RegistryList, RegistryTag } from "./tags.ts";

export interface Person {
  id: string;
  name: string;
}

export interface RegistryHolder {
  readonly productionTags: RegistryList;
}

export interface PeopleHolder {
  readonly [key: string]: unknown;
}

export interface LiveRecords {
  productionTags: (DocumentTag | null | undefined)[];
  brollShots: DocumentShot[];
  [key: string]: unknown;
}

export const PERSON_NAME_MAX = 60;

export function registryEntryOf(doc: RegistryHolder | null, cat: string, name: unknown): RegistryTag | null {
  return doc ? registryEntry(doc.productionTags, cat, name) : null;
}

export function registryEntryById(doc: RegistryHolder | null, id: unknown): RegistryTag | null {
  if (!doc || !id) return null;
  for (const t of doc.productionTags) {
    if (t && t.id === id) return t;
  }
  return null;
}

export function peopleOf(doc: PeopleHolder | null): readonly Person[] {
  const people = doc ? doc["people"] : null;
  return Array.isArray(people) ? people as readonly Person[] : [];
}

export function personById(doc: PeopleHolder | null, id: unknown): Person | null {
  if (!id) return null;
  for (const p of peopleOf(doc)) {
    if (p.id === id) return p;
  }
  return null;
}

export function personNamed(doc: PeopleHolder | null, name: unknown): Person | null {
  const clean = cappedText(name, PERSON_NAME_MAX);
  if (!clean) return null;
  const norm = normalizeTagName(clean);
  for (const p of peopleOf(doc)) {
    if (normalizeTagName(p.name) === norm) return p;
  }
  return null;
}

export function brollRecord<T extends { readonly id: string }>(doc: { readonly brollShots: readonly T[] } | null, id: unknown): T | null {
  if (!doc || !id) return null;
  for (const shot of doc.brollShots) {
    if (shot.id === id) return shot;
  }
  return null;
}

function livePeople(doc: LiveRecords): Person[] {
  const people = doc["people"];
  if (!Array.isArray(people)) throw new Error("the document has no people list");
  return people as Person[];
}

export function addRegistryTag(doc: LiveRecords, cat: string, name: unknown): DocumentTag | null {
  const rec = newRegistryTag(doc.productionTags, cat, String(name == null ? "" : name));
  if (rec) doc.productionTags.push(rec);
  return rec;
}

export function removeRegistryTag(doc: LiveRecords, cat: string, name: unknown): boolean {
  const key = registryKey(cat, name);
  const before = doc.productionTags.length;
  doc.productionTags = doc.productionTags.filter(function (t) { return !t || registryKey(t.cat, t.name) !== key; });
  return before !== doc.productionTags.length;
}

export function addPerson(doc: LiveRecords, name: unknown, ids: IdSource): string {
  const clean = cappedText(name, PERSON_NAME_MAX);
  if (!clean) return "";
  const known = personNamed(doc, clean);
  if (known) return known.id;
  const person: Person = { id: ids.id("p"), name: clean };
  livePeople(doc).push(person);
  return person.id;
}

export function removePerson(doc: LiveRecords, id: string): void {
  doc["people"] = livePeople(doc).filter(function (p) { return p.id !== id; });
  doc.productionTags.forEach(function (t) { if (t && t.owner === id) t.owner = ""; });
  doc.brollShots.forEach(function (b) { if (b.owner === id) b.owner = ""; });
}

export function renameBrollProps(doc: LiveRecords, fromId: string | null | undefined, oldName: unknown, toId: string | null | undefined, toName: string): boolean {
  let changed = false;
  brollPropsRenamed(doc, fromId, oldName, toId, toName).forEach(function (c) {
    const shot = doc.brollShots[c.at];
    if (!shot || JSON.stringify(shot.props) === JSON.stringify(c.props)) return;
    shot.props = c.props;
    changed = true;
  });
  return changed;
}

export function renameRegistryTag(doc: LiveRecords, cat: string, oldName: string, newName: string): boolean {
  let merged = false;
  if (registryKey(cat, newName) !== registryKey(cat, oldName)) {
    const collision = registryEntry(doc.productionTags, cat, newName);
    const oldEntry = registryEntry(doc.productionTags, cat, oldName);
    if (collision && oldEntry && collision !== oldEntry) {
      if (!collision.owner && oldEntry.owner) collision.owner = oldEntry.owner;
      if (!collision.notes && oldEntry.notes) collision.notes = oldEntry.notes;
      if (tagStatusRank(oldEntry.status) > tagStatusRank(collision.status)) collision.status = oldEntry.status;
      const at = doc.productionTags.indexOf(oldEntry);
      if (at !== -1) doc.productionTags.splice(at, 1);
      renameBrollProps(doc, oldEntry.id, cat === "prop" ? oldEntry.name : "", collision.id, collision.name);
      merged = true;
    }
  }
  const at = registryIndex(doc.productionTags, cat, oldName);
  const entry = at === -1 ? null : doc.productionTags[at];
  if (!entry) return merged;
  const renamed = entry.name !== newName;
  entry.name = newName;
  const repointed = renameBrollProps(doc, entry.id, cat === "prop" ? oldName : "", entry.id, newName);
  return merged || renamed || repointed;
}

export function addBrollRecord(doc: LiveRecords, shot: DocumentShot): void {
  doc.brollShots.push(shot);
}

export function removeBrollRecord(doc: LiveRecords, id: string): boolean {
  const before = doc.brollShots.length;
  doc.brollShots = doc.brollShots.filter(function (r) { return r.id !== id; });
  return before !== doc.brollShots.length;
}

export function addBrollProp(doc: LiveRecords, shotId: string, rawName: unknown): boolean {
  const shot = brollRecord(doc, shotId);
  const name = cappedText(rawName, BROLL_PROP_NAME_MAX);
  if (!shot || !name) return false;
  const entry = registryEntry(doc.productionTags, "prop", name) || addRegistryTag(doc, "prop", name);
  if (!entry || !entry.id) return false;
  const props = normalizeBrollProps(shot.props, doc.productionTags);
  shot.props = props;
  const key = brollPropKey(entry.id, entry.name);
  const already = props.some(function (p) {
    return brollPropKey(p.id, p.name) === key || (!p.id && normalizeTagName(p.name) === normalizeTagName(entry.name));
  });
  if (already || props.length >= BROLL_PROPS_MAX) return false;
  props.push({ id: entry.id, name: entry.name });
  return true;
}

export function removeBrollProp(doc: LiveRecords, shotId: string, ref: string): boolean {
  const shot = brollRecord(doc, shotId);
  if (!shot || !ref || !Array.isArray(shot.props)) return false;
  const before = shot.props.length;
  shot.props = shot.props.filter(function (p) { return !p || brollPropKey(p.id || "", p.name) !== ref; });
  return shot.props.length !== before;
}
