import * as Y from "yjs";
import { BROLL_NAME_MAX, BROLL_PROPS_MAX, BROLL_PROP_NAME_MAX, BROLL_TEXT_MAX, brollStatusId, newBrollShot, normalizeBrollProps } from "../../../core/document/broll.ts";
import type { BrollProp } from "../../../core/document/broll.ts";
import { isTagId, nextTagStatus, normalizeTagName, registryKey, TAG_STATUS_IDS, tagCategoryId, tagStatusId } from "../../../core/document/tags.ts";
import { cappedLongText, cappedText, plainText } from "../../../core/document/text-policy.ts";
import type { DocumentShape, DocumentTag } from "../../../core/document/validated.ts";
import { PERSON_NAME_MAX } from "../../../core/production/records.ts";
import { compareNativeRankedIds, isValidNativeRank, nativeRankBetween } from "./rank.ts";
import { copyArgument, copyRecordValue, nativeRecordId, RECORD_UNCHANGED, RECORD_WRITTEN, refuseRecord } from "./record-values.ts";
import type { NativeRecordOutcome } from "./record-values.ts";
import { nativeShotLinePlan, nativeTagNamesInRows } from "./registry-projection.ts";
import { transactPreparedNativeCommand } from "./script.ts";
import type { NativeScript } from "./script.ts";
import { prepareNativeShotProps } from "./shot-prop-commands.ts";
import { NATIVE_SHOT_PROPS, newNativeShotProps } from "./shot-props.ts";
import { nativeWriteAvailability } from "./text-commands.ts";
import { decodeNativeValue, encodeNativeValue, mintNativeId, mintNativeTagId, nativeFieldKey, recordBag, sameNativeValue } from "./values.ts";

type Collection = "people" | "tags" | "shots";
type Fields = Readonly<Record<string, unknown>>;
type Root = Y.Map<Y.Map<unknown>>;
type RecordMap = Y.Map<unknown>;
type Write = () => void;
type Refused = Extract<NativeRecordOutcome, { kind: "refused" }>;
type Result = NativeRecordOutcome | { readonly kind: "written"; readonly created: string };

export type NativeRegistryChange =
  | { readonly kind: "create"; readonly collection: Collection; readonly fields: Fields; readonly ownerName?: string }
  | { readonly kind: "set"; readonly collection: Collection; readonly ids: readonly string[]; readonly fields: Fields; readonly ownerName?: string }
  | { readonly kind: "updateTags"; readonly tags: readonly { readonly cat: string; readonly name: string }[]; readonly fields: Fields;
      readonly ownerName?: string; readonly cycle?: true }
  | { readonly kind: "cycleTagStatus"; readonly ids: readonly string[] }
  | { readonly kind: "remove" | "restore"; readonly collection: Collection; readonly ids: readonly string[] }
  | { readonly kind: "move"; readonly collection: Collection; readonly id: string; readonly before: string | null }
  | { readonly kind: "addProp" | "removeProp"; readonly id: string; readonly prop: string }
  | { readonly kind: "moveProp"; readonly id: string; readonly prop: string; readonly before: string | null }
  | { readonly kind: "gear"; readonly names: readonly string[] };

interface Slot { readonly id: string; readonly map: RecordMap; readonly rank: string | null }

function collectionOf(value: unknown): Collection | null {
  return value === "people" || value === "tags" || value === "shots" ? value : null;
}

function trimmed(value: unknown, max: number): value is string {
  return typeof value === "string" && value !== "" && cappedText(value, max) === value;
}

function listOf(value: unknown, check: (entry: unknown) => entry is string): readonly string[] | null {
  if (!Array.isArray(value) || !value.every(check) || new Set(value).size !== value.length) return null;
  return value;
}

function target(root: Root, id: string, removed = false): RecordMap | Refused {
  const map = root.get(id);
  if (!root.has(id)) return refuseRecord("missing");
  if (!(map instanceof Y.Map)) return refuseRecord("stored");
  const mark = map.get("removed");
  if (map.has("removed") && mark !== true) return refuseRecord("stored");
  if ((mark === true) !== removed) return refuseRecord("missing");
  return map;
}

