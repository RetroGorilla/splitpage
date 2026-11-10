export interface CollabIdentity {
  client: number;
  clock: number;
}

export type CollabMarks = Readonly<Record<string, string | boolean>>;

export interface CollabCharacter {
  identity: CollabIdentity | null;
  notation: string;
  value: string;
  marks: CollabMarks;
  beat: string;
}

export interface CollabRow {
  id: string;
  characters: CollabCharacter[];
  lengthSeconds?: number;
  kind?: "heading";
  paragraphStart?: boolean;
  status?: string;
  visuals?: CollabRow[];
  gallery?: unknown[];
}

export interface CollabCaret {
  beat: string;
  offset: number;
  selection?: { beat: string; from: number; to: number };
}

export interface CollabRecovery {
  row: CollabRow;
  by: string;
  edited: string[];
}

export interface CollabModel {
  rows: CollabRow[];
  carets: Record<string, CollabCaret>;
  recovery: CollabRecovery[];
  records?: Record<string, unknown>;
  notices?: string[];
}

export type OracleCharacter = readonly [notation: string, value: string, marks: CollabMarks];

export interface OracleRow {
  id: string;
  characters: readonly OracleCharacter[];
  lengthSeconds?: number;
  kind?: "heading";
  paragraphStart?: boolean;
  status?: string;
  visuals?: readonly OracleRow[];
  gallery?: readonly unknown[];
}

export interface ScriptOracle {
  rows: readonly OracleRow[];
  carets: Readonly<Record<string, CollabCaret>>;
  recovery: readonly { row: OracleRow; by: string; edited: string[] }[];
  records?: Record<string, unknown>;
  notices?: string[];
}

export class IdentityBook {
  private readonly names = new Map<string, CollabIdentity>();
  private readonly identities = new Map<string, string>();

  bind(notation: string, identity: CollabIdentity): void {
    const key = `${identity.client}:${identity.clock}`;
    if (this.names.has(notation) || this.identities.has(key)) {
      throw new Error(`Identity already bound: ${notation} / ${key}`);
    }
    this.names.set(notation, { ...identity });
    this.identities.set(key, notation);
  }

  identity(notation: string): CollabIdentity {
    const identity = this.names.get(notation);
    if (!identity) throw new Error(`Unknown oracle identity: ${notation}`);
    return { ...identity };
  }

  notation(identity: CollabIdentity): string {
    return this.identities.get(`${identity.client}:${identity.clock}`) ?? `?${identity.client}:${identity.clock}`;
  }
}

function expectedRow(row: OracleRow, identities: IdentityBook): CollabRow {
  const { visuals, gallery, ...fields } = row;
  return {
    ...fields,
    id: row.id,
    characters: row.characters.map(([notation, value, marks]) => ({
      identity: notation === "[glue]" ? null : identities.identity(notation),
      notation,
      value,
      marks,
      beat: row.id
    })),
    ...(visuals === undefined ? {} : { visuals: visuals.map(visual => expectedRow(visual, identities)) }),
    ...(gallery === undefined ? {} : { gallery: [...gallery] })
  };
}

function firstDifference(expected: unknown, actual: unknown, path: string): string | null {
  if (Object.is(expected, actual)) return null;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    for (let index = 0; index < Math.max(expected.length, actual.length); index++) {
      const difference = firstDifference(expected[index], actual[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return null;
  }
  if (expected !== null && actual !== null && typeof expected === "object" && typeof actual === "object") {
    const wanted = expected as Record<string, unknown>;
    const got = actual as Record<string, unknown>;
    for (const key of new Set([...Object.keys(wanted), ...Object.keys(got)])) {
      if (Object.hasOwn(wanted, key) !== Object.hasOwn(got, key)) {
        return `${path}.${key}: expected ${Object.hasOwn(wanted, key) ? JSON.stringify(wanted[key]) : "<missing>"}, got ${Object.hasOwn(got, key) ? JSON.stringify(got[key]) : "<missing>"}`;
      }
      const difference = firstDifference(wanted[key], got[key], `${path}.${key}`);
      if (difference) return difference;
    }
    return null;
  }
  return `${path}: expected ${JSON.stringify(expected) ?? "<missing>"}, got ${JSON.stringify(actual) ?? "<missing>"}`;
}

export function checkModel(actual: CollabModel, oracle: ScriptOracle, identities: IdentityBook, replica: string): void {
  const expected: CollabModel = {
    ...oracle,
    rows: oracle.rows.map(row => expectedRow(row, identities)),
    carets: { ...oracle.carets },
    recovery: oracle.recovery.map(entry => ({ ...entry, row: expectedRow(entry.row, identities) }))
  };
  const difference = firstDifference(expected, actual, replica);
  if (difference) throw new Error(difference);
}
