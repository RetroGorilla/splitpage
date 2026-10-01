import {
  BROLL_MARKER_RE,
  BROLL_NAME_MAX,
  BROLL_PROP_NAME_MAX,
  BROLL_STATUS_IDS,
  BROLL_TEXT_MAX,
  brollPropKey,
  brollStatusId,
  normalizeBrollProps
} from "../document/broll.ts";
import type { BrollProp, BrollStatusId } from "../document/broll.ts";
import type { IdSource } from "../document/ports.ts";
import { TAG_STATUS_IDS, normalizeTagName, tagStatusId } from "../document/tags.ts";
import { deleteRange, insertBrollKey, insertText, replaceWithBrollKey } from "../text/edits.ts";
import { tagNameOf } from "../text/runs.ts";
import type { BrollRun, Marks, Run } from "../text/runs.ts";
import type { BrollItem, FieldText, ProductionReaders, ProductionRow } from "./ports.ts";
import { TAG_FIELDS, registryEntry } from "./tags.ts";
import type { RegistryList, RegistryTag } from "./tags.ts";

export type BrollLineItem = { atom?: BrollRun; text: string; marks: Marks; pos: number };

export type BrollLine = { start: number; end: number; items: BrollLineItem[] };

export type BrollMarker = { id: string; key: BrollLineItem | null; rest: BrollLineItem[] | null; strip?: number };

export type BrollMarkerLine = { line: BrollLine; index: number; marker: BrollMarker };

export type BrollFound = {
  id: string;
  name: string;
  desc: string;
  rowId: string;
  rowIndex: number;
  ordinal: number;
  autoProps: string[];
};

export type BrollPropRef = { id?: string | undefined; name?: string | undefined };

export type BrollShot = {
  id: string;
  name?: string | undefined;
  desc?: string | undefined;
  status?: unknown;
  reshoot?: unknown;
  notes?: string | undefined;
  owner?: string | undefined;
  audioRef?: string | undefined;
  location?: string | undefined;
  props?: (BrollPropRef | null | undefined)[] | undefined;
  origin?: string | undefined;
};

export type BrollSeedFields = { id: string; name: string; desc: string; audioRef: string; location: string };

export type BrollSeed = { status: BrollStatusId; props: BrollPropRef[]; origin: string } & BrollSeedFields;

export type NewBrollShot = {
  id: string;
  name: string;
  desc: string;
  status: BrollStatusId;
  reshoot: boolean;
  notes: string;
  owner: string;
  audioRef: string;
  location: string;
  props: BrollPropRef[];
  origin: string;
};

export type BrollEntryProp = {
  key: string;
  id: string;
  name: string;
  status: string;
  auto: boolean;
  hand: boolean;
  tracked: boolean;
  ref: string;
};

export type BrollEntry = {
  rec: BrollShot;
  id: string;
  name: string | undefined;
  desc: string;
  rowId: string | null;
  rowIndex: number;
  ordinal: number;
  markerless: boolean;
  orphaned: boolean;
  status: BrollStatusId;
  reshoot: boolean;
  notes: string;
  owner: string;
  audioRef: string;
  location: string;
  props: BrollEntryProp[];
  origin: string | undefined;
};

export type BrollCreate = { entry: number; shot: NewBrollShot };

export type BrollRename = { at: number; name: string; desc: string };

export type BrollPlan = { create: BrollCreate[]; rename: BrollRename[] };

export type BrollRead = { entries: BrollEntry[]; plan: BrollPlan };

export type BrollState = { rows: readonly ProductionRow[]; brollShots: readonly BrollShot[]; productionTags: RegistryList };

export type BrollAnchorPlan = Record<string, string>;

export type BrollAnchorTodo = { found: BrollMarkerLine; id: string };

export type BrollAnchoring = { cell: readonly Run[]; anchored: number };

export type BrollPropsChange = { at: number; props: BrollProp[] };

type BrollDraft = { id: string; name: string; desc: string[] };

function lastLine(lines: BrollLine[]): BrollLine {
  return lines[lines.length - 1] as BrollLine;
}

export function brollCellLines(cell: readonly Run[]): BrollLine[] {
  const lines: BrollLine[] = [{ start: 0, end: 0, items: [] }];
  let pos = 0;
  cell.forEach(function (r) {
    if (r.atom) {
      lastLine(lines).items.push({ atom: r, text: r.text, marks: r.marks, pos: pos });
      pos++;
      return;
    }
    r.text.split("\n").forEach(function (part, i) {
      if (i > 0) {
        lastLine(lines).end = pos;
        pos++;
        lines.push({ start: pos, end: pos, items: [] });
      }
      if (part) {
        lastLine(lines).items.push({ text: part, marks: r.marks, pos: pos });
        pos += part.length;
      }
    });
  });
  lastLine(lines).end = pos;
  return lines;
}

