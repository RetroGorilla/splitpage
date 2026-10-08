import type { Frozen } from "../document/freeze.ts";
import { idMap } from "../document/id-map.ts";
import { cappedName, cappedText, unitCutName } from "../document/text-policy.ts";
import {
  TAG_STATUS_IDS,
  mintTagId,
  normalizeTagName,
  registryKey,
  tagCategoryId,
  tagKey,
  tagStatusId
} from "../document/tags.ts";
import type { TagCategoryId, TagName, TagStatusId } from "../document/tags.ts";
import type { ValidatedDocument } from "../document/validated.ts";
import { cuesInCell, editCues } from "../text/cues.ts";
import { retag, setMark } from "../text/edits.ts";
import type { CellRange } from "../text/edits.ts";
import { toHtml } from "../text/html.ts";
import { OBJ, namedTagId, tagIds, tagNameOf } from "../text/runs.ts";
import type { Marks, Run } from "../text/runs.ts";
import type { FieldHtml, FieldTag, ProductionReaders, ProductionRow } from "./ports.ts";

export const TAG_FIELDS = Object.freeze(["visualText", "audioText"] as const);

export type TagField = (typeof TAG_FIELDS)[number];

export type RegistryTag = {
  id?: string | undefined;
  cat: string;
  name: string;
  owner?: string | undefined;
  notes?: string | undefined;
  status?: string | undefined;
};

export type RegistryList = readonly (RegistryTag | null | undefined)[];

export type NewRegistryTag = { id: string; cat: string; name: string; owner: string; notes: string; status: TagStatusId };

export type MissingRegistryTag = { cat: TagCategoryId; name: string; owner: string; notes: string; status: TagStatusId };

export type TagMention = { rowId: string; rowIndex: number; field: TagField; text: string };

export type TagGroup = { key: string; catId: TagCategoryId; name: string; mentions: TagMention[] };

export type TagState = { docId?: unknown; rows: readonly ProductionRow[]; productionTags: RegistryList };

export type ProductionEntry = {
  key: string;
  id: string | null;
  catId: TagCategoryId;
  name: string;
  mentions: TagMention[];
  orphaned: boolean;
  owner: string;
  notes: string;
  status: TagStatusId;
};

export type RowSigSlot = FieldHtml | readonly FieldTag[];

export type ProductionIndex = Frozen<{
  entries: ProductionEntry[];
  unregistered: TagGroup[];
  rowCount: number;
  rowSig: RowSigSlot[];
  tagSig: unknown[];
}>;

export type CueSnapshot = { docId: unknown; cells: Record<string, readonly string[]> };

export type CueRetitle = { at: number; from: string; name: string };

export type HealingPlan = { cues: CueSnapshot; count: number; retitle: CueRetitle[]; register: NewRegistryTag[] };

export type QuickAddPlan = { remove: string[]; register: NewRegistryTag[]; added: number; removed: number };

export type MediaTagWriter = (html: string, cell: readonly Run[], found: readonly CellRange[], cat: string, name: string) => string | null;

export type TagWrite = { hits: number; html: FieldHtml };

export type BulkTagResult = { hits: number; inTags: number; skipped: number; html: FieldHtml };

type CellReader = Pick<ProductionReaders, "cellOf">;

export function registryIndex(registry: RegistryList, cat: string, name: unknown): number {
  const key = registryKey(cat, name);
  for (let i = 0; i < registry.length; i++) {
    const t = registry[i] as RegistryTag;
    if (registryKey(t.cat, t.name) === key) return i;
  }
  return -1;
}

export function registryEntry(registry: RegistryList, cat: string, name: unknown): RegistryTag | null {
  const at = registryIndex(registry, cat, name);
  return at === -1 ? null : registry[at] as RegistryTag;
}

const INVISIBLE_RE = /[\s\p{Cf}]/gu;

export function isBlankTagName(name: unknown): boolean {
  return !String(name == null ? "" : name).replace(INVISIBLE_RE, "");
}

export function newRegistryTag(registry: RegistryList, cat: string, name: string): NewRegistryTag | null {
  const clean = cappedName(String(name == null ? "" : name), 80);
  if (isBlankTagName(clean)) return null;
  if (registryEntry(registry, cat, clean)) return null;
  return { id: mintTagId(cat, clean, registry), cat: cat, name: clean, owner: "", notes: "", status: TAG_STATUS_IDS[0] };
}

