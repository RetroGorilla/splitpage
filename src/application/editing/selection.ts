import { resolveSelection, takeSnapshot } from "../../core/text/selection.ts";
import type { ModelSelection, SelectionField, SelectionSnapshot } from "../../core/text/selection.ts";

export interface SelectionPorts {
  readonly epoch: () => number;
  readonly order: () => readonly string[];
  readonly keys: (rowId: string, field: SelectionField) => readonly string[] | null;
}

export interface TakenSelection {
  readonly epoch: number;
  readonly order: readonly string[];
  readonly rowId: string;
  readonly field: SelectionField;
  readonly anchor: number;
  readonly head: number;
  readonly affinity: ModelSelection["affinity"];
  readonly keys: readonly string[];
}

export interface SelectionModel {
  readonly remember: (taken: TakenSelection) => ModelSelection;
  readonly resolve: () => ModelSelection | null;
  readonly snapshot: () => SelectionSnapshot | null;
  readonly forget: () => void;
}

export function createSelectionModel(ports: SelectionPorts): SelectionModel {
  let held: SelectionSnapshot | null = null;

  function world() {
    return { epoch: ports.epoch(), order: ports.order(), keys: ports.keys };
  }

  return {
    remember: function (taken) {
      held = takeSnapshot({
        epoch: taken.epoch,
        rowId: taken.rowId,
        field: taken.field,
        anchor: taken.anchor,
        head: taken.head,
        affinity: taken.affinity
      }, taken.keys, taken.order);
      return held.selection;
    },
    resolve: function () {
      const now = resolveSelection(held, world());
      if (!now) held = null;
      return now;
    },
    snapshot: function () { return held; },
    forget: function () { held = null; }
  };
}

export interface HeldLink<Range, Cell> {
  readonly range: Range;
  readonly cell: Cell;
}

export interface EditorSelection<Root extends object, Range, Cell> extends SelectionModel {
  readonly notePainted: (root: Root) => void;
  readonly paintedEpoch: (root: Root) => number;
  readonly holdLink: (range: Range, cell: Cell) => void;
  readonly heldLink: () => HeldLink<Range, Cell> | null;
  readonly dropLink: () => void;
}

export type EditorSelectionPort = Pick<EditorSelection<object, unknown, unknown>, "dropLink">;

export function createEditorSelection<Root extends object, Range, Cell>(ports: SelectionPorts): EditorSelection<Root, Range, Cell> {
  const model = createSelectionModel(ports);
  const painted = new WeakMap<Root, number>();
  let link: HeldLink<Range, Cell> | null = null;

  return {
    remember: model.remember,
    resolve: model.resolve,
    snapshot: model.snapshot,
    forget: model.forget,
    notePainted: function (root) { painted.set(root, ports.epoch()); },
    paintedEpoch: function (root) {
      const epoch = painted.get(root);
      return epoch === undefined ? ports.epoch() : epoch;
    },
    holdLink: function (range, cell) { link = { range: range, cell: cell }; },
    heldLink: function () { return link; },
    dropLink: function () { link = null; }
  };
}
