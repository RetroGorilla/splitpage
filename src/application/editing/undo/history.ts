import { changeSet } from "../../session/change-set.ts";
import type { ChangeSet } from "../../session/change-set.ts";
import { STATE_FIELDS } from "../../../core/document/fields.ts";
import { idMap } from "../../../core/document/id-map.ts";
import { mergeCells } from "../../../core/merge/cells.ts";
import { LIST_MERGERS, personIdRemap, personSurvives, repointOwners } from "../../../core/merge/lists.ts";
import type { ListMerger, PersonList, PersonSurvives } from "../../../core/merge/lists.ts";
import { toHtml } from "../../../core/text/html.ts";
import { commentIds, normalizeCell } from "../../../core/text/runs.ts";
import type { Run } from "../../../core/text/runs.ts";
import { invertSteps } from "../../../core/text/steps.ts";
import type { DocFieldStep, RowFieldStep, Step, StepRow } from "../../../core/text/steps.ts";

export type CellRuns = (html: unknown) => readonly Run[];

export type UndoDocument = { rows?: StepRow[]; [key: string]: unknown };

export type UndoState = { rows: StepRow[]; [key: string]: unknown };

export interface DiffOptions {
  readonly skip?: Readonly<Record<string, boolean>>;
}

export interface Touched {
  readonly rowFields: Record<string, true>;
  structure: boolean;
  readonly doc: Record<string, true>;
  readonly items: Record<string, Record<string, true>>;
}

interface Watched {
  readonly key: string;
  readonly id: unknown;
  readonly name: unknown;
}

export interface UndoEntry {
  n: number;
  steps: Step[];
  at: number;
  cell: string | null;
  endsInSpace: boolean;
  from: string;
  evicted: UndoEntry | null;
  unassigned?: Watched[];
}

export interface CellMark {
  readonly rowId: string;
  readonly cell: string;
  readonly key: string;
  ended: boolean;
  n: number;
  value: unknown;
  top: UndoEntry | null;
  after: unknown;
  at: number | null;
  endsInSpace: boolean | null;
  lost: { under: UndoEntry | null; after: unknown } | null;
}

interface SetPlan { readonly op: "set"; readonly row: StepRow; readonly key: string; readonly value: unknown }
interface DocPlan { readonly op: "doc"; readonly key: string; readonly step?: DocFieldStep; readonly live?: unknown; readonly scan?: unknown; value?: unknown; merged?: boolean }
interface InsertPlan { readonly op: "insert"; readonly index: number; readonly row: StepRow }
interface DeletePlan { readonly op: "delete"; readonly index: number }
interface MovePlan { readonly op: "move"; readonly from: number; readonly to: number }
type PlanStep = SetPlan | DocPlan | InsertPlan | DeletePlan | MovePlan;

interface Resolved {
  readonly remap: Record<string, string> | null;
  readonly cleared: string[];
}

export interface PlannedSteps {
  readonly ok: true;
  readonly plan: PlanStep[];
  readonly resolved: Resolved;
}

export interface RefusedSteps {
  readonly ok: false;
  readonly reason: string;
}

export interface WriteReport {
  cleared?: string[];
  scanned?: DocFieldStep[];
  replayed?: DocFieldStep[];
}

export type Applied = { ok: true; cleared?: number };

export type ReplayResult = { ok: true; steps: Step[]; cleared?: number };

export type StepResult = ReplayResult | { ok: false; empty: true } | { ok: false; reason: string; steps: Step[] };

export interface RefusedReplay {
  readonly refused: string;
  readonly steps: Step[];
  readonly drop: () => void;
}

export interface ReadyReplay {
  readonly refused?: undefined;
  readonly steps: Step[];
  readonly changes: ChangeSet;
  readonly write: () => void;
  readonly finish: () => ReplayResult;
}

export type PreparedReplay = RefusedReplay | ReadyReplay;

export interface Standing {
  readonly done: boolean;
  readonly hit: boolean;
  readonly any: boolean;
  readonly later: boolean;
}

export interface UndoHistory {
  readonly record: (steps: Step[], now: number) => void;
  readonly undo: (state: UndoState) => StepResult;
  readonly redo: (state: UndoState) => StepResult;
  readonly prepare: (dir: "undo" | "redo", state: UndoState) => PreparedReplay | null;
  readonly forget: (touched: Touched) => void;
  readonly standing: (entry: UndoEntry | null | undefined, hits: (entry: UndoEntry) => boolean) => Standing;
  readonly amend: (entry: UndoEntry, steps: Step[]) => void;
  readonly breakCoalescing: () => void;
  readonly markCell: (rowId: string, key: string, value: unknown) => CellMark;
  readonly dropEmptySince: (mark: CellMark, cancelled?: boolean) => boolean;
  readonly clear: () => void;
  readonly sizes: () => { undo: number; redo: number };
  readonly top: () => UndoEntry | null;
  readonly nextRedo: () => UndoEntry | null;
  readonly mark: () => number;
}