function brollLineText(items: readonly BrollLineItem[]): string {
  return items.map(function (it) { return it.text; }).join("");
}

function hasNoMarks(marks: Marks | null | undefined): boolean {
  return !marks || !Object.keys(marks).length;
}

function brollLineMarker(items: BrollLineItem[]): BrollMarker | null {
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as BrollLineItem;
    if (!it.atom && hasNoMarks(it.marks) && !it.text.trim()) continue;
    if (it.atom && hasNoMarks(it.marks)) return { id: it.atom.id || "", key: it, rest: items.slice(i + 1) };
    break;
  }
  const m = BROLL_MARKER_RE.exec(brollLineText(items));
  return m ? { id: "", key: null, rest: null, strip: m[0].length } : null;
}

export function brollInCell(cell: readonly Run[]): BrollItem[] {
  const out: BrollDraft[] = [];
  let open: BrollDraft | null = null;
  brollCellLines(cell).forEach(function (line) {
    const marker = brollLineMarker(line.items);
    if (marker) {
      const name = marker.rest
        ? brollLineText(marker.rest)
        : brollLineText(line.items).slice(marker.strip);
      open = { id: marker.id, name: name.trim().slice(0, BROLL_NAME_MAX), desc: [] };
      out.push(open);
      return;
    }
    if (open) open.desc.push(brollLineText(line.items));
  });
  return out.map(function (item) {
    return { id: item.id, name: item.name, desc: item.desc.join("\n").replace(/\s+$/, "").slice(0, BROLL_TEXT_MAX) };
  });
}

export function brollPropsInCell(cell: readonly Run[]): string[][] {
  const out: string[][] = [];
  let open: string[] | null = null, seen: Record<string, boolean> = Object.create(null);
  brollCellLines(cell).forEach(function (line) {
    if (brollLineMarker(line.items)) {
      open = [];
      seen = Object.create(null);
      out.push(open);
    }
    if (!open) return;
    const props: string[] = open;
    line.items.forEach(function (it) {
      const t = !it.atom && it.marks && it.marks.tag ? tagNameOf(it.marks.tag) : null;
      if (!t || t.cat !== "prop") return;
      const name = t.name.trim().slice(0, BROLL_PROP_NAME_MAX);
      const key = normalizeTagName(name);
      if (!name || seen[key]) return;
      seen[key] = true;
      props.push(name);
    });
  });
  return out;
}

export function brollMarkerLines(cell: readonly Run[]): BrollMarkerLine[] {
  const out: BrollMarkerLine[] = [];
  brollCellLines(cell).forEach(function (line, index) {
    const marker = brollLineMarker(line.items);
    if (marker) out.push({ line: line, index: index, marker: marker });
  });
  return out;
}

export function collectBrollFromRows(rows: readonly ProductionRow[] | null | undefined, readers: ProductionReaders): BrollFound[] {
  const out: BrollFound[] = [];
  const seen: Record<string, boolean> = Object.create(null);
  (rows || []).forEach(function (row, rowIndex) {
    const props = readers.brollPropsInField(row.visualText);
    readers.brollInField(row.visualText).forEach(function (found, ordinal) {
      const id = found.id && !seen[found.id] ? found.id : "";
      if (id) seen[id] = true;
      out.push({
        id: id, name: found.name, desc: found.desc,
        rowId: row.id, rowIndex: rowIndex, ordinal: ordinal,
        autoProps: props[ordinal] || []
      });
    });
  });
  return out;
}

function brollRow(rows: readonly ProductionRow[], rowId: string): ProductionRow | null {
  let i = -1;
  if (rowId) {
    for (let k = 0; k < rows.length; k++) {
      if ((rows[k] as ProductionRow).id === rowId) { i = k; break; }
    }
  }
  return i === -1 ? null : rows[i] as ProductionRow;
}

export function brollSeedRef(row: ProductionRow | null | undefined, plainTextOf: FieldText): string {
  return row ? plainTextOf(row.audioText).trim().slice(0, BROLL_TEXT_MAX) : "";
}

export function brollSeedLocation(row: ProductionRow | null | undefined, readers: ProductionReaders): string {
  if (!row) return "";
  let found = "";
  TAG_FIELDS.forEach(function (field) {
    readers.tagsInField(row[field]).forEach(function (t) {
      if (!found && t.catId === "location") found = t.name;
    });
  });
  return found.slice(0, 80);
}

function brollMatchRecord(
  found: BrollFound,
  claimed: Record<string, boolean>,
  byId: Record<string, number>,
  held: Record<string, boolean>,
  shots: readonly BrollShot[]
): number {
  const at = found.id ? byId[found.id] : undefined;
  const rec = at === undefined ? null : shots[at] as BrollShot;
  if (rec && !claimed[rec.id]) return at as number;
  const norm = normalizeTagName(found.name);
  for (let i = 0; i < shots.length && norm; i++) {
    const cand = shots[i] as BrollShot;
    if (claimed[cand.id] || held[cand.id]) continue;
    if (normalizeTagName(cand.name) !== norm) continue;
    return i;
  }
  return -1;
}