function slots(root: Root, keepRemoved: boolean): Slot[] | null {
  const entries: Slot[] = [];
  for (const [id, map] of root) {
    if (!(map instanceof Y.Map)) return null;
    if (map.get("removed") === true && !keepRemoved) continue;
    let rank: string | null = null;
    if (map.has("rank")) {
      const value = map.get("rank");
      if (!isValidNativeRank(value)) return null;
      rank = value;
    }
    entries.push({ id, map, rank });
  }
  return entries.sort((a, b) => compareNativeRankedIds(a.id, a.rank, b.id, b.rank));
}

function stored(map: RecordMap, field: string, missing?: unknown): unknown {
  const key = nativeFieldKey(field);
  return map.has(key) ? decodeNativeValue(map.get(key))?.value : missing;
}

function finish(writes: readonly Write[], created?: string): Result {
  for (const write of writes) write();
  return created ? { kind: "written", created } : writes.length ? RECORD_WRITTEN : RECORD_UNCHANGED;
}

function planFields(writes: Write[], map: RecordMap, fields: Fields): boolean {
  for (const [field, value] of Object.entries(fields)) {
    const key = nativeFieldKey(field), prior = decodeNativeValue(map.get(key));
    if (map.has(key) && !prior) return false;
    if (prior && sameNativeValue(prior.value, value)) continue;
    const encoded = encodeNativeValue(value);
    writes.push(() => { map.set(key, encoded); });
  }
  return true;
}

function append(writes: Write[], root: Root, id: string, fields: Fields, rank: string, props?: readonly BrollProp[]): void {
  const entries = Object.entries(fields).map(([key, value]) => [nativeFieldKey(key), encodeNativeValue(value)] as const);
  writes.push(() => {
    const map = new Y.Map<unknown>();
    root.set(id, map);
    map.set("rank", rank);
    for (const [key, value] of entries) map.set(key, value);
    if (props) map.set(NATIVE_SHOT_PROPS, newNativeShotProps(props));
  });
}

function planNew(script: NativeScript, writes: Write[], collection: Collection, fields: Fields): string | Refused {
  const root = script.roots[collection], order = slots(root, true);
  if (!order) return refuseRecord("stored");
  const id = collection === "tags" ? mintNativeTagId(script.doc) : mintNativeId(script.doc, collection === "people" ? "p" : "bs");
  if (root.has(id)) return refuseRecord("taken");
  const rank = nativeRankBetween(order.at(-1)?.rank ?? null, null);
  if (collection === "shots") {
    const { props, ...ordinary } = fields;
    append(writes, root, id, ordinary, rank, props as BrollProp[]);
  } else append(writes, root, id, fields, rank);
  return id;
}

function tagAppender(script: NativeScript, writes: Write[], last: string | null): (fields: Fields) => Refused | null {
  const root = script.roots.tags;
  let rank = last, offset = 0;
  return fields => {
    const id = mintNativeTagId(script.doc, offset++);
    if (root.has(id)) return refuseRecord("taken");
    rank = nativeRankBetween(rank, null);
    append(writes, root, id, fields, rank);
    return null;
  };
}

function namedTag(document: DocumentShape, cat: unknown, name: unknown): DocumentTag | undefined {
  return document.productionTags.find(tag => tag?.cat === cat && normalizeTagName(tag?.name) === normalizeTagName(name)) ?? undefined;
}

function projectedTagIds(script: NativeScript, document: DocumentShape): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const tag of document.productionTags) if (tag?.id) {
    const map = script.roots.tags.get(tag.id);
    if (!(map instanceof Y.Map) || map.get("removed") === true) ids.add(tag.id);
  }
  return ids;
}