type Owned = { id?: unknown; name?: unknown; owner?: unknown; [key: string]: unknown };

const SKIP_DOC_KEYS = idMap<true>();
STATE_FIELDS.forEach(function (f) { if (!f.undo) SKIP_DOC_KEYS[f.key] = true; });
const SKIP_ROW_KEYS: Readonly<Record<string, true>> = { id: true, updatedAt: true, updatedBy: true };
const TEXT_KEYS: Readonly<Record<string, true>> = { visualText: true, audioText: true };
const COALESCE_MS = 1000;
const MAX_ENTRIES = 200;

const LIST_MERGES = idMap<ListMerger>();
STATE_FIELDS.forEach(function (f) {
  const merger = LIST_MERGERS[f.key];
  if (merger) LIST_MERGES[f.key] = merger;
});

const OWNED_LISTS: Readonly<Record<string, true>> = { productionTags: true, brollShots: true };

function clone<T>(v: T): T { return v === undefined ? v : JSON.parse(JSON.stringify(v)) as T; }
function same(a: unknown, b: unknown): boolean { return a === b || JSON.stringify(a) === JSON.stringify(b); }

function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  const src = v as Record<string, unknown>;
  Object.keys(src).sort().forEach(function (k) { out[k] = canon(src[k]); });
  return out;
}

function sameDoc(a: unknown, b: unknown): boolean { return same(canon(a), canon(b)); }

function idKey(id: unknown): string { return String(id); }

function rowsOf(doc: UndoDocument | null | undefined): StepRow[] {
  return (doc && doc.rows) || [];
}

function headAfter(entry: UndoEntry): unknown {
  return (entry.steps[0] as RowFieldStep).after;
}

function docKeys(before: UndoDocument | null | undefined, after: UndoDocument | null | undefined): string[] {
  const keys = idMap<true>();
  STATE_FIELDS.forEach(function (f) { keys[f.key] = true; });
  Object.keys(before || {}).forEach(function (k) { keys[k] = true; });
  Object.keys(after || {}).forEach(function (k) { keys[k] = true; });
  return Object.keys(keys).filter(function (k) { return !SKIP_DOC_KEYS[k]; });
}

function rowsEqualIgnoringStamps(a: StepRow | undefined, b: StepRow | undefined): boolean {
  if (!a || !b) return false;
  const keys = idMap<true>();
  Object.keys(a).forEach(function (k) { keys[k] = true; });
  Object.keys(b).forEach(function (k) { keys[k] = true; });
  return Object.keys(keys).every(function (k) {
    return k === "updatedAt" || k === "updatedBy" || same(a[k], b[k]);
  });
}

function listOf(v: unknown): Owned[] { return Array.isArray(v) ? v as Owned[] : []; }

function ownerNames(key: string, before: UndoDocument, after: UndoDocument): Record<string, string> | null {
  if (!OWNED_LISTS[key]) return null;
  const names = idMap<string>(), out = idMap<string>();
  let any = false;
  [before, after].forEach(function (st) {
    listOf(st && st["people"]).forEach(function (p) { if (p && p.id && p.name) names[idKey(p.id)] = p.name as string; });
  });
  [before, after].forEach(function (st) {
    listOf(st && st[key]).forEach(function (e) {
      const id = e && e.owner;
      if (typeof id === "string" && id && names[id]) { out[id] = names[id]; any = true; }
    });
  });
  return any ? out : null;
}