export function collectTagsFromRows(rows: readonly ProductionRow[] | null | undefined, readers: ProductionReaders): TagGroup[] {
  const groups: Record<string, TagGroup> = {}, order: string[] = [];
  (rows || []).forEach(function (row, rowIndex) {
    TAG_FIELDS.forEach(function (field) {
      readers.tagsInField(row[field]).forEach(function (found) {
        const catId = tagCategoryId(found.catId);
        if (!catId) return;
        const key = tagKey(catId, found.name);
        if (!groups[key]) {
          groups[key] = { key: key, catId: catId, name: found.name, mentions: [] };
          order.push(key);
        }
        (groups[key] as TagGroup).mentions.push({
          rowId: row.id,
          rowIndex: rowIndex,
          field: field,
          text: found.text
        });
      });
    });
  });
  return order.map(function (k) { return groups[k] as TagGroup; });
}

export function missingRegistryTags(
  rows: readonly ProductionRow[] | null | undefined,
  registry: RegistryList | null | undefined,
  readers: ProductionReaders
): MissingRegistryTag[] {
  const have: Record<string, boolean> = Object.create(null);
  (registry || []).forEach(function (t) { if (t && t.name) have[registryKey(t.cat, t.name)] = true; });
  const out: MissingRegistryTag[] = [];
  collectTagsFromRows(rows, readers).forEach(function (t) {
    const name = cappedText(t.name, 80);
    if (!name) return;
    const key = registryKey(t.catId, name);
    if (have[key]) return;
    have[key] = true;
    out.push({ cat: t.catId, name: name, owner: "", notes: "", status: TAG_STATUS_IDS[0] });
  });
  return out;
}

export function cueCutRenames(rows: readonly ProductionRow[] | null | undefined, readers: ProductionReaders): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  (rows || []).forEach(function (row) {
    TAG_FIELDS.forEach(function (field) {
      const html = row[field];
      if (!readers.cueNamesInField(html).some(function (name) { return name.length >= 80; })) return;
      cuesInCell(readers.cellOf(html as string)).forEach(function (c) {
        const old = unitCutName(c.name, 80), name = cappedName(c.name, 80);
        const key = normalizeTagName(old);
        if (old !== name && key && !(key in out)) out[key] = name;
      });
    });
  });
  return out;
}

export function registrySignature(tags: RegistryList): unknown[] {
  const sig: unknown[] = [];
  tags.forEach(function (t) {
    if (!t) { sig.push(null, null, null, null, null, null); return; }
    sig.push(t.cat, t.name, t.owner, t.notes, t.status, t.id);
  });
  return sig;
}

function sameFieldTags(a: readonly FieldTag[], b: readonly FieldTag[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as FieldTag, y = b[i] as FieldTag;
    if (x.catId !== y.catId || x.name !== y.name || x.text !== y.text) return false;
  }
  return true;
}

const ROW_SIG_SLOTS = 5;

export function refreshedProductionIndex(ix: ProductionIndex, state: TagState, readers: ProductionReaders): ProductionIndex | null {
  const rows = state.rows, tags = state.productionTags;
  if (ix.rowCount !== rows.length || ix.tagSig.length !== tags.length * 6) return null;
  const was = ix.rowSig;
  let rs: RowSigSlot[] | null = null;
  for (let i = 0, j = 0; i < rows.length; i++, j += ROW_SIG_SLOTS) {
    const r = rows[i] as ProductionRow;
    if (was[j] !== r.id) return null;
    if (was[j + 1] !== r.visualText) {
      const vTags = readers.tagsInField(r.visualText);
      if (!sameFieldTags(was[j + 3] as readonly FieldTag[], vTags)) return null;
      rs = rs || was.slice();
      rs[j + 1] = r.visualText;
      rs[j + 3] = vTags;
    }
    if (was[j + 2] !== r.audioText) {
      const aTags = readers.tagsInField(r.audioText);
      if (!sameFieldTags(was[j + 4] as readonly FieldTag[], aTags)) return null;
      rs = rs || was.slice();
      rs[j + 2] = r.audioText;
      rs[j + 4] = aTags;
    }
  }
  const ts = ix.tagSig;
  for (let i = 0, j = 0; i < tags.length; i++, j += 6) {
    const t = tags[i];
    if (!t) { if (ts[j] !== null) return null; continue; }
    if (ts[j] !== t.cat || ts[j + 1] !== t.name || ts[j + 2] !== t.owner ||
        ts[j + 3] !== t.notes || ts[j + 4] !== t.status || ts[j + 5] !== t.id) return null;
  }
  if (!rs) return ix;
  return { entries: ix.entries, unregistered: ix.unregistered, rowCount: ix.rowCount, rowSig: rs, tagSig: ix.tagSig };
}