function defaults(collection: Collection): Fields {
  if (collection === "people") return {};
  if (collection === "tags") return { owner: "", notes: "", status: "needed" };
  return Object.fromEntries(Object.entries(newBrollShot("", { origin: "list" })).filter(([field]) => field !== "id"));
}

function allowed(script: NativeScript, collection: Collection, fields: Fields, document: DocumentShape, creating: boolean): boolean {
  for (const [key, value] of Object.entries(fields)) {
    if (key === "name" && trimmed(value, collection === "people" ? PERSON_NAME_MAX : collection === "tags" ? 80 : BROLL_NAME_MAX)) continue;
    if (collection === "people") return false;
    if (key === "owner" && (value === "" || document.people.some(person => person.id === value))) continue;
    if (key === "notes" && typeof value === "string" && cappedLongText(plainText(value), BROLL_TEXT_MAX) === value) continue;
    if (collection === "tags") {
      if (key === "cat" && creating && tagCategoryId(value) || key === "status" && tagStatusId(value)) continue;
      return false;
    }
    if (key === "status" && brollStatusId(value) || key === "reshoot" && typeof value === "boolean") continue;
    if (key === "origin" && creating && (value === "list" || value === "script")) continue;
    if (key === "location" && typeof value === "string" && cappedText(value, 80) === value) continue;
    if ((key === "desc" || key === "audioRef") && typeof value === "string" && cappedLongText(plainText(value), BROLL_TEXT_MAX) === value) continue;
    if (key === "props" && Array.isArray(value)) {
      const normalized = normalizeBrollProps(value, document.productionTags), projected = projectedTagIds(script, document);
      if (sameNativeValue(value, normalized) && normalized.every(prop => !projected.has(prop.id))) continue;
    }
    return false;
  }
  return true;
}

function ownerFields(script: NativeScript, writes: Write[], fields: Fields, name: unknown, document: DocumentShape): Fields | Refused {
  if (!trimmed(name, PERSON_NAME_MAX) || Object.hasOwn(fields, "owner")) return refuseRecord("value");
  const known = document.people.find(person => normalizeTagName(person.name) === normalizeTagName(name));
  const id = known?.id ?? planNew(script, writes, "people", { name });
  return typeof id === "string" ? { ...fields, owner: id } : id;
}

function shotFieldsSurvive(script: NativeScript, document: DocumentShape, ids: ReadonlySet<string>): boolean {
  const plan = nativeShotLinePlan(document, script.reader.rows());
  return !plan.rename.some(change => ids.has(document.brollShots[change.at]?.id ?? ""));
}

function create(script: NativeScript, collection: Collection, request: Fields, ownerName: unknown): Result {
  const document = script.reader.document();
  if (!Object.hasOwn(request, "name") || collection === "tags" && !Object.hasOwn(request, "cat") ||
      !allowed(script, collection, request, document, true) || collection === "people" && ownerName !== undefined) return refuseRecord("value");
  if (collection === "people" && document.people.some(person => normalizeTagName(person.name) === normalizeTagName(request.name)) ||
      collection === "tags" && namedTag(document, request.cat, request.name)) return RECORD_UNCHANGED;
  const writes: Write[] = [], fields = { ...defaults(collection), ...request };
  const owned = ownerName === undefined ? fields : ownerFields(script, writes, request, ownerName, document);
  if ("kind" in owned) return owned as Refused;
  const id = planNew(script, writes, collection, { ...fields, ...owned });
  if (typeof id !== "string") return id;
  if (collection === "shots" && !shotFieldsSurvive(script, { ...document, brollShots: [...document.brollShots, newBrollShot(id, { ...fields, ...owned })] }, new Set([id]))) {
    return refuseRecord("value");
  }
  return finish(writes, id);
}