export function diffStates(before: UndoDocument, after: UndoDocument, opts?: DiffOptions | null): Step[] {
  const skip = (opts && opts.skip) || {};
  const steps: Step[] = [];
  const bRows = rowsOf(before), aRows = rowsOf(after);
  const aById = idMap<StepRow>(), bById = idMap<StepRow>();
  aRows.forEach(function (r) { if (r && r.id) aById[idKey(r.id)] = r; });
  bRows.forEach(function (r) { if (r && r.id) bById[idKey(r.id)] = r; });

  const work: unknown[] = bRows.map(function (r) { return r.id; });
  let i: number;
  for (i = work.length - 1; i >= 0; i--) {
    if (!aById[idKey(work[i])]) {
      steps.push({ op: "deleteRow", index: i, row: clone(bById[idKey(work[i])]) as StepRow });
      work.splice(i, 1);
    }
  }
  work.forEach(function (id) {
    const b = bById[idKey(id)] as StepRow, a = aById[idKey(id)] as StepRow;
    const keys = idMap<true>();
    Object.keys(b).forEach(function (k) { keys[k] = true; });
    Object.keys(a).forEach(function (k) { keys[k] = true; });
    Object.keys(keys).forEach(function (k) {
      if (SKIP_ROW_KEYS[k] || same(b[k], a[k])) return;
      steps.push({ op: "rowField", rowId: id as string, key: k, before: clone(b[k]), after: clone(a[k]) });
    });
  });
  for (i = 0; i < aRows.length; i++) {
    const want = (aRows[i] as StepRow).id;
    if (work[i] === want) continue;
    const j = work.indexOf(want);
    if (j === -1) {
      steps.push({ op: "insertRow", index: i, row: clone(aRows[i]) as StepRow });
      work.splice(i, 0, want);
    } else {
      steps.push({ op: "moveRow", from: j, to: i });
      work.splice(j, 1);
      work.splice(i, 0, want);
    }
  }
  docKeys(before, after).forEach(function (k) {
    if (skip[k] || same(before[k], after[k])) return;
    const step: DocFieldStep = { op: "docField", key: k, before: clone(before[k]), after: clone(after[k]) };
    const owners = ownerNames(k, before, after);
    if (owners) step.owners = owners;
    steps.push(step);
  });
  return steps;
}

function listMergeFor(key: string): ListMerger | null {
  return LIST_MERGES[key] || null;
}

function resolveCell(runs: CellRuns, live: unknown, step: { before: unknown; after: unknown }): { value: unknown } | null {
  if (live === step.before) return { value: step.after };
  const mine = runs(live), base = runs(step.before), want = runs(step.after);
  if (JSON.stringify(mine) === JSON.stringify(base)) return { value: step.after };
  const r = mergeCells(base, mine, want);
  if (r.conflict) return null;
  return { value: toHtml(normalizeCell(r.cell)) };
}

function repointed(key: string, value: unknown, remap?: Record<string, string> | null): unknown {
  const copy = clone(value);
  if (remap && OWNED_LISTS[key] && Array.isArray(copy)) repointOwners([copy], remap);
  return copy;
}

function itemKey(key: string, e: { readonly id?: unknown; readonly name?: unknown }): string { return key + "\u0000" + String(e.id || e.name || ""); }

function ownerChanges(key: string, before: unknown, after: unknown): Record<string, { from: unknown; to: unknown }> {
  const was = idMap<unknown>(), out = idMap<{ from: unknown; to: unknown }>();
  listOf(before).forEach(function (e) { if (e) was[itemKey(key, e)] = e.owner || ""; });
  listOf(after).forEach(function (e) {
    if (!e) return;
    const k = itemKey(key, e), to = e.owner || "";
    if (was[k] !== undefined && was[k] !== to) out[k] = { from: was[k], to: to };
  });
  return out;
}

function ownersReplayed(key: string, live: unknown, before: unknown, after: unknown): unknown {
  if (!Array.isArray(live)) return clone(live);
  const changes = ownerChanges(key, before, after);
  return (live as Owned[]).map(function (e) {
    const c = e && changes[itemKey(key, e)];
    if (!c || (e.owner || "") !== c.from) return clone(e);
    return Object.assign(clone(e), { owner: c.to });
  });
}

function ownersTouched(step: DocFieldStep, items: Record<string, true> | undefined): boolean {
  return !items || Object.keys(ownerChanges(step.key, step.before, step.after)).some(function (k) { return !!items[k]; });
}

function resolveDoc(state: UndoState, p: DocPlan, survives?: PersonSurvives, remap?: Record<string, string> | null): void {
  const step = p.step as DocFieldStep;
  const live = state[p.key];
  const before = repointed(p.key, step.before, remap), after = repointed(p.key, step.after, remap);
  if (same(live, step.before) || sameDoc(live, before)) { p.value = after; return; }
  if (step.ownersOnly && OWNED_LISTS[p.key]) { p.value = ownersReplayed(p.key, live, before, after); return; }
  p.value = (listMergeFor(p.key) as ListMerger)(before, clone(live), after, survives);
  p.merged = true;
}

