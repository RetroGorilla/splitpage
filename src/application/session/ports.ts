import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { ChangeSet, SessionChange } from "./change-set.ts";

import type { Clock } from "../../core/document/ports.ts";
import type { CellDecoder } from "../../core/text/ports.ts";
import type { FlowSelectionPair } from "../../core/flow/flow.ts";

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
  record: (changes: ChangeSet, selection?: FlowSelectionPair) => void;
  absorbDisk: (doc: ValidatedDocument | null) => void;
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

export const SHARED_SESSION_DISABLED = Object.freeze({
  saveDestinations: "Save destinations are not available in a shared session.",
  autosave: "File autosave is not available in a shared session.",
  merge: "Local merge is not available in a shared session.",
  reload: "Reloading a local file is not available in a shared session.",
  stash: "Stashed work cannot be applied to a shared session.",
  drafts: "Independent drafts are not available in a shared session.",
  history: "Earlier versions cannot replace a shared session.",
  folders: "Local folders cannot be attached to a shared session.",
  bundles: "File bundles are not available in a shared session."
});

export type StandaloneCapabilityName = keyof typeof SHARED_SESSION_DISABLED;

type StandaloneCapabilities = { readonly [Name in StandaloneCapabilityName]: () => Capability };

export interface CapabilityPort extends StandaloneCapabilities {
  edit: () => Capability;
  comment: () => Capability;
}

export interface RecordsPlan {
  readonly fields: readonly string[];
  readonly apply: (doc: ValidatedDocument) => void;
  readonly commit?: (() => void) | undefined;
}

export interface ReconcilePort {
  anchors: (doc: ValidatedDocument) => number;
  records?: ((doc: ValidatedDocument, changes: ChangeSet) => RecordsPlan | null) | undefined;
}

export type ReportPort = (error: unknown) => void;

export interface TimerPort {
  now: () => number;
  start: (run: () => void, ms: number) => unknown;
  stop: (handle: unknown) => void;
}
