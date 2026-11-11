const counts = { snapshots: 0, texts: 0, identities: 0, markRecords: 0, markAnchors: 0, markChecks: 0, records: 0, statusEvents: 0 };

export type SharedReadCounts = Readonly<typeof counts>;

export function countSharedRead(kind: keyof SharedReadCounts, amount = 1): void { counts[kind] += amount; }

export function readSharedReadCounts(): SharedReadCounts { return { ...counts }; }
