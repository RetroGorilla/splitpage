export interface BrollPrintView {
  readonly filter: string;
  readonly group: string;
}

let readView: ((as?: unknown) => BrollPrintView) | null = null;

export function handBrollPrintViewTo(next: typeof readView): void {
  readView = next;
}

export function brollPrintView(as?: unknown): BrollPrintView {
  if (!readView) throw new Error("The B-roll panel is not mounted");
  return readView(as);
}
