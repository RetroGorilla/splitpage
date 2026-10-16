import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { MergedStates } from "../../core/merge-states.ts";
import { alignLineShots } from "../../core/production/broll.ts";
import type { LineShotIds } from "../../core/production/broll.ts";

export interface MergeIncomingPorts {
  readonly entry: (raw: unknown, lines: LineShotIds) => ValidatedDocument;
  readonly merge: (base: ValidatedDocument | null, mine: ValidatedDocument, theirs: ValidatedDocument) => MergedStates;
}

export interface MergeInput {
  readonly base: unknown;
  readonly mine: unknown;
  readonly theirs: unknown;
}

export function mergeIncoming(input: MergeInput, isDocument: (raw: unknown) => boolean, ports: MergeIncomingPorts): MergedStates {
  const lines: LineShotIds = { held: new Map(), drawn: new Map() };
  const theirs = ports.entry(input.theirs, lines);
  const mine = ports.entry(input.mine, lines);
  const base = isDocument(input.base) ? ports.entry(input.base, lines) : null;
  alignLineShots(base ? [theirs, mine, base] : [theirs, mine], lines);
  return ports.merge(base, mine, theirs);
}