function brollHeldIds(live: readonly BrollFound[]): Record<string, boolean> {
  const held: Record<string, boolean> = Object.create(null);
  live.forEach(function (found) { if (found.id) held[found.id] = true; });
  return held;
}

function shotIndexById(shots: readonly BrollShot[]): Record<string, number> {
  const byId: Record<string, number> = Object.create(null);
  shots.forEach(function (r, i) { byId[r.id] = i; });
  return byId;
}

function brollPropEntry(p: BrollPropRef, registry: RegistryList): RegistryTag | null {
  if (p.id) {
    for (let i = 0; i < registry.length; i++) {
      if ((registry[i] as RegistryTag).id === p.id) return registry[i] as RegistryTag;
    }
  }
  return registryEntry(registry, "prop", p.name);
}

function brollEntryProps(rec: BrollShot, found: BrollFound | null, registry: RegistryList): BrollEntryProp[] {
  const out: BrollEntryProp[] = [], byKey: Record<string, BrollEntryProp> = Object.create(null);
  function add(entry: RegistryTag | null, name: string, ref: string): void {
    const shown = entry ? entry.name : name;
    const key = entry ? "t:" + entry.id : "n:" + normalizeTagName(shown);
    const had = byKey[key];
    if (had) {
      if (ref) { had.hand = true; had.ref = had.ref || ref; } else had.auto = true;
      return;
    }
    const prop: BrollEntryProp = {
      key: key, id: entry ? entry.id as string : "", name: shown,
      status: entry ? (tagStatusId(entry.status) || TAG_STATUS_IDS[0]) : "",
      auto: !ref, hand: !!ref, tracked: !!entry, ref: ref
    };
    byKey[key] = prop;
    out.push(prop);
  }
  ((found && found.autoProps) || []).forEach(function (name) {
    add(registryEntry(registry, "prop", name), name, "");
  });
  (rec.props || []).forEach(function (p) {
    if (p && p.name) add(brollPropEntry(p, registry), p.name, brollPropKey(p.id as string, p.name));
  });
  return out;
}

function brollEntryFrom(rec: BrollShot, found: BrollFound | null, registry: RegistryList): BrollEntry {
  return {
    rec: rec,
    id: rec.id,
    name: found ? found.name : rec.name,
    desc: found ? found.desc : (rec.desc || ""),
    rowId: found ? found.rowId : null,
    rowIndex: found ? found.rowIndex : -1,
    ordinal: found ? found.ordinal : -1,
    markerless: !!found && !found.id,
    orphaned: !found && rec.origin === "script",
    status: brollStatusId(rec.status) || BROLL_STATUS_IDS[0],
    reshoot: !!rec.reshoot,
    notes: rec.notes || "",
    owner: rec.owner || "",
    audioRef: rec.audioRef || "",
    location: rec.location || "",
    props: brollEntryProps(rec, found, registry),
    origin: rec.origin
  };
}

function newBrollShot(fields: BrollSeedFields): NewBrollShot {
  return {
    id: fields.id,
    name: fields.name, desc: fields.desc,
    status: BROLL_STATUS_IDS[0],
    reshoot: false,
    notes: "",
    owner: "",
    audioRef: fields.audioRef,
    location: fields.location,
    props: [],
    origin: "script"
  };
}

export function brollEntries(state: BrollState, readers: ProductionReaders, ids: IdSource, plainTextOf: FieldText): BrollRead {
  const shots = state.brollShots;
  const live = collectBrollFromRows(state.rows, readers);
  const claimed: Record<string, boolean> = Object.create(null);
  const held = brollHeldIds(live);
  const byId = shotIndexById(shots);
  const entries: BrollEntry[] = [];
  const plan: BrollPlan = { create: [], rename: [] };

  live.forEach(function (found) {
    const at = brollMatchRecord(found, claimed, byId, held, shots);
    let rec: BrollShot;
    if (at === -1) {
      const row = brollRow(state.rows, found.rowId);
      const fields: BrollSeedFields = {
        id: found.id || ids.id("bs"),
        name: found.name,
        desc: found.desc,
        audioRef: brollSeedRef(row, plainTextOf),
        location: brollSeedLocation(row, readers)
      };
      const seed: BrollSeed = Object.assign({ status: BROLL_STATUS_IDS[0], props: [], origin: "script" }, fields);
      plan.create.push({ entry: entries.length, shot: newBrollShot(fields) });
      rec = seed;
    } else {
      rec = shots[at] as BrollShot;
      if (rec.name !== found.name || rec.desc !== found.desc) plan.rename.push({ at: at, name: found.name, desc: found.desc });
    }
    claimed[rec.id] = true;
    entries.push(brollEntryFrom(rec, found, state.productionTags));
  });

  shots.forEach(function (rec) {
    if (!claimed[rec.id]) entries.push(brollEntryFrom(rec, null, state.productionTags));
  });

  return { entries: entries, plan: plan };
}