function resolveDocFields(state: UndoState, plan: PlanStep[]): Resolved {
  const docs = plan.filter(function (p): p is DocPlan { return p.op === "doc"; });
  if (!docs.length) return { remap: null, cleared: [] };
  const people = docs.filter(function (p) { return p.key === "people"; })[0];
  if (people) resolveDoc(state, people);
  const sides: Owned[] = listOf(state["people"]).concat(people ? listOf((people.step as DocFieldStep).after) : []);
  docs.forEach(function (p) {
    const owners = (p.step as DocFieldStep).owners;
    if (owners) Object.keys(owners).forEach(function (id) { sides.push({ id: id, name: owners[id] }); });
  });
  const kept = (people ? people.value : state["people"]) as PersonList;
  const survives = personSurvives(sides as PersonList, kept);
  const remap = !people || people.merged ? personIdRemap(sides as PersonList, kept) : null;
  docs.forEach(function (p) { if (p !== people) resolveDoc(state, p, survives, remap); });
  const crew = idMap<true>();
  listOf(kept).forEach(function (e) { if (e && e.id) crew[idKey(e.id)] = true; });
  const cleared: string[] = [];
  let touched = false;
  const rescue = remap || personIdRemap(sides as PersonList, kept);
  function orphansCleared(key: string, list: Owned[]): Owned[] {
    return list.map(function (e) {
      if (!e || typeof e.owner !== "string" || !e.owner || crew[e.owner]) return e;
      const moved = rescue[e.owner];
      if (crew[String(moved)]) {
        if (remap) return e;
        touched = true;
        return Object.assign({}, e, { owner: moved });
      }
      cleared.push(itemKey(key, e));
      touched = true;
      return Object.assign({}, e, { owner: "" });
    });
  }
  docs.forEach(function (p) {
    if (OWNED_LISTS[p.key] && Array.isArray(p.value)) p.value = orphansCleared(p.key, p.value as Owned[]);
  });
  if (people) Object.keys(OWNED_LISTS).forEach(function (key) {
    if (docs.some(function (p) { return p.key === key; }) || !Array.isArray(state[key])) return;
    touched = false;
    const value = orphansCleared(key, state[key] as Owned[]);
    if (touched) plan.push({ op: "doc", key: key, value: value, scan: clone(state[key]) });
  });
  return { remap: remap, cleared: cleared };
}

function ownerAt(state: UndoState, w: Watched): unknown {
  const hit = listOf(state[w.key]).filter(function (e) { return e && itemKey(w.key, e) === itemKey(w.key, w); })[0];
  return hit && hit.owner || "";
}

function foldScan(entry: UndoEntry, scanned: DocFieldStep[], replayed: DocFieldStep[], invert: boolean): void {
  const forward = invert ? invertSteps(scanned) : scanned;
  forward.forEach(function (s) {
    (s as DocFieldStep).ownersOnly = true;
    entry.steps.push(s);
  });
  replayed.forEach(function (s) {
    const at = entry.steps.findIndex(function (e) { return e.op === "docField" && e.ownersOnly && e.key === s.key; });
    entry.steps[at] = { op: "docField", key: s.key, before: clone(invert ? s.after : s.before), after: clone(invert ? s.before : s.after), ownersOnly: true };
  });
  entry.cell = null;
  const watch = entry.unassigned || (entry.unassigned = []);
  const seen = idMap<true>();
  watch.forEach(function (w) { seen[itemKey(w.key, w)] = true; });
  scanned.concat(replayed).forEach(function (s) {
    const after = idMap<Owned>();
    listOf(s.after).forEach(function (e) { if (e) after[itemKey(s.key, e)] = e; });
    listOf(s.before).forEach(function (e) {
      if (!e || !e.owner) return;
      const k = itemKey(s.key, e), now = after[k];
      if (!now || now.owner || seen[k]) return;
      seen[k] = true;
      watch.push({ key: s.key, id: e.id, name: e.name });
    });
  });
}

function repointLists(state: UndoState, remap: Record<string, string>): void {
  ["productionTags", "brollShots"].forEach(function (key) {
    if (!Array.isArray(state[key])) return;
    const copy = clone(state[key]);
    repointOwners([copy], remap);
    if (!same(copy, state[key])) state[key] = copy;
  });
}