function checkRename(script: NativeScript, collection: Collection, map: RecordMap, id: string, fields: Fields, document: DocumentShape): Refused | null {
  const name = stored(map, "name", "");
  if (typeof name !== "string") return refuseRecord("stored");
  if (collection === "shots" || !("name" in fields) || fields.name === name) return null;
  if (collection === "people") return document.people.some(person => person.id !== id && normalizeTagName(person.name) === normalizeTagName(fields.name))
    ? refuseRecord("value") : null;
  const cat = stored(map, "cat"), next = namedTag(document, cat, fields.name);
  if (!tagCategoryId(cat)) return refuseRecord("stored");
  if (next && next.id !== id || nativeTagNamesInRows(script.reader.rows()).has(registryKey(String(cat), name))) return refuseRecord("value");
  return null;
}

function set(script: NativeScript, collection: Collection, ids: readonly string[], request: Fields, ownerName?: unknown, cycle = false): Result {
  const document = script.reader.document(), writes: Write[] = [];
  if (!allowed(script, collection, request, document, false) || collection === "people" && ownerName !== undefined) return refuseRecord("value");
  if (!ids.length) return RECORD_UNCHANGED;
  if (ids.length > 1 && "name" in request) return refuseRecord("value");
  if (collection === "shots" && ("name" in request || "desc" in request)) {
    const selected = new Set(ids);
    const shots = document.brollShots.map(shot => selected.has(shot.id) ? { ...shot, ...request } : shot);
    if (!shotFieldsSurvive(script, { ...document, brollShots: shots }, selected)) return refuseRecord("value");
  }
  const owned = ownerName === undefined ? request : ownerFields(script, writes, request, ownerName, document);
  if ("kind" in owned) return owned as Refused;
  for (const id of ids) {
    const map = target(script.roots[collection], id);
    if (!(map instanceof Y.Map)) return map;
    const rename = checkRename(script, collection, map, id, owned, document);
    if (rename) return rename;
    const before = cycle ? stored(map, "status", TAG_STATUS_IDS[0]) : undefined;
    if (cycle && !tagStatusId(before)) return refuseRecord("stored");
    const { props, ...ordinary } = owned;
    if (!planFields(writes, map, cycle ? { status: nextTagStatus(before) } : ordinary)) return refuseRecord("stored");
    if (props !== undefined) {
      const list = prepareNativeShotProps(map, document.productionTags);
      if (!list) return refuseRecord("stored");
      if (!list.replace(writes, props as BrollProp[])) return refuseRecord("value");
    }
  }
  return finish(writes);
}

function updateTags(script: NativeScript, tags: unknown, fields: unknown, ownerName: unknown, cycle: unknown): Result {
  if (!Array.isArray(tags) || !recordBag(fields) || cycle !== undefined && cycle !== true ||
      Object.hasOwn(fields, "name") || cycle && Object.hasOwn(fields, "status")) return refuseRecord("value");
  const document = script.reader.document(), writes: Write[] = [], identities = new Set<string>();
  if (!allowed(script, "tags", fields, document, false)) return refuseRecord("value");
  if (!tags.length) return RECORD_UNCHANGED;
  const owned = ownerName === undefined ? fields : ownerFields(script, writes, fields, ownerName, document);
  if ("kind" in owned) return owned as Refused;
  const root = script.roots.tags;
  let add: ReturnType<typeof tagAppender> | null = null;
  for (const ref of tags as unknown[]) {
    if (!recordBag(ref) || !tagCategoryId(ref.cat) || !trimmed(ref.name, 80)) return refuseRecord("value");
    const cat = String(ref.cat), name = ref.name, key = registryKey(cat, name);
    if (identities.has(key)) return refuseRecord("value");
    identities.add(key);
    const tag = namedTag(document, cat, name);
    if (tag && !isTagId(tag.id)) return refuseRecord("stored");
    const id = tag?.id;
    const existing = id ? root.get(id) : undefined;
    if (id && root.has(id) && (!(existing instanceof Y.Map) || existing.get("removed") !== true)) {
      const map = target(root, id);
      if (!(map instanceof Y.Map)) return map;
      const before = cycle ? stored(map, "status", TAG_STATUS_IDS[0]) : undefined;
      if (cycle && !tagStatusId(before)) return refuseRecord("stored");
      if (!planFields(writes, map, cycle ? { ...owned, status: nextTagStatus(before) } : owned)) return refuseRecord("stored");
      continue;
    }
    if (!add) {
      const order = slots(root, true);
      if (!order) return refuseRecord("stored");
      add = tagAppender(script, writes, order.at(-1)?.rank ?? null);
    }
    const refusal = add({ ...defaults("tags"), cat, name, ...owned, ...(cycle ? { status: nextTagStatus("needed") } : {}) });
    if (refusal) return refusal;
  }
  return finish(writes);
}

