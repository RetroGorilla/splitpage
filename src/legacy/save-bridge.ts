import { createSaveCoordinator } from "../application/save/coordinator.ts";
import type {
  Confirmed,
  DestinationKey,
  SaveCoordinator,
  SaveJob,
  SaveOutcome,
  SaveOwnershipPort,
  WriterResult
} from "../application/save/coordinator.ts";

export type LegacySaveKind = "save" | "auto" | "autosave" | "force" | "saveAs" | "server";

export interface LegacySaveRequest {
  readonly kind: LegacySaveKind;
}

export type LegacySaveJob = SaveJob<LegacySaveRequest>;

export interface LegacySavePorts {
  readonly write: (job: LegacySaveJob) => Promise<WriterResult>;
  readonly destination: () => unknown;
  readonly keyOf: (identity: unknown) => DestinationKey;
  readonly obsolete: (request: LegacySaveRequest, here: boolean) => void;
  readonly running: (running: boolean) => void;
  readonly ownership: SaveOwnershipPort;
}

type Coordinator = SaveCoordinator<LegacySaveRequest, unknown>;

let started: Coordinator | null = null;

function running(): Coordinator {
  if (!started) throw new Error("The save coordinator is not started yet");
  return started;
}

const PLAIN: readonly LegacySaveKind[] = Object.freeze(["save", "auto", "autosave", "server"]);
const AUTOMATIC: readonly LegacySaveKind[] = Object.freeze(["auto", "autosave"]);

export function joinSaves(pending: LegacySaveRequest, next: LegacySaveRequest): LegacySaveRequest | null {
  if (PLAIN.indexOf(pending.kind) === -1 || PLAIN.indexOf(next.kind) === -1) return null;
  if (pending.kind === next.kind) return pending;
  if (AUTOMATIC.indexOf(pending.kind) !== -1 && AUTOMATIC.indexOf(next.kind) !== -1) return Object.freeze({ kind: "auto" });
  return pending.kind === "save" ? pending : Object.freeze({ kind: "save" });
}

export function startSaves(ports: LegacySavePorts): () => void {
  if (started) throw new Error("The save coordinator is already started; stop it first");
  const mine: Coordinator = createSaveCoordinator<LegacySaveRequest, unknown>({
    ownership: ports.ownership,
    destination: { current: ports.destination, keyOf: ports.keyOf },
    writer: { write: ports.write },
    report: { obsolete: ports.obsolete, running: ports.running },
    join: joinSaves
  });
  started = mine;
  return function () {
    if (started === mine) started = null;
  };
}

export function savesStarted(): boolean {
  return started !== null;
}

export function requestSave(request: LegacySaveRequest): Promise<SaveOutcome> {
  return running().request(Object.freeze({ kind: request.kind }));
}

export function saveRunning(): boolean {
  return running().running();
}

export function savesWaiting(): number {
  return running().waiting();
}

export function noteSaveChange(): number {
  return running().noteChange();
}

export function saveChanges(): number {
  return running().changes();
}

export function confirmSavedNow(): void {
  running().confirmClean();
}

export function confirmBaseline<B>(baseline: B | null): B | null {
  running().confirmBaseline(baseline);
  return baseline;
}

export function confirmedSave(identity?: unknown): Confirmed<unknown> {
  return running().confirmed(identity);
}

export function confirmedGeneration(): number {
  return running().confirmed().generation;
}

export function unsavedFor(identity?: unknown): boolean {
  return running().dirty(identity);
}
