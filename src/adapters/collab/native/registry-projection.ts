import * as Y from "yjs";
import { BROLL_NAME_MAX, BROLL_PROP_NAME_MAX, newBrollShot, normalizeBrollProps } from "../../../core/document/broll.ts";
import { noFreeze } from "../../../core/document/freeze.ts";
import { ensureTagIds, isTagId, normalizeTagName, registryKey, TAG_STATUS_IDS, unmergedTagEdits } from "../../../core/document/tags.ts";
import { hasLoneSurrogate, plainText, settledNames } from "../../../core/document/text-policy.ts";
import type { DocumentShape, DocumentTag, UnmergedTagEdit } from "../../../core/document/validated.ts";
import { applyBrollRecords, brollInCell, planBrollRecordsInState } from "../../../core/production/broll.ts";
import type { FieldHtml } from "../../../core/production/ports.ts";
import { createProductionReaders } from "../../../core/production/readers.ts";
import { PERSON_NAME_MAX } from "../../../core/production/records.ts";
import { missingRegistryTags } from "../../../core/production/tags.ts";
import { toPlainText } from "../../../core/text/projections.ts";
import { tagIds } from "../../../core/text/runs.ts";
import type { Run } from "../../../core/text/runs.ts";
import type { NativeRoots } from "./roots.ts";
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

function foldTags(tags: DocumentShape["productionTags"]) {
  const byName = new Map<string, KeyedTag | KeyedTag[]>(), groups = new Map<string, readonly string[]>();
  for (const tag of tags) {
    if (!tag?.name || !isTagId(tag.id)) continue;
    const key = registryKey(tag.cat, tag.name), members = byName.get(key);
    const member = tag as KeyedTag;
    if (Array.isArray(members)) members.push(member);
    else byName.set(key, members ? [members, member] : member);
  }
  const folded = new Map<string, DocumentTag>();
  for (const members of byName.values()) {
    if (!Array.isArray(members)) continue;
    members.sort((a, b) => a.id < b.id ? -1 : 1);
    const first = members[0];
    if (!first) continue;
    const ids = Object.freeze(members.map(tag => tag.id));
    for (const id of ids) groups.set(id, ids);
    const tag = { ...first }, edits: UnmergedTagEdit[] = [];
    for (const [field, fallback] of [["notes", ""], ["owner", ""], ["status", TAG_STATUS_IDS[0]]] as const) {
      const values = new Set<string>(), previous = new Set<string>();
      for (const member of members) {
        const value = member[field];
        if (value && value !== fallback) values.add(value);
        for (const edit of member.unmergedEdits ?? []) if (edit.field === field) previous.add(edit.value);
      }
      const [value, ...remaining] = values;
      if (value) tag[field] = value;
      for (const alternative of new Set([...remaining, ...previous])) {
        if (alternative !== tag[field]) edits.push({ field, value: alternative });
      }
    }
    if (edits.length) tag.unmergedEdits = edits;
    else delete tag.unmergedEdits;
    folded.set(first.id, tag);
  }
  return { tags: groups.size ? tags.flatMap(tag => {
    if (!tag?.id || !groups.has(tag.id)) return [tag];
    const merged = folded.get(tag.id);
    return merged ? [merged] : [];
  }) : tags, groups };
}

function production(rows: readonly RegistryCellRow[]) {
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
  const { readers } = production(rows);
  return new Set(missingRegistryTags(rows, [], readers).map(tag => registryKey(tag.cat, tag.name)));
}

export function nativeShotLinePlan(document: DocumentShape, rows: readonly RegistryCellRow[]) {
  const { readers, plainTextOf } = production(rows);
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

export function projectNativeRegistries(document: DocumentShape, roots: NativeRoots, rows: () => readonly RegistryCellRow[]) {
  const tagsRemoved = hasRemoved(roots.tags) || document.productionTags.some(tag => tag && !tag.name);
  const shotsRemoved = hasRemoved(roots.shots) || document.brollShots.some(shot => !shot.name);
  const seededShots = new Set<string>();
  document.people = document.people.filter(person => !!person.name);
  document.brollShots = document.brollShots.flatMap(shot => shot.name ? [{ ...newBrollShot(shot.id, {}), ...shot }] : []);
  if (hasRemoved(roots.people)) document.people = repairNames(document.people, PERSON_NAME_MAX, normalizeTagName);
  if (tagsRemoved) {
    const named = document.productionTags.filter((tag): tag is DocumentTag => !!tag?.name);
    document.productionTags = repairNames(named, 80, (name, tag) => registryKey(tag.cat, name));
  }
  if (shotsRemoved) document.brollShots = repairNames(document.brollShots, BROLL_NAME_MAX, normalizeTagName);
  if (tagsRemoved || shotsRemoved) {
    const visible = rows();
    if (tagsRemoved) {
      const { readers } = production(visible);
      document.productionTags.push(...missingRegistryTags(document.rows, document.productionTags, readers));
      ensureTagIds(document.productionTags);
    }
    // why: a surviving keyed line seeds its default shot on core reload; unkeyed lines have their own command path
    if (shotsRemoved) {
      const plan = nativeShotLinePlan(document, visible);
      for (const shot of plan.create) seededShots.add(shot.id);
      applyBrollRecords(document.brollShots, plan);
    }
  }
  const people = new Set(document.people.map(person => person.id));
  for (const record of [...document.productionTags, ...document.brollShots]) {
    if (record?.owner && !people.has(record.owner)) record.owner = "";
  }
  for (const tag of document.productionTags) {
    if (!tag || !Object.hasOwn(tag, "unmergedEdits")) continue;
    const edits = unmergedTagEdits(tag.unmergedEdits);
    if (edits.length) tag.unmergedEdits = edits;
    else delete tag.unmergedEdits;
  }
  const { tags, groups } = foldTags(document.productionTags);
  document.productionTags = tags;
  if (document.brollShots.some(shot => shot.props?.length)) {
    const relevantTags = propNormalizer(document.productionTags);
    for (const shot of document.brollShots) {
      if (!shot.props?.length) continue;
      const props = groups.size ? shot.props.map(prop => {
        const id = prop?.id ? groups.get(prop.id)?.[0] : undefined;
        return id && prop?.id !== id ? { ...prop, id } : prop;
      }) : shot.props;
      shot.props = normalizeBrollProps(props, relevantTags(props));
    }
  }
  document.productionTags = tags.flatMap(tag => tag?.name ? [{ owner: "", notes: "", status: TAG_STATUS_IDS[0], ...tag }] : []);
  return { inputs: { tags: tagsRemoved, shots: shotsRemoved, seededShots }, groups };
}