export function planSteps(runs: CellRuns, state: UndoState, steps: readonly Step[]): PlannedSteps | RefusedSteps {
  const order: unknown[] = state.rows.map(function (r) { return r.id; });
  const byId = idMap<StepRow>();
  state.rows.forEach(function (r) { byId[idKey(r.id)] = r; });
  const plan: PlanStep[] = [];
  for (let n = 0; n < steps.length; n++) {
    const s = steps[n] as Step;
    if (s.op === "rowField") {
      const row = byId[s.rowId];
      if (!row || order.indexOf(s.rowId) === -1) return { ok: false, reason: "a scene it changed has gone" };
      if (TEXT_KEYS[s.key]) {
        const cell = resolveCell(runs, row[s.key] == null ? "" : row[s.key], {
          before: s.before == null ? "" : s.before, after: s.after == null ? "" : s.after
        });
        if (!cell) return { ok: false, reason: "that scene's text has changed since" };
        plan.push({ op: "set", row: row, key: s.key, value: cell.value });
      } else {
        if (!same(row[s.key], s.before)) return { ok: false, reason: "that scene has changed since" };
        plan.push({ op: "set", row: row, key: s.key, value: clone(s.after) });
      }
    } else if (s.op === "docField") {
      if (!same(state[s.key], s.before) && !listMergeFor(s.key)) return { ok: false, reason: "it has changed since" };
      plan.push({ op: "doc", key: s.key, step: s, live: s.ownersOnly ? clone(state[s.key]) : undefined });
    } else if (s.op === "insertRow") {
      const id = idKey(s.row.id);
      if (s.index < 0 || s.index > order.length || byId[id] && order.indexOf(s.row.id) !== -1) {
        return { ok: false, reason: "the scene list has changed since" };
      }
      order.splice(s.index, 0, s.row.id);
      const copy = clone(s.row);
      byId[id] = copy;
      plan.push({ op: "insert", index: s.index, row: copy });
    } else if (s.op === "deleteRow") {
      if (order[s.index] !== s.row.id || !rowsEqualIgnoringStamps(byId[idKey(s.row.id)], s.row)) {
        return { ok: false, reason: "that scene has changed since" };
      }
      order.splice(s.index, 1);
      plan.push({ op: "delete", index: s.index });
    } else if (s.op === "moveRow") {
      if (!order[s.from] || s.to < 0 || s.to >= order.length) return { ok: false, reason: "the scene list has changed since" };
      order.splice(s.to, 0, order.splice(s.from, 1)[0]);
      plan.push({ op: "move", from: s.from, to: s.to });
    } else {
      return { ok: false, reason: "unknown step" };
    }
  }
  return { ok: true, plan: plan, resolved: resolveDocFields(state, plan) };
}

export function writePlanned(state: UndoState, planned: PlannedSteps, out?: WriteReport | null): Applied {
  const plan = planned.plan, resolved = planned.resolved, remap = resolved.remap;
  plan.forEach(function (p) {
    if (p.op === "set") {
      if (p.value === undefined) Reflect.deleteProperty(p.row, p.key); else p.row[p.key] = p.value;
    } else if (p.op === "doc") {
      if (p.value === undefined) Reflect.deleteProperty(state, p.key); else state[p.key] = p.value;
    } else if (p.op === "insert") {
      state.rows.splice(p.index, 0, p.row);
    } else if (p.op === "delete") {
      state.rows.splice(p.index, 1);
    } else {
      state.rows.splice(p.to, 0, state.rows.splice(p.from, 1)[0] as StepRow);
    }
  });
  if (remap) repointLists(state, remap);
  if (out) {
    out.cleared = resolved.cleared;
    out.scanned = plan.filter(function (p): p is DocPlan { return p.op === "doc" && !!p.scan; }).map(function (p) {
      return { op: "docField", key: p.key, before: p.scan, after: clone(state[p.key]) };
    });
    out.replayed = plan.filter(function (p): p is DocPlan { return p.op === "doc" && !!p.step && !!p.step.ownersOnly; }).map(function (p) {
      return { op: "docField", key: p.key, before: p.live, after: clone(state[p.key]) };
    });
  }
  return resolved.cleared.length ? { ok: true, cleared: resolved.cleared.length } : { ok: true };
}

export function applyStepsLive(runs: CellRuns, state: UndoState, steps: readonly Step[], out?: WriteReport | null): Applied | RefusedSteps {
  const planned = planSteps(runs, state, steps);
  return planned.ok ? writePlanned(state, planned, out) : planned;
}

export function replayChanges(runs: CellRuns, steps: readonly Step[], planned: PlannedSteps): ChangeSet {
  const cells: { rowId: string; field: string }[] = [], inserted: string[] = [], removed: string[] = [], docFields: string[] = [];
  let moved = false, runsMoved = false;
  function field(rowId: string, key: string): void {
    if (!cells.some(function (c) { return c.rowId === rowId && c.field === key; })) cells.push({ rowId: rowId, field: key });
  }
  function docField(key: string): void { if (docFields.indexOf(key) === -1) docFields.push(key); }
  steps.forEach(function (s) {
    if (s.op === "rowField") {
      field(s.rowId, s.key);
      field(s.rowId, "updatedAt");
      field(s.rowId, "updatedBy");
    } else if (s.op === "insertRow") {
      inserted.push(s.row.id as string);
    } else if (s.op === "deleteRow") {
      removed.push(s.row.id as string);
    } else if (s.op === "moveRow") {
      moved = true;
    }
  });
  planned.plan.forEach(function (p) {
    if (p.op === "doc") docField(p.key);
    if (p.op === "set" && TEXT_KEYS[p.key] && !sameIds(runs, p.row[p.key], p.value)) runsMoved = true;
  });
  if (planned.resolved.remap) Object.keys(OWNED_LISTS).forEach(docField);
  return changeSet({ cells: cells, rowsInserted: inserted, rowsRemoved: removed, rowsMoved: moved, runsMoved: runsMoved, docFields: docFields });
}

