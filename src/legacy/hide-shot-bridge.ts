export interface HideShotHandlers {
  readonly set: (on: boolean) => void;
  readonly renderGroups: <R extends { readonly id: string }>(rows: readonly R[], rowRenderer: (row: R, index: number) => string) => string;
}

let handlers: HideShotHandlers | null = null;

export function handHideShotTo(next: HideShotHandlers | null): void {
  handlers = next;
}

export function setHideShotScenes(on: boolean): void {
  handlers?.set(on);
}

export function renderRowGroups<R extends { readonly id: string }>(rows: readonly R[], rowRenderer: (row: R, index: number) => string): string {
  return handlers ? handlers.renderGroups(rows, rowRenderer) : "";
}
