import * as Y from "yjs";
import { BROLL_EDIT_FIELDS, BROLL_NAME_MAX, BROLL_PROP_NAME_MAX, brollCloseSource, brollUnmergedEdits, newBrollShot, normalizeBrollProps } from "../../../core/document/broll.ts";
import type { BrollUnmergedEdit } from "../../../core/document/broll.ts";
import { noFreeze } from "../../../core/document/freeze.ts";
import { ensureTagIds, isTagId, normalizeTagName, registryKey, TAG_STATUS_IDS, unmergedTagEdits } from "../../../core/document/tags.ts";
import { hasLoneSurrogate, plainText, settledNames } from "../../../core/document/text-policy.ts";
import type { DocumentShape, DocumentShot, DocumentTag, UnmergedTagEdit } from "../../../core/document/validated.ts";
import { applyBrollRecords, brollInCell, planBrollRecordsInState } from "../../../core/production/broll.ts";
import type { FieldHtml } from "../../../core/production/ports.ts";
import { createProductionReaders } from "../../../core/production/readers.ts";
import { PERSON_NAME_MAX } from "../../../core/production/records.ts";
import { missingRegistryTags } from "../../../core/production/tags.ts";
import { toPlainText } from "../../../core/text/projections.ts";
import { tagIds } from "../../../core/text/runs.ts";
import type { Run } from "../../../core/text/runs.ts";
import type { NativeRoots } from "./roots.ts";
import { NATIVE_TAG_FIELDS, nativeTagCounter, nativeTagFields, readNativeTagAlternatives } from "./tag-fields.ts";
import { sameNativeValue } from "./values.ts";

interface RegistryCellRow {
  readonly id: string;
  readonly audioText: string;
  readonly visualText: string;
  readonly narration: readonly Run[];
  readonly visual: readonly Run[];
}

export interface NativeRegistryRowInputs {
  readonly tags: boolean;
  readonly shots: boolean;
  readonly seededShots: ReadonlySet<string>;
}

type KeyedTag = DocumentTag & { id: string };