export function deriveProductionIndex(state: ValidatedDocument, readers: ProductionReaders): ProductionIndex {
  const rows = state.rows;
  const live = collectTagsFromRows(rows, readers);
  const liveByKey: Record<string, TagGroup> = {};
  live.forEach(function (t) { liveByKey[registryKey(t.catId, t.name)] = t; });

  const seen: Record<string, boolean> = {}, out: ProductionEntry[] = [], unregistered: TagGroup[] = [];
  state.productionTags.forEach(function (t) {
    if (!t) return;
    const catId = tagCategoryId(t.cat);
    if (!catId) return;
    const key = registryKey(catId, t.name);
    if (seen[key]) return;
    seen[key] = true;
    const liveMatch = liveByKey[key];
    out.push({
      key: key,
      id: t.id || null,
      catId: catId,
      name: liveMatch ? liveMatch.name : t.name,
      mentions: liveMatch ? liveMatch.mentions : [],
      orphaned: !liveMatch,
      owner: t.owner || "",
      notes: t.notes || "",
      status: tagStatusId(t.status) || TAG_STATUS_IDS[0]
    });
  });
  live.forEach(function (t) {
    const key = registryKey(t.catId, t.name);
    if (seen[key]) return;
    seen[key] = true;
    unregistered.push(t);
    out.push({ key: key, id: null, catId: t.catId, name: t.name, mentions: t.mentions,
               orphaned: false, owner: "", notes: "", status: TAG_STATUS_IDS[0] });
  });

  const rowSig = new Array<RowSigSlot>(rows.length * ROW_SIG_SLOTS);
  rows.forEach(function (r, i) {
    const j = i * ROW_SIG_SLOTS;
    rowSig[j] = r.id;
    rowSig[j + 1] = r.visualText;
    rowSig[j + 2] = r.audioText;
    rowSig[j + 3] = readers.tagsInField(r.visualText);
    rowSig[j + 4] = readers.tagsInField(r.audioText);
  });
  return {
    entries: out,
    unregistered: unregistered,
    rowCount: rows.length,
    rowSig: rowSig,
    tagSig: registrySignature(state.productionTags)
  };
}

export function snapshotCues(state: TagState, readers: ProductionReaders): CueSnapshot {
  const cells = idMap<readonly string[]>();
  state.rows.forEach(function (r) {
    const names = readers.cueNamesInField(r.audioText);
    if (names.length) cells[r.id] = names;
  });
  return { docId: state.docId, cells: cells };
}

function retitleEditedCues(
  was: CueSnapshot | null | undefined,
  now: CueSnapshot,
  ix: ProductionIndex,
  work: (RegistryTag | null | undefined)[]
): CueRetitle[] {
  const out: CueRetitle[] = [];
  if (!was || was.docId !== now.docId) return out;
  const fresh: Record<string, boolean> = {}, orphan: Record<string, boolean> = {};
  ix.unregistered.forEach(function (t) { if (t.catId === "sound") fresh[registryKey("sound", t.name)] = true; });
  ix.entries.forEach(function (e) { if (e.orphaned && e.catId === "sound") orphan[e.key] = true; });
  Object.keys(now.cells).forEach(function (rowId) {
    const before = Object.prototype.hasOwnProperty.call(was.cells, rowId) ? was.cells[rowId] : undefined;
    if (!before) return;
    cueEditPairs(before, now.cells[rowId] as readonly string[]).forEach(function (pair) {
      const oldName = pair[0], newName = pair[1];
      const oldKey = registryKey("sound", oldName), newKey = registryKey("sound", newName);
      if (!fresh[newKey] || !orphan[oldKey]) return;
      const at = registryIndex(work, "sound", oldName);
      if (at === -1) return;
      work[at] = Object.assign({}, work[at], { name: newName });
      Reflect.deleteProperty(fresh, newKey);
      Reflect.deleteProperty(orphan, oldKey);
      out.push({ at: at, from: oldName, name: newName });
    });
  });
  return out;
}

export function cueEditPairs(before: readonly string[], after: readonly string[]): [string, string][] {
  const gone = absentFrom(before, after);
  const came = absentFrom(after, before);
  if (gone.length === 1 && came.length === 1) return [[gone[0] as string, came[0] as string]];
  const pairs: [string, string][] = [];
  gone.forEach(function (g) {
    const near = came.filter(function (c) { return closeCueNames(g, c); });
    if (near.length !== 1) return;
    const rivals = gone.filter(function (x) { return closeCueNames(x, near[0] as string); });
    if (rivals.length === 1) pairs.push([g, near[0] as string]);
  });
  return pairs;
}

