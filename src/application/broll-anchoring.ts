let declined: Record<string, boolean>;

export function resetBrollAnchoring(): void {
  declined = Object.create(null);
}

export function declineBrollRows(rows: readonly { readonly id: string }[] | null | undefined): void {
  (rows || []).forEach(function (row) { declined[row.id] = true; });
}

export function brollAnchoringDeclined(id: string): boolean {
  return !!declined[id];
}
