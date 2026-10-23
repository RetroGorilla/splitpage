import { createAutoSavePolicy } from "../application/save/autosave.ts";
import type { AutoSaveChange, AutoSavePolicy } from "../application/save/autosave.ts";
import { createSaveCoordinator } from "../application/save/coordinator.ts";
import type {
  Confirmed,
  DestinationKey,
  SaveCoordinator,
  SaveJob,
  SaveOutcome,
  SaveOwnershipPort,
  SaveStatusChange,
  WriterResult
} from "../application/save/coordinator.ts";
import type { TimerPort } from "../application/session/ports.ts";

export type LegacySaveKind = "save" | "auto" | "autosave" | "force" | "saveAs" | "server" | "writeback" | "writebackForce";

export interface LegacySaveRequest {
  readonly kind: LegacySaveKind;
  readonly target?: unknown;
}

export type LegacySaveJob = SaveJob<LegacySaveRequest>;

export interface LegacySavePorts {
  readonly write: (job: LegacySaveJob) => Promise<WriterResult>;
  readonly destination: () => unknown;
  readonly keyOf: (identity: unknown) => DestinationKey;
  readonly obsolete: (request: LegacySaveRequest, here: boolean) => void;
  readonly ownership: SaveOwnershipPort;
  readonly autosave: LegacyAutoSavePorts;
}

export interface LegacyAutoSavePorts {
  readonly enabledAtStart: () => boolean;
  readonly due: () => void;
  readonly changed: (what: AutoSaveChange) => void;
}

type Coordinator = SaveCoordinator<LegacySaveRequest, unknown>;

interface Started {
  readonly coordinator: Coordinator;
  readonly autosave: AutoSavePolicy;
}

let started: Started | null = null;

export type SaveChange = SaveStatusChange | AutoSaveChange;

const changeListeners: ((change: SaveChange) => void)[] = [];

export function onSaveChange(listener: (change: SaveChange) => void): () => void {
  changeListeners.push(listener);
  return function () {
    const at = changeListeners.indexOf(listener);
    if (at !== -1) changeListeners.splice(at, 1);
  };
}

function announce(change: SaveChange): void {
  changeListeners.slice().forEach(function (listener) {
    try {
      listener(change);
    } catch (error) {
      queueMicrotask(() => { throw error; });
    }
  });
}

function live(): Started {
  if (!started) throw new Error("The save coordinator is not started yet");
  return started;
}

function running(): Coordinator {
  return live().coordinator;
}

const PLAIN: readonly LegacySaveKind[] = Object.freeze(["save", "auto", "autosave", "server"]);
const AUTOMATIC: readonly LegacySaveKind[] = Object.freeze(["auto", "autosave"]);

export function joinSaves(pending: LegacySaveRequest, next: LegacySaveRequest): LegacySaveRequest | null {
  if (PLAIN.indexOf(pending.kind) === -1 || PLAIN.indexOf(next.kind) === -1) return null;
  if (pending.kind === next.kind) return pending;
  if (AUTOMATIC.indexOf(pending.kind) !== -1 && AUTOMATIC.indexOf(next.kind) !== -1) return Object.freeze({ kind: "auto" });
  return pending.kind === "save" ? pending : Object.freeze({ kind: "save" });
}

export function startSaves(ports: LegacySavePorts, timers: Pick<TimerPort, "start" | "stop">): () => void {
  if (started) throw new Error("The save coordinator is already started; stop it first");
  const mine: Started = Object.freeze({
    coordinator: createSaveCoordinator<LegacySaveRequest, unknown>({
      ownership: ports.ownership,
      destination: { current: ports.destination, keyOf: ports.keyOf },
      writer: { write: ports.write },
      report: { obsolete: ports.obsolete },
      join: joinSaves
    }),
    autosave: createAutoSavePolicy({
      timers: timers,
      enabledAtStart: ports.autosave.enabledAtStart,
      due: ports.autosave.due,
      changed: function (change) {
        ports.autosave.changed(change);
        announce(change);
      }
    })
  });
  started = mine;
  const stopChanges = mine.coordinator.onChange(announce);
  return function () {
    stopChanges();
    if (started === mine) started = null;
    mine.autosave.stop();
    mine.coordinator.stop();
  };
}

export function savesStarted(): boolean {
  return started !== null;
}

export function requestSave(request: LegacySaveRequest): Promise<SaveOutcome> {
  return running().request(Object.freeze(request.target === undefined ? { kind: request.kind } : { kind: request.kind, target: request.target }));
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
  const now = live();
  now.autosave.clear();
  now.autosave.resume();
  now.coordinator.confirmClean();
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

export function saveBusy(): boolean {
  return started !== null && started.coordinator.running();
}

export function unsavedChanges(): boolean {
  return started !== null && started.coordinator.unsaved();
}

export function autoSavePolicy(): AutoSavePolicy {
  return live().autosave;
}
