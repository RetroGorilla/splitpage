export interface RowsHolder {
  readonly rows: readonly { readonly id: string }[];
}

export function rowIndexOf(doc: RowsHolder | null, id: unknown): number {
  if (doc === null) return -1;
  return doc.rows.findIndex(function (row) { return row.id === id; });
}