function removeOrRestore(script: NativeScript, collection: Collection, ids: readonly string[], restore: boolean): Result {
  const writes: Write[] = [];
  const root = script.roots[collection];
  const names = restore && collection === "people" ? new Set([...root.values()].flatMap(map =>
    map instanceof Y.Map && map.get("removed") !== true ? [normalizeTagName(stored(map, "name"))] : [])) : null;
  for (const id of ids) {
    const map = target(script.roots[collection], id, restore);
    if (!(map instanceof Y.Map)) return map;
    if (names) {
      const name = stored(map, "name", "");
      if (typeof name !== "string") return refuseRecord("stored");
      const key = normalizeTagName(name);
      if (key) {
        if (names.has(key)) return refuseRecord("value");
        names.add(key);
      }
    }
    writes.push(() => { if (restore) map.delete("removed"); else map.set("removed", true); });
  }
  return finish(writes);
}

function move(root: Root, id: string, before: string | null): Result {
  const order = slots(root, false);
  if (!order) return refuseRecord("stored");
  const at = order.findIndex(entry => entry.id === id);
  if (at < 0) return refuseRecord("missing");
  const moving = order[at] as Slot;
  const next = order[at + 1]?.id ?? null, drop = before === id ? next : before;
  if (moving.rank !== null && drop === next) return RECORD_UNCHANGED;
  order.splice(at, 1);
  const to = drop === null ? order.length : order.findIndex(entry => entry.id === drop);
  if (to < 0) return refuseRecord("missing");
  const left = order[to - 1]?.rank ?? null, right = order[to]?.rank ?? null;
  const writes: Write[] = [];
  const atDrop = order[to];
  if (atDrop && atDrop.rank === left) {
    let rank = left;
    const tail = order.slice(to).findIndex(entry => entry.rank !== left), end = tail < 0 ? order.length : to + tail;
    const after = order[end]?.rank ?? null;
    for (const entry of [moving, ...order.slice(to, end)]) {
      rank = nativeRankBetween(rank, after);
      const next = rank;
      writes.push(() => { entry.map.set("rank", next); });
    }
  } else {
    const rank = nativeRankBetween(left, right);
    writes.push(() => { moving.map.set("rank", rank); });
  }
  return finish(writes);
}

function changeProp(script: NativeScript, id: string, prop: string, kind: "addProp" | "removeProp" | "moveProp", before: string | null): Result {
  const shot = target(script.roots.shots, id);
  if (!(shot instanceof Y.Map)) return shot;
  const document = script.reader.document(), writes: Write[] = [];
  const props = prepareNativeShotProps(shot, document.productionTags);
  if (!props) return refuseRecord("stored");
  if (kind === "addProp") {
    const name = normalizeTagName(prop);
    if (props.hasName(name)) return RECORD_UNCHANGED;
    if (prop !== prop.trim()) return refuseRecord("value");
    if (props.activeCount >= BROLL_PROPS_MAX) return refuseRecord("value");
    const projected = projectedTagIds(script, document);
    const tag = document.productionTags.find(entry => entry?.cat === "prop" && entry.id && !projected.has(entry.id) && normalizeTagName(entry.name) === name);
    const tagId = tag?.id ?? planNew(script, writes, "tags", { ...defaults("tags"), cat: "prop", name: prop });
    if (typeof tagId !== "string") return tagId;
    if (!isTagId(tagId)) return refuseRecord("stored");
    props.add(writes, { id: tagId, name: tag?.name ?? prop });
  } else if (kind === "removeProp") {
    props.remove(writes, prop);
  } else {
    const refusal = props.move(writes, prop, before);
    if (refusal) return refuseRecord(refusal);
  }
  return finish(writes);
}

