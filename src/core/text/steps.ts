export type StepRow = { id?: unknown; [key: string]: unknown };

export type StepState = { rows?: (StepRow | null | undefined)[] | null | undefined; [key: string]: unknown };

export type RowFieldStep = { op: "rowField"; rowId: string; key: string; before?: unknown; after?: unknown };

export type DocFieldStep = { op: "docField"; key: string; before?: unknown; after?: unknown; owners?: Record<string, string>; ownersOnly?: true };

export type InsertRowStep = { op: "insertRow"; index: number; row: StepRow };

export type DeleteRowStep = { op: "deleteRow"; index: number; row: StepRow };

export type MoveRowStep = { op: "moveRow"; from: number; to: number };

export type Step = RowFieldStep | DocFieldStep | InsertRowStep | DeleteRowStep | MoveRowStep;

export type StepRefused = Error & { code: "STEP_REFUSED" };

function clone<T>(v: T): T { return v === undefined ? undefined as T : JSON.parse(JSON.stringify(v)) as T; }
function keysInOrder(_key: string, v: unknown): unknown {
  if (!v || typeof v !== "object") return v;
  const proto: unknown = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;
  const out: Record<string, unknown> = Object.create(null);
  Object.keys(v).sort().forEach(function (k) { out[k] = (v as Record<string, unknown>)[k]; });
  return out;
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b) || JSON.stringify(a, keysInOrder) === JSON.stringify(b, keysInOrder);
}

function stepRefused(step: Step, why: string): StepRefused {
  const err = new Error("step does not apply: " + step.op + " (" + why + ")") as StepRefused;
  err.code = "STEP_REFUSED";
  return err;
}

function applyStep(state: StepState, step: Step): StepState {
  const rows = state.rows || [];
  const next: StepState = Object.assign({}, state);
  let i: number;
  if (step.op === "rowField") {
    i = rows.findIndex(function (r) { return r && r.id === step.rowId; });
    if (i === -1) throw stepRefused(step, "no row " + step.rowId);
    if (!same((rows[i] as StepRow)[step.key], step.before)) throw stepRefused(step, step.key + " has changed");
    next.rows = rows.slice();
    const row: StepRow = next.rows[i] = Object.assign({}, rows[i]);
    if (step.after === undefined) Reflect.deleteProperty(row, step.key);
    else row[step.key] = clone(step.after);
  } else if (step.op === "docField") {
    if (!same(state[step.key], step.before)) throw stepRefused(step, step.key + " has changed");
    if (step.after === undefined) Reflect.deleteProperty(next, step.key);
    else next[step.key] = clone(step.after);
  } else if (step.op === "insertRow") {
    if (step.index < 0 || step.index > rows.length) throw stepRefused(step, "index " + step.index);
    if (rows.some(function (r) { return r && r.id === step.row.id; })) throw stepRefused(step, "row exists");
    next.rows = rows.slice();
    next.rows.splice(step.index, 0, clone(step.row));
  } else if (step.op === "deleteRow") {
    if (!rows[step.index] || !same(rows[step.index], step.row)) throw stepRefused(step, "row has changed");
    next.rows = rows.slice();
    next.rows.splice(step.index, 1);
  } else if (step.op === "moveRow") {
    if (!rows[step.from] || step.to < 0 || step.to >= rows.length) throw stepRefused(step, "index");
    next.rows = rows.slice();
    const moved = next.rows.splice(step.from, 1)[0];
    next.rows.splice(step.to, 0, moved);
  } else {
    throw stepRefused(step, "unknown op");
  }
  return next;
}

export function applySteps<T extends StepState>(state: T, steps: readonly Step[] | null | undefined): T {
  return (steps || []).reduce(applyStep, state) as T;
}

export function invertSteps(steps: readonly Step[] | null | undefined): Step[] {
  return (steps || []).slice().reverse().map(function (s): Step {
    if (s.op === "rowField") return { op: "rowField", rowId: s.rowId, key: s.key, before: clone(s.after), after: clone(s.before) };
    if (s.op === "docField") {
      const inverse: Step = { op: "docField", key: s.key, before: clone(s.after), after: clone(s.before) };
      if (s.owners) inverse.owners = clone(s.owners);
      if (s.ownersOnly) inverse.ownersOnly = true;
      return inverse;
    }
    if (s.op === "insertRow") return { op: "deleteRow", index: s.index, row: clone(s.row) };
    if (s.op === "deleteRow") return { op: "insertRow", index: s.index, row: clone(s.row) };
    if (s.op === "moveRow") return { op: "moveRow", from: s.to, to: s.from };
    throw stepRefused(s, "unknown op");
  });
}

export function touchedCells(steps: readonly Step[] | null | undefined): string[] {
  const out: string[] = [];
  function add(k: string): void { if (out.indexOf(k) === -1) out.push(k); }
  (steps || []).forEach(function (s) {
    if (s.op === "rowField" && (s.key === "visualText" || s.key === "audioText")) add(s.rowId + "\u0000" + s.key);
    if ((s.op === "insertRow" || s.op === "deleteRow") && s.row) {
      add(s.row.id + "\u0000visualText");
      add(s.row.id + "\u0000audioText");
    }
  });
  return out;
}