function absentFrom(list: readonly string[], other: readonly string[]): string[] {
  const keys = list.map(normalizeTagName), kept = other.map(normalizeTagName);
  return list.filter(function (_name, i) {
    return kept.indexOf(keys[i] as string) === -1 && keys.indexOf(keys[i] as string) === i;
  });
}

export function closeCueNames(a: string, b: string): boolean {
  const x = normalizeTagName(a), y = normalizeTagName(b);
  const shorter = Math.min(x.length, y.length);
  let p = 0;
  while (p < shorter && x.charAt(p) === y.charAt(p)) p++;
  let s = 0;
  while (s < shorter - p && x.charAt(x.length - 1 - s) === y.charAt(y.length - 1 - s)) s++;
  return shorter > 0 && (p + s) * 2 >= shorter;
}

export function planRegistryHealing(
  state: ValidatedDocument,
  readers: ProductionReaders,
  was?: CueSnapshot | null,
  index?: ProductionIndex
): HealingPlan {
  const ix = index || deriveProductionIndex(state, readers);
  const plan: HealingPlan = { cues: snapshotCues(state, readers), count: 0, retitle: [], register: [] };
  if (!ix.unregistered.length) return plan;
  const work = state.productionTags.slice();
  plan.retitle = retitleEditedCues(was, plan.cues, ix, work);
  ix.unregistered.forEach(function (t) {
    const rec = newRegistryTag(work, t.catId, t.name);
    if (!rec) return;
    work.push(rec);
    plan.register.push(rec);
  });
  plan.count = plan.retitle.length + plan.register.length;
  return plan;
}

export function planQuickAdd(state: ValidatedDocument, readers: ProductionReaders, raw: string, index?: ProductionIndex): QuickAddPlan {
  const wanted = idMap<string>(), order: string[] = [];
  raw.split(/\r\n|\r|\n/).forEach(function (line) {
    const name = cappedText(line, 80);
    if (!name) return;
    const key = normalizeTagName(name);
    if (wanted[key]) return;
    wanted[key] = name;
    order.push(key);
  });

  const ix = index || deriveProductionIndex(state, readers);
  const plan: QuickAddPlan = { remove: [], register: [], added: 0, removed: 0 };
  let work = state.productionTags.slice();
  ix.entries.filter(function (e) { return e.catId === "gear"; }).forEach(function (item) {
    if (wanted[normalizeTagName(item.name)] !== undefined) return;
    if (!item.orphaned) return;
    plan.remove.push(item.name);
    const key = registryKey("gear", item.name);
    const before = work.length;
    work = work.filter(function (t) { return registryKey((t as RegistryTag).cat, (t as RegistryTag).name) !== key; });
    if (before !== work.length) plan.removed++;
  });

  order.forEach(function (key) {
    const name = wanted[key] as string;
    if (!registryEntry(work, "gear", name)) plan.added++;
    const rec = newRegistryTag(work, "gear", name);
    if (!rec) return;
    work.push(rec);
    plan.register.push(rec);
  });
  return plan;
}

const TAG_WORD_CHAR_RE = /[\p{L}\p{N}]/u;

function foldCaseKeepLength(s: string): string {
  const lower = s.toLowerCase();
  if (lower.length === s.length) return lower;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i).toLowerCase();
    out += c.length === 1 ? c : s.charAt(i);
  }
  return out;
}

function sameCmt(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return (a || []).join("\u0000") === (b || []).join("\u0000");
}

export function tagOccurrences(cell: readonly Run[] | null | undefined, phrase: unknown): CellRange[] {
  const needle = foldCaseKeepLength(String(phrase == null ? "" : phrase));
  const out: CellRange[] = [];
  if (!needle) return out;
  let text = "";
  const marks: (Marks | null)[] = [];
  (cell || []).forEach(function (r) {
    if (r.atom) { text += OBJ; marks.push(null); return; }
    text += r.text;
    for (let i = 0; i < r.text.length; i++) marks.push(r.marks);
  });
  const hay = foldCaseKeepLength(text);
  let at = hay.indexOf(needle);
  while (at !== -1) {
    const end = at + needle.length;
    let ok = true;
    for (let i = at; i < end && ok; i++) {
      const m = marks[i];
      ok = !!m && !m.tag && !m.href && text.charAt(i) !== "\n" && sameCmt(m.cmt, (marks[at] as Marks).cmt);
    }
    if (!ok) { at = hay.indexOf(needle, at + 1); continue; }
    if (!TAG_WORD_CHAR_RE.test(text.charAt(at - 1)) && !TAG_WORD_CHAR_RE.test(text.charAt(end))) {
      out.push({ from: at, to: end });
    }
    at = hay.indexOf(needle, end);
  }
  return out;
}