function gear(script: NativeScript, names: readonly string[]): Result {
  const refs = new Set(names.map(normalizeTagName));
  if (refs.size !== names.length) return refuseRecord("value");
  const root = script.roots.tags, order = slots(root, true);
  if (!order) return refuseRecord("stored");
  const document = script.reader.document(), used = nativeTagNamesInRows(script.reader.rows()), writes: Write[] = [];
  for (const tag of document.productionTags) {
    if (tag?.cat !== "gear" || refs.has(normalizeTagName(tag.name)) || used.has(registryKey("gear", tag.name))) continue;
    if (!tag.id) return refuseRecord("stored");
    const map = target(root, tag.id);
    if (!(map instanceof Y.Map)) return map;
    writes.push(() => { map.set("removed", true); });
  }
  const add = tagAppender(script, writes, order.at(-1)?.rank ?? null);
  for (const name of names) {
    if (namedTag(document, "gear", name)) continue;
    const refusal = add({ ...defaults("tags"), cat: "gear", name });
    if (refusal) return refusal;
  }
  return finish(writes);
}

function applyChange(script: NativeScript, change: Fields): Result {
  const { kind, collection: rawCollection, fields, ownerName, id, before, prop } = change;
  const collection = collectionOf(rawCollection);
  if (kind === "addProp" || kind === "removeProp" || kind === "moveProp") {
    if (!nativeRecordId(id)) return refuseRecord("missing");
    if (typeof prop !== "string" || !(kind === "addProp" ? trimmed(prop.trim(), BROLL_PROP_NAME_MAX) : prop.length > 0)) return refuseRecord("value");
    if (kind === "moveProp" && before !== null && (typeof before !== "string" || !before)) return refuseRecord("value");
    return changeProp(script, id, prop, kind, typeof before === "string" ? before : null);
  }
  if (kind === "gear") {
    const names = listOf(change.names, (name): name is string => trimmed(name, 80));
    return names ? gear(script, names) : refuseRecord("value");
  }
  if (kind === "updateTags") return updateTags(script, change.tags, fields, ownerName, change.cycle);
  if (kind === "create") return collection && recordBag(fields) ? create(script, collection, fields, ownerName) : refuseRecord("value");
  if (kind === "move") {
    if (!collection || !nativeRecordId(id) || before !== null && !nativeRecordId(before)) return refuseRecord("value");
    return move(script.roots[collection], id, before);
  }
  const ids = listOf(change.ids, nativeRecordId);
  if (!ids) return refuseRecord("value");
  if (kind === "cycleTagStatus") return set(script, "tags", ids, {}, undefined, true);
  if (!collection) return refuseRecord("value");
  if (kind === "set") return recordBag(fields) ? set(script, collection, ids, fields, ownerName) : refuseRecord("value");
  if (kind === "remove" || kind === "restore") return removeOrRestore(script, collection, ids, kind === "restore");
  return refuseRecord("value");
}

export function changeNativeRegistry(script: NativeScript, change: NativeRegistryChange): Result {
  const unavailable = nativeWriteAvailability(script);
  if (unavailable) return refuseRecord(unavailable);
  return transactPreparedNativeCommand(script, () => copyArgument(() => copyRecordValue(change))?.value, (input): Result => {
    if (script.closed() || script.reader.isClosed()) return refuseRecord("closed");
    return recordBag(input) ? applyChange(script, input) : refuseRecord("value");
  }, refuseRecord, input => recordBag(input) && input.kind !== "remove" && input.kind !== "restore" && input.kind !== "removeProp");
}
