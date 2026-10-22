import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { CommandOutcome, Stamp } from "../session/document-session.ts";
import type { OperationContext } from "../session/operation.ts";
import type { DocumentEntry } from "../session/ports.ts";

export interface LiveDocumentPort {
  readonly current: () => ValidatedDocument | null;
  readonly assign: (doc: ValidatedDocument) => void;
  readonly stamp: (stamp: Stamp) => CommandOutcome;
}

export interface DestinationPort<D> {
  readonly set: (destination: D) => void;
  readonly confirm: (baseline: ValidatedDocument | null, reason: string) => void;
}

export interface IdentityPort {
  readonly mint: () => string;
  readonly writtenOut: () => boolean;
  readonly markWrittenOut: (writtenOut: boolean) => void;
}

export interface OwnershipPort {
  readonly stillOwns: (ctx: OperationContext) => boolean;
}

export interface TransitionPorts<D> {
  readonly entry: DocumentEntry;
  readonly live: LiveDocumentPort;
  readonly destination: DestinationPort<D>;
  readonly identity: IdentityPort;
  readonly ownership: OwnershipPort;
}