function recordIdOrder(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function addRegistryMember<T>(groups: Map<string, T | T[]>, key: string, record: T): void {
  const members = groups.get(key);
  if (Array.isArray(members)) members.push(record);
  else groups.set(key, members ? [members, record] : record);
}

function foldTags(tags: DocumentShape["productionTags"], roots: NativeRoots) {
  const byName = new Map<string, KeyedTag | KeyedTag[]>(), groups = new Map<string, readonly string[]>();
  for (const tag of tags) {
    if (!tag?.name || !isTagId(tag.id)) continue;
    addRegistryMember(byName, registryKey(tag.cat, tag.name), tag as KeyedTag);
  }
  const folded = new Map<string, DocumentTag>();
  for (const members of byName.values()) {
    if (!Array.isArray(members)) continue;
    members.sort(recordIdOrder);
    const first = members[0];
    if (!first) continue;
    const ids = Object.freeze(members.map(tag => tag.id));
    for (const id of ids) groups.set(id, ids);
    const tag = { ...first, sharedFold: true as const }, edits: UnmergedTagEdit[] = [];
    for (const field of nativeTagFields) {
      const fallback = NATIVE_TAG_FIELDS[field], values = new Set<string>(), previous = new Set<string>();
      let winner: string = fallback, highest = 0;
      for (const member of members) {
        const value = member[field] ?? fallback;
        const counter = nativeTagCounter(roots.tags.get(member.id), field);
        if (counter > highest || highest === 0 && winner === fallback && value !== fallback) {
          winner = value;
          highest = counter;
        }
        if (value && value !== fallback) values.add(value);
        for (const edit of member.unmergedEdits ?? []) if (edit.field === field) previous.add(edit.value);
      }
      tag[field] = winner;
      for (const alternative of new Set([...values, ...previous])) {
        if (alternative !== winner) edits.push({ field, value: alternative });
      }
    }
    if (edits.length) tag.unmergedEdits = edits;
    else delete tag.unmergedEdits;
    folded.set(first.id, tag);
  }
  const projected = groups.size ? tags.flatMap(tag => {
    if (!tag?.id || !groups.has(tag.id)) return [tag];
    const merged = folded.get(tag.id);
    return merged ? [merged] : [];
  }) : tags;
  const retired = [...roots.tagKeys].filter(([id]) => !roots.tags.has(id));
  if (retired.length) {
    const livingByKey = new Map<string, readonly string[]>();
    for (const tag of tags) {
      if (!tag?.id || !roots.tags.has(tag.id)) continue;
      const ids = groups.get(tag.id) ?? Object.freeze([tag.id]);
      const key = roots.tagKeys.get(tag.id) ?? registryKey(tag.cat, tag.name);
      const prior = livingByKey.get(key);
      if (!prior || String(ids[0]) < String(prior[0])) livingByKey.set(key, ids);
    }
    for (const [id, key] of retired) {
      const living = livingByKey.get(key);
      if (living) {
        groups.set(id, living);
        for (const member of living) groups.set(member, living);
      }
    }
  }
  return { tags: projected, groups };
}

function shotEditValue(shot: DocumentShot, field: BrollUnmergedEdit["field"], people: ReadonlyMap<string, string>): string {
  if (field === "owner") return people.get(shot.owner ?? "") ?? "Unassigned";
  if (field === "status") return shot.status === "shot" ? "Filmed" : "To film";
  if (field === "reshoot") return shot.reshoot === true ? "Flagged" : "Unflagged";
  if (field === "props") return shot.props?.map(prop => prop?.name).filter(Boolean).join(", ") || "None";
  return shot[field] || "None";
}

function foldShots(shots: DocumentShot[], people: DocumentShape["people"]): DocumentShot[] {
  const bySource = new Map<string, DocumentShot | DocumentShot[]>();
  for (const shot of shots) {
    const source = brollCloseSource(shot.id);
    if (source) addRegistryMember(bySource, source, shot);
  }
  const folded = new Map<string, DocumentShot>(), hidden = new Set<string>();
  let names: ReadonlyMap<string, string> | undefined;
  for (const members of bySource.values()) {
    if (!Array.isArray(members)) continue;
    names ??= new Map(people.map(person => [person.id, person.name]));
    members.sort(recordIdOrder);
    const first = members[0] as DocumentShot, edits: BrollUnmergedEdit[] = [];
    const shot = { ...first }, saved = members.flatMap(member => brollUnmergedEdits(member.unmergedEdits));
    for (const field of Object.keys(BROLL_EDIT_FIELDS) as BrollUnmergedEdit["field"][]) {
      const primary = shotEditValue(shot, field, names), values = new Set<string>();
      for (const member of members) values.add(shotEditValue(member, field, names));
      for (const edit of saved) if (edit.field === field) values.add(edit.value);
      values.delete(primary);
      for (const value of values) edits.push({ field, value });
    }
    if (edits.length) shot.unmergedEdits = edits; else delete shot.unmergedEdits;
    folded.set(first.id, shot);
    for (const member of members.slice(1)) hidden.add(member.id);
  }
  return hidden.size ? shots.filter(shot => !hidden.has(shot.id)).map(shot => folded.get(shot.id) ?? shot) : shots;
}

export function nativeRegistryProduction(rows: readonly RegistryCellRow[]) {
  const cells = new Map<string, readonly Run[]>();
  for (const row of rows) {
    cells.set(row.audioText, row.narration);
    cells.set(row.visualText, row.visual);
  }
  const cellOf = (html: FieldHtml): readonly Run[] => cells.get(html ?? "") ?? [];
  return { readers: createProductionReaders(cellOf, noFreeze), plainTextOf: (html: FieldHtml) => toPlainText(cellOf(html)) };
}

function tagsInCellChanged(previousHtml: string, html: string, previous: readonly Run[], runs: readonly Run[]): boolean {
  if (previousHtml === html) return false;
  const hasTags = (cell: readonly Run[]) => cell.some(({ marks }) => marks.tag || marks.innerTags?.length || marks.cue);
  if (!hasTags(previous) && !hasTags(runs)) return false;
  const readers = createProductionReaders(value => value === previousHtml ? previous : runs, noFreeze);
  const names = (value: string) => readers.tagsInField(value).map(({ catId, name }) => [catId, name]);
  return !sameNativeValue(names(previousHtml), names(html)) || !sameNativeValue(tagIds(previous), tagIds(runs));
}

export function nativeRegistryRowChanged(inputs: NativeRegistryRowInputs, previous: RegistryCellRow, row: RegistryCellRow): boolean {
  if (inputs.shots) {
    if (previous.visualText !== row.visualText && (brollInCell(previous.visual).length || brollInCell(row.visual).length)) return true;
    if (previous.audioText !== row.audioText && row.visual.some(run => run.atom === "broll" && inputs.seededShots.has(run.id))) return true;
  }
  return inputs.tags && (tagsInCellChanged(previous.audioText, row.audioText, previous.narration, row.narration)
    || tagsInCellChanged(previous.visualText, row.visualText, previous.visual, row.visual));
}

export function nativeTagNamesInRows(rows: readonly RegistryCellRow[]): ReadonlySet<string> {
  const { readers } = nativeRegistryProduction(rows);
  return new Set(missingRegistryTags(rows, [], readers).map(tag => registryKey(tag.cat, tag.name)));
}

export function nativeShotLinePlan(document: DocumentShape, rows: readonly RegistryCellRow[]) {
  const { readers, plainTextOf } = nativeRegistryProduction(rows);
  return planBrollRecordsInState(document, readers, { id: () => "", docId: () => document.docId }, plainTextOf, () => false);
}

function hasRemoved(root: Y.Map<Y.Map<unknown>>): boolean {
  for (const record of root.values()) if (record instanceof Y.Map && record.get("removed") === true) return true;
  return false;
}

function repairNames<T extends { name?: string | undefined }>(entries: T[], max: number, keyOf: (name: string, entry: T) => string): T[] {
  if (!entries.some(entry => entry.name && hasLoneSurrogate(entry.name))) return entries;
  const names = settledNames(entries.map(entry => plainText(entry.name)), max, (name, at) => keyOf(name, entries[at] as T));
  return entries.filter((entry, at) => {
    entry.name = names[at];
    return !!entry.name;
  });
}

function propNormalizer(tags: DocumentShape["productionTags"]) {
  const byId = new Map<string, DocumentTag>(), byName = new Map<string, DocumentTag>(), position = new Map<DocumentTag, number>();
  tags.forEach((tag, at) => {
    if (!tag?.id || !tag.name) return;
    position.set(tag, at);
    byId.set(tag.id, tag);
    const name = normalizeTagName(tag.name);
    if (tag.cat === "prop" && !byName.has(name)) byName.set(name, tag);
  });
  return (props: unknown) => {
    const relevant = new Set<DocumentTag>();
    const items = (Array.isArray(props) ? props as unknown[] : []).flatMap(prop => typeof prop === "string" ? [{ name: prop, id: undefined }]
      : prop && typeof prop === "object" ? [prop as { id?: unknown; name?: unknown }] : []);
    const names = items.some(prop => !isTagId(prop.id))
      ? settledNames(items.map(prop => plainText(prop.name)), BROLL_PROP_NAME_MAX, normalizeTagName) : [];
    // why: the core normalizer only needs tags reachable by a prop ID or by the first match for an idless name
    for (const [at, prop] of items.entries()) {
      const alias = isTagId(prop.id) ? undefined : byName.get(normalizeTagName(names[at]));
      if (alias) relevant.add(alias);
      const id = isTagId(prop.id) ? prop.id : alias?.id;
      const tag = id ? byId.get(id) : undefined;
      if (tag) relevant.add(tag);
    }
    return [...relevant].sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
  };
}

function hydrateTagAlternatives(tag: DocumentTag, tags: NativeRoots["tags"]): void {
  const record = tag.id ? tags.get(tag.id) : undefined;
  const edits = record instanceof Y.Map ? readNativeTagAlternatives(record, tag.unmergedEdits) : unmergedTagEdits(tag.unmergedEdits);
  if (edits.length) tag.unmergedEdits = edits;
  else delete tag.unmergedEdits;
}

export function projectNativeTags(stored: DocumentShape["productionTags"], roots: NativeRoots, people: ReadonlySet<string>) {
  const tagsRemoved = hasRemoved(roots.tags) || stored.some(tag => tag && !tag.name);
  if (tagsRemoved) {
    stored = repairNames(stored.filter((tag): tag is DocumentTag => !!tag?.name), 80, (name, tag) => registryKey(tag.cat, name));
    ensureTagIds(stored);
  }
  for (const tag of stored) {
    if (!tag) continue;
    if (tag.owner && !people.has(tag.owner)) tag.owner = "";
    hydrateTagAlternatives(tag, roots.tags);
  }
  const { tags, groups } = foldTags(stored, roots);
  let lookup: ReturnType<typeof propNormalizer> | undefined;
  return { stored, tags, groups, tagsRemoved, propLookup: () => lookup ??= propNormalizer(tags),
    published: tags.flatMap(tag => tag?.name ? [{ owner: "", notes: "", status: TAG_STATUS_IDS[0], ...tag }] : []) };
}

export function projectNativeRegistries(document: DocumentShape, roots: NativeRoots, rows: () => readonly RegistryCellRow[],
  projectTags: (stored: DocumentShape["productionTags"], people: ReadonlySet<string>) => ReturnType<typeof projectNativeTags>
    = (stored, people) => projectNativeTags(stored, roots, people)) {
  const shotsRemoved = hasRemoved(roots.shots) || document.brollShots.some(shot => !shot.name);
  const seededShots = new Set<string>();
  document.people = document.people.filter(person => !!person.name);
  document.brollShots = document.brollShots.flatMap(shot => shot.name ? [{ ...newBrollShot(shot.id, {}), ...shot }] : []);
  if (hasRemoved(roots.people)) document.people = repairNames(document.people, PERSON_NAME_MAX, normalizeTagName);
  const people = new Set(document.people.map(person => person.id));
  const { stored, tags, groups, tagsRemoved, propLookup, published } = projectTags(document.productionTags, people);
  let derived: DocumentTag[] = [];
  if (shotsRemoved) document.brollShots = repairNames(document.brollShots, BROLL_NAME_MAX, normalizeTagName);
  if (tagsRemoved || shotsRemoved) {
    const visible = rows();
    if (tagsRemoved) {
      const { readers } = nativeRegistryProduction(visible);
      derived = missingRegistryTags(document.rows, stored, readers);
      if (derived.length) {
        ensureTagIds([...stored, ...derived]);
        for (const tag of derived) hydrateTagAlternatives(tag, roots.tags);
      }
    }
    // why: a surviving keyed line seeds its default shot on core reload; unkeyed lines have their own command path
    if (shotsRemoved) {
      const plan = nativeShotLinePlan(document, visible);
      for (const shot of plan.create) seededShots.add(shot.id);
      applyBrollRecords(document.brollShots, plan);
    }
  }
  for (const shot of document.brollShots) {
    if (shot.owner && !people.has(shot.owner)) shot.owner = "";
  }
  if (document.brollShots.some(shot => shot.props?.length)) {
    const relevantTags = derived.length ? propNormalizer([...tags, ...derived]) : propLookup();
    for (const shot of document.brollShots) {
      if (!shot.props?.length) continue;
      const props = groups.size ? shot.props.map(prop => {
        const id = prop?.id ? groups.get(prop.id)?.[0] : undefined;
        return id && prop?.id !== id ? { ...prop, id } : prop;
      }) : shot.props;
      shot.props = normalizeBrollProps(props, relevantTags(props));
    }
  }
  document.brollShots = foldShots(document.brollShots, document.people);
  document.productionTags = derived.length ? [...published, ...derived] : published;
  return { inputs: { tags: tagsRemoved, shots: shotsRemoved, seededShots }, groups };
}
