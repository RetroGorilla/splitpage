export interface SceneFields {
  readonly splitField: (cell: Element) => { readonly id: string; readonly field: string } | null;
  readonly focusField: (rowId: string, field: string, offset?: number) => void;
}

let scenes: SceneFields | null = null;

export function handScenesTo(next: SceneFields | null): void {
  scenes = next;
}

export function splitRowFieldCore(cell: Element): { readonly id: string; readonly field: string } | null {
  return scenes ? scenes.splitField(cell) : null;
}

export function focusRowField(rowId: string, field: string, offset?: number): void {
  scenes?.focusField(rowId, field, offset);
}
