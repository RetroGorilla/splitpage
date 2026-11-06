import type { IdSource } from "../document/ports.ts";
import { normalizeTagName, registryKey } from "../document/tags.ts";
import { addPerson, personNamed } from "./records.ts";
import type { LiveRecords } from "./records.ts";
import { registryEntry } from "./tags.ts";
import type { RegistryList } from "./tags.ts";
import type { FieldHtml, ProductionReaders, ProductionRow, WhoPair } from "./ports.ts";

type WhoReader = Pick<ProductionReaders, "whoInField">;

type Tally = { pairs: Map<string, number>; names: Map<string, number> };

export type OwnerSnapshot = {
  readonly docId: unknown;
  readonly cells: Map<string, FieldHtml>;
  readonly pairs: Map<string, number>;
  readonly names: Map<string, number>;
};

export type OwnerEdits = { readonly rows: readonly ProductionRow[]; readonly removed: readonly string[] };

export type OwnerState = { readonly docId?: unknown; readonly rows: readonly ProductionRow[]; readonly productionTags: RegistryList; readonly [key: string]: unknown };

export type OwnerSyncPlan = {
  readonly snapshot: OwnerSnapshot;
  readonly people: readonly string[];
  readonly gone: readonly WhoPair[];
  readonly added: readonly WhoPair[];
  readonly fields: readonly string[];
  readonly commit: () => void;
};

function pairKey(p: WhoPair): string {
  return registryKey(p.cat, p.name) + "\u0000" + normalizeTagName(p.who);
}

function bump(into: Map<string, number>, key: string, by: number): void {
  const n = (into.get(key) || 0) + by;
  if (n) into.set(key, n); else into.delete(key);
}

function tally(cells: readonly FieldHtml[], by: number, readers: WhoReader, into: Tally, pairs: Map<string, WhoPair>, names: Map<string, string>): void {
  cells.forEach(function (html) {
    const who = readers.whoInField(html);
    who.pairs.forEach(function (p) {
      const key = pairKey(p);
      if (!pairs.has(key)) pairs.set(key, p);
      bump(into.pairs, key, by);
    });
    who.names.forEach(function (n) {
      const key = normalizeTagName(n);
      if (!names.has(key)) names.set(key, n);
      bump(into.names, key, by);
    });
  });
}

export function snapshotOwners(state: OwnerState, readers: WhoReader): OwnerSnapshot {
  const cells = new Map<string, FieldHtml>();
  const into: Tally = { pairs: new Map(), names: new Map() };
  state.rows.forEach(function (row) {
    const now = row.visualText;
    cells.set(row.id, now);
    tally([now], 1, readers, into, new Map(), new Map());
  });
  return { docId: state.docId, cells: cells, pairs: into.pairs, names: into.names };
}

function quiet(snapshot: OwnerSnapshot): OwnerSyncPlan {
  return { snapshot: snapshot, people: [], gone: [], added: [], fields: [], commit: function () {} };
}

export function planOwnerSync(was: OwnerSnapshot | null, state: OwnerState, readers: WhoReader, edits?: OwnerEdits): OwnerSyncPlan {
  if (!was || was.docId !== state.docId) return quiet(snapshotOwners(state, readers));
  const cells = new Map<string, FieldHtml>();
  const pairs = new Map<string, WhoPair>(), names = new Map<string, string>();
  const delta: Tally = { pairs: new Map(), names: new Map() };
  const rows = edits ? edits.rows : state.rows;
  const ids = edits ? null : new Set(state.rows.map(function (row) { return row.id; }));
  const removed = edits ? edits.removed : Array.from(was.cells.keys()).filter(function (id) { return !ids?.has(id); });
  const movedCells = new Map<string, number>();
  rows.forEach(function (row) {
    const old = was.cells.get(row.id), now = row.visualText;
    if (was.cells.has(row.id) && old === now) return;
    cells.set(row.id, now);
    if (old) bump(movedCells, old, 1);
    tally([old], -1, readers, delta, pairs, names);
    tally([now], 1, readers, delta, pairs, names);
  });
  removed.forEach(function (id) {
    const old = was.cells.get(id);
    if (old) bump(movedCells, old, 1);
    tally([old], -1, readers, delta, pairs, names);
  });
  if (!cells.size && !removed.length) return quiet(was);
  const plan: OwnerSyncPlan = {
    snapshot: was, people: [], gone: [], added: [], fields: [],
    commit: function () {
      cells.forEach(function (html, id) { was.cells.set(id, html); });
      removed.forEach(function (id) { was.cells.delete(id); });
      delta.pairs.forEach(function (by, key) { bump(was.pairs, key, by); });
      delta.names.forEach(function (by, key) { bump(was.names, key, by); });
    }
  };
  const people: string[] = [], gone: WhoPair[] = [], added: WhoPair[] = [], fields: string[] = [];
  cells.forEach(function (html, id) {
    if (html && movedCells.get(html)) { bump(movedCells, html, -1); return; }
    const before = new Set(readers.whoInField(was.cells.get(id)).pairs.map(function (p) { return p.sentence + "\u0000" + pairKey(p); }));
    readers.whoInField(html).pairs.forEach(function (p) {
      if (!before.has(p.sentence + "\u0000" + pairKey(p))) added.push(p);
    });
  });
  pairs.forEach(function (p, key) {
    const before = was.pairs.get(key) || 0, by = delta.pairs.get(key) || 0;
    if (before && before + by === 0) gone.push(p);
  });
  function needsPerson(name: string): void {
    if (!personNamed(state, name) && !people.some(function (n) { return normalizeTagName(n) === normalizeTagName(name); })) people.push(name);
  }
  names.forEach(function (name, key) {
    if (!was.names.get(key) && (delta.names.get(key) || 0) > 0) needsPerson(name);
  });
  added.forEach(function (p) { needsPerson(p.who); });
  if (people.length) fields.push("people");
  if (added.length || gone.length) fields.push("productionTags");
  return { ...plan, people: people, gone: gone, added: added, fields: fields };
}

export function applyOwnerSync(plan: OwnerSyncPlan, live: LiveRecords, ids: IdSource): void {
  plan.people.forEach(function (name) { addPerson(live, name, ids); });
  plan.gone.forEach(function (p) {
    const entry = registryEntry(live.productionTags, p.cat, p.name), person = personNamed(live, p.who);
    if (entry && person && entry.owner === person.id) entry.owner = "";
  });
  plan.added.forEach(function (p) {
    const entry = registryEntry(live.productionTags, p.cat, p.name), person = personNamed(live, p.who);
    if (entry && person) entry.owner = person.id;
  });
}
