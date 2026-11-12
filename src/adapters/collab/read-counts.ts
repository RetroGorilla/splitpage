export interface SharedReadCounts {
  readonly texts: number;
  readonly identities: number;
  readonly markRecords: number;
  readonly markAnchors: number;
  readonly markChecks: number;
  readonly statusEvents: number;
}

let inspect: ((kind: keyof SharedReadCounts, amount: number) => void) | null = null;

export function countSharedRead(kind: keyof SharedReadCounts, amount = 1): void { inspect?.(kind, amount); }

export function measureSharedReads<T>(read: () => T): { readonly result: T; readonly counts: SharedReadCounts } {
  const counts = { texts: 0, identities: 0, markRecords: 0, markAnchors: 0, markChecks: 0, statusEvents: 0 };
  const previous = inspect;
  inspect = (kind, amount) => { counts[kind] += amount; previous?.(kind, amount); };
  try { return { result: read(), counts }; } finally { inspect = previous; }
}