function sameIds(runs: CellRuns, before: unknown, after: unknown): boolean {
  return same(commentIds(runs(before)), commentIds(runs(after)));
}

function onlyCell(steps: readonly Step[]): string | null {
  if (steps.length !== 1) return null;
  const s = steps[0] as Step;
  return s.op === "rowField" && TEXT_KEYS[s.key] ? s.rowId + "\u0000" + s.key : null;
}

function insertedText(a: string, b: string): string {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let sa = a.length, sb = b.length;
  while (sa > p && sb > p && a[sa - 1] === b[sb - 1]) { sa--; sb--; }
  return b.slice(p, sb);
}

function projectionOf(runs: CellRuns, html: unknown): string {
  let out = "";
  normalizeCell(runs(html)).forEach(function (r) { out += r.atom ? "￼" : r.text; });
  return out;
}

export function cosmetic(runs: CellRuns, step: { readonly op: string; readonly key?: string; readonly before?: unknown; readonly after?: unknown }): boolean {
  if (step.op !== "rowField" || !TEXT_KEYS[step.key as string]) return false;
  return JSON.stringify(runs(step.before)) === JSON.stringify(runs(step.after));
}

export function createUndoHistory(runs: CellRuns): UndoHistory {
  const done: UndoEntry[] = [], undone: UndoEntry[] = [];
  let serial = 0;
  let parked: { redo: UndoEntry[]; top: UndoEntry | null; after: unknown; text: string | null } | null = null;
  let current: CellMark | null = null;

  function backAtPark(text?: string): boolean {
    const top = done[done.length - 1] || null;
    if (!parked || top !== parked.top) return false;
    if (top && headAfter(top) !== parked.after) {
      if (!onlyCell(top.steps)) return false;
      if ((text === undefined ? projectionOf(runs, headAfter(top)) : text) !== parked.text) return false;
      if (!cosmetic(runs, { op: "rowField", key: (top.steps[0] as RowFieldStep).key, before: parked.after, after: headAfter(top) })) return false;
    }
    return true;
  }

  function park(top: UndoEntry | undefined): void {
    parked = {
      redo: undone.slice(), top: top || null,
      after: top && headAfter(top),
      text: top && onlyCell(top.steps) ? projectionOf(runs, headAfter(top)) : null
    };
    undone.length = 0;
  }

  function unpark(text?: string): void {
    if (undone.length || !backAtPark(text) || !parked) return;
    for (let i = 0; i < parked.redo.length; i++) undone.push(parked.redo[i] as UndoEntry);
    parked = null;
  }

  function record(steps: Step[], now: number): void {
    if (!steps.length) return;
    const cell = onlyCell(steps);
    const last = done[done.length - 1];
    if (undone.length) park(last);
    const first = steps[0] as RowFieldStep;
    const from = cell ? projectionOf(runs, first.before) : "", to = cell ? projectionOf(runs, first.after) : "";
    const ins = cell ? insertedText(from, to) : "";
    if (cell && last && last.cell === cell && now - last.at < COALESCE_MS) {
      const startsWord = /\S/.test(ins) && last.endsInSpace;
      if (!startsWord) {
        const lastStep = last.steps[0] as RowFieldStep;
        lastStep.after = first.after;
        last.at = now;
        if (ins) last.endsInSpace = /\s$/.test(ins);
        if (last.from === to && cosmetic(runs, lastStep)) {
          dropFrom(done.length - 1);
          if (current && last === current.top) current.lost = below();
          unpark();
        } else if (parked) {
          unpark(to);
        }
        return;
      }
    }
    push({ n: ++serial, steps: steps, at: now, cell: cell, endsInSpace: /\s$/.test(ins), from: from, evicted: null });
  }

  function push(entry: UndoEntry): void {
    done.push(entry);
    if (done.length > MAX_ENTRIES) {
      const evicted = done.shift() as UndoEntry;
      entry.evicted = evicted;
      evicted.evicted = null;
    }
  }

  function dropFrom(k: number): void {
    const gone = done.splice(k);
    for (let i = gone.length - 1; i >= 0; i--) {
      const evicted = (gone[i] as UndoEntry).evicted;
      if (evicted) done.unshift(evicted);
    }
  }

  function below(): { under: UndoEntry | null; after: unknown } {
    const under = done[done.length - 1] || null;
    return { under: under, after: under && headAfter(under) };
  }

  function fill(mark: CellMark, value: unknown): CellMark {
    const top = done[done.length - 1] || null;
    mark.n = serial;
    mark.value = value;
    mark.top = top;
    mark.after = top && headAfter(top);
    mark.at = top && top.at;
    mark.endsInSpace = top && top.endsInSpace;
    mark.lost = null;
    return mark;
  }

  function markCell(rowId: string, key: string, value: unknown): CellMark {
    current = fill({ rowId: rowId, cell: rowId + "\u0000" + key, key: key, ended: false, n: 0, value: undefined, top: null, after: null, at: null, endsInSpace: null, lost: null }, value);
    return current;
  }

  function joinedTop(mark: CellMark): boolean {
    const top = mark.top;
    return !!top && onlyCell(top.steps) === mark.cell && (headAfter(top) !== mark.after || top.at !== mark.at);
  }

  function putBack(mark: CellMark): void {
    const top = mark.top as UndoEntry;
    (top.steps[0] as RowFieldStep).after = mark.after;
    top.at = mark.at as number;
    top.endsInSpace = mark.endsInSpace as boolean;
  }

  function remark(mark: CellMark, state: UndoState): void {
    if (joinedTop(mark)) putBack(mark);
    const rows = (state && state.rows) || [];
    let value: unknown;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row && row.id === mark.rowId) value = row[mark.key];
    }
    fill(mark, value);
  }

  function dropEmptySince(mark: CellMark, cancelled?: boolean): boolean {
    if (mark !== current) return false;
    mark.ended = true;
    let k = done.length;
    while (k > 0 && (done[k - 1] as UndoEntry).n > mark.n) k--;
    const top = mark.top;
    const joined = done[k - 1] === top && joinedTop(mark);
    const lost = !!mark.lost && (done[k - 1] || null) === mark.lost.under &&
      (!mark.lost.under || headAfter(mark.lost.under) === mark.lost.after);
    if (k === done.length && !joined) return false;
    if (!joined && !lost && !cosmetic(runs, { op: "rowField", key: mark.key, before: mark.value, after: ((done[k] as UndoEntry).steps[0] as RowFieldStep).before })) return false;
    for (let i = k; i < done.length; i++) if (onlyCell((done[i] as UndoEntry).steps) !== mark.cell) return false;
    const end = (k < done.length ? done[done.length - 1] : top) as UndoEntry;
    const after = headAfter(end);
    const back = cosmetic(runs, { op: "rowField", key: mark.key, before: mark.value, after: after });
    if (!back && (!cancelled || k === done.length)) return false;
    const from = projectionOf(runs, mark.value);
    const one: UndoEntry | null = back ? null : {
      n: (done[k] as UndoEntry).n,
      steps: [{ op: "rowField", rowId: (end.steps[0] as RowFieldStep).rowId, key: mark.key, before: mark.value, after: after }],
      at: end.at, cell: mark.cell, endsInSpace: /\s$/.test(insertedText(from, projectionOf(runs, after))), from: from, evicted: null
    };
    dropFrom(k);
    if (joined || lost) putBack(mark);
    if (lost) push(top as UndoEntry);
    if (one) {
      push(one);
      return false;
    }
    unpark();
    return true;
  }

  function prepare(dir: "undo" | "redo", state: UndoState): PreparedReplay | null {
    const invert = dir === "undo";
    const from = invert ? done : undone, to = invert ? undone : done;
    const entry = from[from.length - 1];
    if (!entry) return null;
    const steps = invert ? invertSteps(entry.steps) : entry.steps.slice();
    const planned = planSteps(runs, state, steps);
    function marked(ok: boolean): void {
      const mark = current;
      if (!mark || mark.ended) return;
      if ((entry as UndoEntry).n <= mark.n) remark(mark, state);
      if (ok) mark.ended = true;
    }
    if (!planned.ok) {
      return {
        refused: planned.reason,
        steps: steps,
        drop: function () {
          if (from[from.length - 1] === entry) from.pop();
          parked = null;
          marked(false);
        }
      };
    }
    const watch = entry.unassigned || [];
    const had = watch.map(function (w) { return ownerAt(state, w); });
    let out: WriteReport = {};
    return {
      steps: steps,
      changes: replayChanges(runs, steps, planned),
      write: function () {
        out = {};
        writePlanned(state, planned, out);
      },
      finish: function () {
        const ids = idMap<true>();
        (out.cleared as string[]).forEach(function (k) { ids[k] = true; });
        watch.forEach(function (w, i) { if (had[i] && !ownerAt(state, w)) ids[itemKey(w.key, w)] = true; });
        const scanned = out.scanned as DocFieldStep[], replayed = out.replayed as DocFieldStep[];
        if (scanned.length || replayed.length) foldScan(entry, scanned, replayed, invert);
        from.pop();
        to.push(entry);
        marked(true);
        const count = Object.keys(ids).length;
        return count ? { ok: true, steps: steps, cleared: count } : { ok: true, steps: steps };
      }
    };
  }

  function step(dir: "undo" | "redo", state: UndoState): StepResult {
    const p = prepare(dir, state);
    if (!p) return { ok: false, empty: true };
    if (p.refused !== undefined) {
      p.drop();
      return { ok: false, reason: p.refused, steps: p.steps };
    }
    p.write();
    return p.finish();
  }

  function forget(touched: Touched): void {
    function hits(entry: UndoEntry): boolean {
      return entry.steps.some(function (s) {
        if (s.op === "rowField") return !!touched.rowFields[s.rowId + "\u0000" + s.key];
        if (s.op === "docField") return !!touched.doc[s.key] && (!s.ownersOnly || ownersTouched(s, touched.items && touched.items[s.key]));
        return !!touched.structure;
      });
    }
    function keep(list: UndoEntry[]): void {
      const kept = list.filter(function (e) { return !hits(e); });
      list.length = 0;
      kept.forEach(function (e) { list.push(e); });
    }
    const had = done.length + undone.length;
    keep(done);
    keep(undone);
    if (done.length + undone.length !== had) parked = null;
    if (parked) keep(parked.redo);
    done.forEach(function (e) { if (e.evicted && hits(e.evicted)) e.evicted = null; });
  }

  function standing(entry: UndoEntry | null | undefined, hits: (entry: UndoEntry) => boolean): Standing {
    const at = entry ? done.indexOf(entry) : -1;
    return {
      done: at !== -1,
      hit: at !== -1 && hits(entry as UndoEntry),
      any: done.some(hits) || undone.some(hits),
      later: done.slice(at + 1).some(hits) || undone.some(hits)
    };
  }

  function amend(entry: UndoEntry, steps: Step[]): void {
    steps.forEach(function (s) {
      const mine = s.op === "rowField" && entry.steps.filter(function (e): e is RowFieldStep {
        return e.op === "rowField" && e.rowId === s.rowId && e.key === s.key;
      })[0];
      if (mine) mine.after = s.after;
      else entry.steps.push(s);
    });
    entry.cell = null;
  }

  return {
    record: record,
    undo: function (state) { return step("undo", state); },
    redo: function (state) { return step("redo", state); },
    prepare: prepare,
    forget: forget,
    standing: standing,
    amend: amend,
    breakCoalescing: function () { const last = done[done.length - 1]; if (last) last.cell = null; },
    markCell: markCell,
    dropEmptySince: dropEmptySince,
    clear: function () { done.length = 0; undone.length = 0; parked = null; current = null; },
    sizes: function () { return { undo: done.length, redo: undone.length }; },
    top: function () { return done[done.length - 1] || null; },
    nextRedo: function () { return undone[undone.length - 1] || null; },
    mark: function () { return serial; }
  };
}

