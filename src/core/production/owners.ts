import type { IdSource } from "../document/ports.ts";
import { normalizeTagName, registryKey } from "../document/tags.ts";
import { addPerson, personNamed } from "./records.ts";
import type { LiveRecords } from "./records.ts";
import { registryEntry, TAG_FIELDS } from "./tags.ts";
import type { RegistryList } from "./tags.ts";
import type { FieldHtml, ProductionReaders, ProductionRow, WhoPair } from "./ports.ts";

type WhoReader = Pick<ProductionReaders, "whoInField">;

type Tally = { pairs: Map<string, number>; names: Map<string, number> };

export type OwnerSnapshot = {
  readonly docId: unknown;
  readonly cells: ReadonlyMap<string, readonly FieldHtml[]>;
  readonly pairs: ReadonlyMap<string, number>;
  readonly names: ReadonlyMap<string, number>;
};

export type OwnerState = { readonly docId?: unknown; readonly rows: readonly ProductionRow[]; readonly productionTags: RegistryList; readonly [key: string]: unknown };

export type OwnerSyncPlan = {
  readonly snapshot: OwnerSnapshot;
  readonly people: readonly string[];
  readonly gone: readonly WhoPair[];
  readonly added: readonly WhoPair[];
  readonly fields: readonly string[];
};

function pairKey(p: WhoPair): string {
  return registryKey(p.cat, p.name) + "\u0000" + normalizeTagName(p.who);
}

function fieldsOf(row: ProductionRow): FieldHtml[] {
  return TAG_FIELDS.map(function (f) { return row[f]; });
}

function sameCells(a: readonly FieldHtml[] | undefined, b: readonly FieldHtml[]): boolean {
  return !!a && a.length === b.length && a.every(function (v, i) { return v === b[i]; });
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
  const cells = new Map<string, readonly FieldHtml[]>();
  const into: Tally = { pairs: new Map(), names: new Map() };
  state.rows.forEach(function (row) {
    const now = fieldsOf(row);
    cells.set(row.id, now);
    tally(now, 1, readers, into, new Map(), new Map());
  });
  return { docId: state.docId, cells: cells, pairs: into.pairs, names: into.names };
}

function quiet(snapshot: OwnerSnapshot): OwnerSyncPlan {
  return { snapshot: snapshot, people: [], gone: [], added: [], fields: [] };
}

export function planOwnerSync(was: OwnerSnapshot | null, state: OwnerState, readers: WhoReader): OwnerSyncPlan {
  if (!was || was.docId !== state.docId) return quiet(snapshotOwners(state, readers));
  const cells = new Map<string, readonly FieldHtml[]>();
  const pairs = new Map<string, WhoPair>(), names = new Map<string, string>();
  const moved: { tally: Tally | null } = { tally: null };
  function change(old: readonly FieldHtml[] | undefined, now: readonly FieldHtml[]): void {
    const counts = moved.tally || (moved.tally = { pairs: new Map(was?.pairs), names: new Map(was?.names) });
    if (old) tally(old, -1, readers, counts, pairs, names);
    tally(now, 1, readers, counts, pairs, names);
  }
  let kept = 0;
  state.rows.forEach(function (row) {
    const old = was.cells.get(row.id), now = fieldsOf(row);
    if (old) kept++;
    if (sameCells(old, now)) { cells.set(row.id, old as readonly FieldHtml[]); return; }
    cells.set(row.id, now);
    change(old, now);
  });
  if (kept !== was.cells.size) {
    was.cells.forEach(function (old, id) { if (!cells.has(id)) change(old, []); });
  }
  const after = moved.tally;
  if (!after) return quiet({ docId: was.docId, cells: cells, pairs: was.pairs, names: was.names });
  const plan = { snapshot: { docId: was.docId, cells: cells, pairs: after.pairs, names: after.names }, people: [] as string[], gone: [] as WhoPair[], added: [] as WhoPair[], fields: [] as string[] };
  pairs.forEach(function (p, key) {
    const before = was.pairs.get(key) || 0, now = after.pairs.get(key) || 0;
    if (!before && now) plan.added.push(p);
    else if (before && !now) plan.gone.push(p);
  });
  function needsPerson(name: string): void {
    if (!personNamed(state, name) && !plan.people.some(function (n) { return normalizeTagName(n) === normalizeTagName(name); })) plan.people.push(name);
  }
  names.forEach(function (name, key) {
    if (!was.names.get(key) && after.names.get(key)) needsPerson(name);
  });
  plan.added.forEach(function (p) { needsPerson(p.who); });
  if (plan.people.length) plan.fields.push("people");
  if (plan.added.length || plan.gone.length) plan.fields.push("productionTags");
  return plan;
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
