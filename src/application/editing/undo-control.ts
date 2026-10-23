export interface UndoControl {
  readonly breakCoalescing: () => void;
  readonly flush: () => void;
  readonly undo: () => unknown;
  readonly redo: () => unknown;
  readonly last: () => unknown;
}