export function changedBetween(prev: UndoDocument | null | undefined, next: UndoDocument | null | undefined): Touched {
  const out: Touched = { rowFields: {}, structure: false, doc: {}, items: {} };
  const p = rowsOf(prev), n = rowsOf(next);
  const pById = idMap<StepRow>();
  p.forEach(function (r) { if (r) pById[idKey(r.id)] = r; });
  if (p.length !== n.length || p.some(function (r, i) { const m = n[i]; return !m || m.id !== r.id; })) out.structure = true;
  n.forEach(function (r) {
    const o = pById[idKey(r.id)];
    if (!o) return;
    const keys = idMap<true>();
    Object.keys(o).forEach(function (k) { keys[k] = true; });
    Object.keys(r).forEach(function (k) { keys[k] = true; });
    Object.keys(keys).forEach(function (k) {
      if (!SKIP_ROW_KEYS[k] && !same(o[k], r[k])) out.rowFields[idKey(r.id) + "\u0000" + k] = true;
    });
  });
  docKeys(prev, next).forEach(function (k) {
    if (same(prev && prev[k], next && next[k])) return;
    out.doc[k] = true;
    if (OWNED_LISTS[k]) out.items[k] = itemsChanged(k, prev && prev[k], next && next[k]);
  });
  return out;
}

function itemsChanged(key: string, prev: unknown, next: unknown): Record<string, true> {
  function byItem(list: unknown): Record<string, Owned[]> {
    const out = idMap<Owned[]>();
    listOf(list).forEach(function (e) {
      const k = itemKey(key, e || {});
      (out[k] || (out[k] = [])).push(e);
    });
    return out;
  }
  const was = byItem(prev), now = byItem(next), out = idMap<true>();
  Object.keys(was).concat(Object.keys(now)).forEach(function (k) {
    if (!sameDoc(was[k], now[k])) out[k] = true;
  });
  return out;
}
