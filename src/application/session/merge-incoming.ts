import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { MergedStates } from "../../core/merge-states.ts";
import type { DocumentEntry } from "./ports.ts";

export interface MergeIncomingPorts {
  readonly entry: DocumentEntry;
  readonly merge: (base: ValidatedDocument | null, mine: ValidatedDocument, theirs: ValidatedDocument) => MergedStates;
}

export interface MergeInput {
  readonly base: unknown;
  readonly mine: unknown;
  readonly theirs: unknown;
}

export function mergeIncoming(input: MergeInput, isDocument: (raw: unknown) => boolean, ports: MergeIncomingPorts): MergedStates {
  const theirs = ports.entry(input.theirs);
  const mine = ports.entry(input.mine);
  const base = isDocument(input.base) ? ports.entry(input.base) : null;
  return ports.merge(base, mine, theirs);
}
