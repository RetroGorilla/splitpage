import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { ChangeSet, SessionChange } from "./change-set.ts";

import type { Clock } from "../../core/document/ports.ts";
import type { CellDecoder } from "../../core/text/ports.ts";

export type { Clock, IdSource } from "../../core/document/ports.ts";

export interface EditorPort {
  readonly name: () => string;
}

export interface StampPorts {
  readonly clock: Clock;
  readonly editor: EditorPort;
}

export interface CellTextPorts extends StampPorts {
  readonly cells: CellDecoder;
}

export type DocumentEntry = (raw: unknown) => ValidatedDocument;

export interface UndoPort {
  adopt: (doc: ValidatedDocument | null) => void;
  record: (changes: ChangeSet) => void;
  absorbServer: (doc: ValidatedDocument | null) => void;
  absorbReload: () => void;
}

export interface EffectPort {
  dirty: (change: SessionChange) => void;
  draft: (change: SessionChange) => void;
  save: (change: SessionChange) => void;
  refresh: (jobs: ReadonlySet<string>) => void;
}

export type Capability =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export interface CapabilityPort {
  edit: () => Capability;
}

export interface ReconcilePort {
  anchors: (doc: ValidatedDocument) => number;
}

export type ReportPort = (error: unknown) => void;

export interface TimerPort {
  now: () => number;
  start: (run: () => void, ms: number) => unknown;
  stop: (handle: unknown) => void;
}