export function brollLineKey(rowId: string, ordinal: number): string {
  return rowId + "\u0000" + ordinal;
}

export function planBrollAnchors(state: BrollState, readers: ProductionReaders, ids: IdSource): BrollAnchorPlan {
  const shots = state.brollShots;
  const claimed: Record<string, boolean> = Object.create(null);
  const byId = shotIndexById(shots);
  const plan: BrollAnchorPlan = Object.create(null);
  const live = collectBrollFromRows(state.rows, readers);
  const held = brollHeldIds(live);
  live.forEach(function (found) {
    const at = brollMatchRecord(found, claimed, byId, held, shots);
    const rec = at === -1 ? null : shots[at] as BrollShot;
    if (rec) claimed[rec.id] = true;
    if (!found.id) plan[brollLineKey(found.rowId, found.ordinal)] = rec ? rec.id : ids.id("bs");
  });
  return plan;
}

export function brollAnchorTodo(cell: readonly Run[], rowId: string, plan: BrollAnchorPlan): BrollAnchorTodo[] {
  const todo: BrollAnchorTodo[] = [];
  brollMarkerLines(cell).forEach(function (found, ordinal) {
    const id = plan[brollLineKey(rowId, ordinal)];
    if (id) todo.push({ found: found, id: id });
  });
  return todo;
}

function brollAnchorLine(cell: readonly Run[], line: BrollLine, id: string): Run[] | null {
  const m = BROLL_MARKER_RE.exec(brollLineText(line.items));
  if (!m) return null;
  let left = m[0].length, to = line.start;
  for (let i = 0; i < line.items.length && left > 0; i++) {
    const it = line.items[i] as BrollLineItem;
    if (it.atom) {
      if (it.text.length > left) return null;
      left -= it.text.length;
      to = it.pos + 1;
    } else {
      const take = Math.min(left, it.text.length);
      left -= take;
      to = it.pos + take;
    }
  }
  const r = replaceWithBrollKey(cell, line.start, to, id, (m[1] as string) + (m[2] as string));
  return insertText(r.cell, r.end, " ", {});
}

function brollRekeyLine(cell: readonly Run[], key: BrollLineItem, id: string): Run[] {
  const next = deleteRange(cell, key.pos, key.pos + 1);
  return insertBrollKey(next, key.pos, id, key.text, {});
}

export function anchorBrollCell(cell: readonly Run[], todo: readonly BrollAnchorTodo[]): BrollAnchoring {
  let n = 0;
  for (let i = todo.length - 1; i >= 0; i--) {
    const t = todo[i] as BrollAnchorTodo;
    const next = t.found.marker.key
      ? brollRekeyLine(cell, t.found.marker.key, t.id)
      : brollAnchorLine(cell, t.found.line, t.id);
    if (next) { cell = next; n++; }
  }
  return { cell: cell, anchored: n };
}

export function brollPropsRenamed(
  state: { brollShots?: unknown; productionTags: RegistryList } | null | undefined,
  fromId: string | null | undefined,
  oldName: unknown,
  toId: string | null | undefined,
  toName: string
): BrollPropsChange[] {
  const out: BrollPropsChange[] = [];
  if (!state || !Array.isArray(state.brollShots)) return out;
  const oldNorm = normalizeTagName(oldName);
  (state.brollShots as readonly BrollShot[]).forEach(function (rec, at) {
    if (!Array.isArray(rec.props) || !rec.props.length) return;
    let changed = false;
    const next = rec.props.map(function (p) {
      if (!p) return p;
      if ((fromId && p.id === fromId) || (oldNorm && !p.id && normalizeTagName(p.name) === oldNorm)) {
        changed = true;
        return Object.assign({}, p, { id: toId || p.id, name: toName });
      }
      return p;
    });
    if (changed) out.push({ at: at, props: normalizeBrollProps(next, state.productionTags) });
  });
  return out;
}

export type BrollListItem = { rowIndex: number; ordinal: number; name?: string | undefined };

export function brollSortedForList<T extends BrollListItem>(entries: readonly T[]): T[] {
  return entries.slice().sort(function (a, b) {
    const an = a.rowIndex === -1, bn = b.rowIndex === -1;
    if (an !== bn) return an ? 1 : -1;
    if (an) return (a.name || "").localeCompare(b.name || "");
    if (a.rowIndex !== b.rowIndex) return a.rowIndex - b.rowIndex;
    return a.ordinal - b.ordinal;
  });
}
