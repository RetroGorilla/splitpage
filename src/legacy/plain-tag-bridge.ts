export type PlainTagOpen = (cellEl?: Element | null) => boolean;

let isOpen: PlainTagOpen | null = null;

export function handPlainTagTo(next: PlainTagOpen | null): void {
  isOpen = next;
}

export function plainTagOpen(cellEl?: Element | null): boolean {
  return isOpen ? isOpen(cellEl) : false;
}
