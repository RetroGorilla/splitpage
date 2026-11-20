import * as Y from "yjs";
import { BROLL_NAME_MAX, BROLL_PROP_NAME_MAX, newBrollShot, normalizeBrollProps } from "../../../core/document/broll.ts";
import { noFreeze } from "../../../core/document/freeze.ts";
import { ensureTagIds, isTagId, normalizeTagName, registryKey, TAG_STATUS_IDS } from "../../../core/document/tags.ts";
import { hasLoneSurrogate, plainText, settledNames } from "../../../core/document/text-policy.ts";
import type { DocumentShape, DocumentTag } from "../../../core/document/validated.ts";
import { applyBrollRecords, planBrollRecordsInState } from "../../../core/production/broll.ts";
import type { FieldHtml } from "../../../core/production/ports.ts";
import { createProductionReaders } from "../../../core/production/readers.ts";
import { PERSON_NAME_MAX } from "../../../core/production/records.ts";
import { missingRegistryTags } from "../../../core/production/tags.ts";
import { toPlainText } from "../../../core/text/projections.ts";
import type { Run } from "../../../core/text/runs.ts";
import type { NativeRoots } from "./roots.ts";

interface RegistryCellRow {
  readonly id: string;
  readonly audioText: string;
  readonly visualText: string;
  readonly narration: readonly Run[];
  readonly visual: readonly Run[];
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
    return normalizeBrollProps(props, [...relevant].sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0)));
  };
}

export function projectNativeRegistries(document: DocumentShape, roots: NativeRoots, rows: () => readonly RegistryCellRow[]): void {
  const tagsRemoved = hasRemoved(roots.tags) || document.productionTags.some(tag => tag && !tag.name);
  const shotsRemoved = hasRemoved(roots.shots) || document.brollShots.some(shot => !shot.name);
  document.people = document.people.filter(person => !!person.name);
  document.productionTags = document.productionTags.flatMap(tag => tag?.name ? [{ owner: "", notes: "", status: TAG_STATUS_IDS[0], ...tag }] : []);
  document.brollShots = document.brollShots.flatMap(shot => shot.name ? [newBrollShot(shot.id, shot)] : []);
  if (hasRemoved(roots.people)) document.people = repairNames(document.people, PERSON_NAME_MAX, normalizeTagName);
  if (tagsRemoved) document.productionTags = repairNames(document.productionTags.filter(tag => !!tag), 80, (name, tag) => registryKey(tag.cat, name));
  if (shotsRemoved) document.brollShots = repairNames(document.brollShots, BROLL_NAME_MAX, normalizeTagName);
  if (tagsRemoved || shotsRemoved) {
    const visible = rows();
    if (tagsRemoved) {
      const { readers } = production(visible);
      document.productionTags.push(...missingRegistryTags(document.rows, document.productionTags, readers));
      ensureTagIds(document.productionTags);
    }
    // why: a surviving keyed line seeds its default shot on core reload; unkeyed lines have their own command path
    if (shotsRemoved) applyBrollRecords(document.brollShots, nativeShotLinePlan(document, visible));
  }
  const people = new Set(document.people.map(person => person.id));
  for (const record of [...document.productionTags, ...document.brollShots]) {
    if (record?.owner && !people.has(record.owner)) record.owner = "";
  }
  if (!document.brollShots.some(shot => shot.props?.length)) return;
  const normalize = propNormalizer(document.productionTags);
  for (const shot of document.brollShots) if (shot.props?.length) shot.props = normalize(shot.props);
}