export function holdsMedia(html: FieldHtml): boolean {
  return /<img[\s>]|video-embed-card/i.test(html || "");
}

function writeTags(
  html: FieldHtml,
  cell: readonly Run[],
  found: readonly CellRange[],
  cat: string,
  name: unknown,
  writeMedia: MediaTagWriter
): TagWrite {
  if (!found.length) return { hits: 0, html: html };
  const clean = cappedText(name, 80);
  if (holdsMedia(html)) {
    const wrapped = writeMedia(html as string, cell, found, cat, clean);
    return wrapped === null ? { hits: 0, html: html } : { hits: found.length, html: wrapped };
  }
  const id = namedTagId(cat, clean);
  let next: readonly Run[] = cell;
  found.forEach(function (m) { next = setMark(next, m.from, m.to, "tag", id); });
  return { hits: found.length, html: toHtml(next) };
}

function decodeField(readers: CellReader, html: FieldHtml): readonly Run[] {
  return readers.cellOf(html == null ? "" : html);
}

export function tagFieldOccurrences(
  html: FieldHtml,
  phrase: unknown,
  cat: string,
  name: unknown,
  countOnly: unknown,
  onlyOccurrence: number | undefined,
  readers: CellReader,
  writeMedia: MediaTagWriter
): TagWrite {
  const cell = decodeField(readers, html);
  let found = tagOccurrences(cell, phrase);
  if (countOnly) return { hits: found.length, html: html };
  if (onlyOccurrence !== undefined) found = found[onlyOccurrence] ? [found[onlyOccurrence] as CellRange] : [];
  return writeTags(html, cell, found, cat, name, writeMedia);
}

function wholeWordHits(text: string, needle: string, matchCase: unknown): CellRange[] {
  const hay = matchCase ? text : foldCaseKeepLength(text);
  const find = matchCase ? needle : foldCaseKeepLength(needle);
  const out: CellRange[] = [];
  if (!find) return out;
  let at = hay.indexOf(find);
  while (at !== -1) {
    const end = at + find.length;
    if (!TAG_WORD_CHAR_RE.test(text.charAt(at - 1)) && !TAG_WORD_CHAR_RE.test(text.charAt(end))) {
      out.push({ from: at, to: end });
      at = hay.indexOf(find, end);
    } else {
      at = hay.indexOf(find, at + 1);
    }
  }
  return out;
}

export function bulkTagCell(
  html: FieldHtml,
  phrase: unknown,
  cat: string,
  name: unknown,
  matchCase: unknown,
  countOnly: unknown,
  readers: CellReader,
  writeMedia: MediaTagWriter
): BulkTagResult {
  const needle = String(phrase == null ? "" : phrase).trim();
  const none = { hits: 0, inTags: 0, skipped: 0, html: html };
  if (!needle) return none;
  const cell = decodeField(readers, html);
  let text = "";
  const tagged: boolean[] = [];
  cell.forEach(function (r) {
    if (r.atom) { text += OBJ; tagged.push(false); return; }
    text += r.text;
    for (let i = 0; i < r.text.length; i++) tagged.push(!!r.marks.tag);
  });
  const found = tagOccurrences(cell, needle).filter(function (m) {
    return !matchCase || text.slice(m.from, m.to) === needle;
  });
  const taking: Record<number, boolean> = {};
  found.forEach(function (m) { taking[m.from] = true; });
  let inTags = 0, skipped = 0;
  wholeWordHits(text, needle, matchCase).forEach(function (h) {
    if (taking[h.from]) return;
    if (tagged.slice(h.from, h.to).indexOf(true) !== -1) inTags++;
    else skipped++;
  });
  if (countOnly || !found.length) {
    return { hits: found.length, inTags: inTags, skipped: skipped, html: html };
  }
  const res = writeTags(html, cell, found, cat, name, writeMedia);
  return { hits: res.hits, inTags: inTags, skipped: skipped + found.length - res.hits, html: res.html };
}

export function retagCell(html: string, cat: string, target: string, toId: string | null, readers: CellReader): string {
  let cell = readers.cellOf(html);
  tagIds(cell).forEach(function (id) {
    const t = tagNameOf(id);
    if (t && t.cat === cat && normalizeTagName(t.name) === target) cell = retag(cell, id, toId);
  });
  if (cat === "sound" && html.indexOf("audio-cue") !== -1) {
    cell = editCues(cell, function (name) { return normalizeTagName(cappedName(name, 80)) === target; },
      toId === null ? null : (tagNameOf(toId) as TagName).name);
  }
  return toHtml(cell);
}
