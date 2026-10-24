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
  WriterResult
} from "../application/save/coordinator.ts";
import { createSaveDestinations } from "../application/save/destinations.ts";
import { createFileConflicts } from "../application/save/file-conflict.ts";
import type { FileConflicts } from "../application/save/file-conflict.ts";
import type { SaveDestination, SaveDestinations } from "../application/save/destinations.ts";
import type { SaveChange } from "../application/save/save-state.ts";
import type { AutoSaveTarget } from "../application/save/status.ts";
import type { TimerPort } from "../application/session/ports.ts";
import { showToast } from "./effects-bridge.ts";
import { preferences } from "./preferences-bridge.ts";

export type LegacySaveKind = "save" | "auto" | "autosave" | "force" | "saveAs" | "server" | "writeback" | "writebackForce";

export interface LegacySaveRequest {
  readonly kind: LegacySaveKind;
  readonly target?: unknown;
}

export type LegacySaveJob = SaveJob<LegacySaveRequest>;

export type LegacySaveDestinations = SaveDestinations<LegacySaveRequest, unknown>;

export type LegacySaveDestination = SaveDestination<LegacySaveRequest, unknown>;

export interface LegacySavePorts {
  readonly destination: () => unknown;
  readonly keyOf: (identity: unknown) => DestinationKey;
  readonly obsolete: (request: LegacySaveRequest, here: boolean) => void;
  readonly ownership: SaveOwnershipPort;
  readonly autosave: LegacyAutoSavePorts;
}

export interface LegacyAutoSavePorts {
  readonly enabledAtStart: () => boolean;
  readonly changed: (what: AutoSaveChange) => void;
}

type Coordinator = SaveCoordinator<LegacySaveRequest, unknown>;

interface Started {
  readonly coordinator: Coordinator;
  readonly autosave: AutoSavePolicy;
  readonly destinations: LegacySaveDestinations;
  readonly conflicts: FileConflicts;
  readonly place: () => unknown;
}

let started: Started | null = null;

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

const AUTOSAVE_REQUEST: LegacySaveRequest = Object.freeze({ kind: "autosave" });
const NO_DESTINATION: WriterResult = Object.freeze({ kind: "refused", reason: "No save destination takes this save" });
const NOT_AUTOSAVING: WriterResult = Object.freeze({ kind: "refused", reason: "Autosave is off, paused, has nowhere to write or nothing to write" });

let autoSaveWriting = false;

function writeAutoSave(mine: Started, write: () => Promise<WriterResult>, target: AutoSaveTarget): Promise<WriterResult> {
  if (!mine.autosave.may(target) || !mine.coordinator.unsaved()) return Promise.resolve(NOT_AUTOSAVING);
  autoSaveWriting = true;
  return write().then(function (result) {
    autoSaveWriting = false;
    return result;
  }, function (error: unknown) {
    autoSaveWriting = false;
    throw error;
  });
}

function writeThrough(mine: Started, job: LegacySaveJob): Promise<WriterResult> {
  const place = mine.place();
  const destination = mine.destinations.taking(job.request, place);
  if (!destination) return Promise.resolve(NO_DESTINATION);
  if (job.request.kind !== "autosave") return destination.write(job);
  return writeAutoSave(mine, function () { return destination.write(job); }, destination.autoSaveTarget(place));
}

export function startSaves(ports: LegacySavePorts, timers: Pick<TimerPort, "start" | "stop">): () => void {
  if (started) throw new Error("The save coordinator is already started; stop it first");
  const destinations = createSaveDestinations<LegacySaveRequest, unknown>();
  const mine: Started = Object.freeze({
    coordinator: createSaveCoordinator<LegacySaveRequest, unknown>({
      ownership: ports.ownership,
      destination: { current: ports.destination, keyOf: ports.keyOf },
      writer: { write: function (job) { return writeThrough(mine, job); } },
      report: { obsolete: ports.obsolete },
      join: joinSaves
    }),
    autosave: createAutoSavePolicy({
      timers: timers,
      enabledAtStart: ports.autosave.enabledAtStart,
      due: autoSaveDue,
      changed: function (change) {
        ports.autosave.changed(change);
        announce(change);
      }
    }),
    destinations: destinations,
    conflicts: createFileConflicts(),
    place: ports.destination
  });
  started = mine;
  const stopChanges = mine.coordinator.onChange(announce);
  return function () {
    stopChanges();
    if (started === mine) started = null;
    mine.autosave.stop();
    mine.coordinator.stop();
    mine.conflicts.stop();
  };
}

export function savesStarted(): boolean {
  return started !== null;
}

export function requestSave(request: LegacySaveRequest): Promise<SaveOutcome> {
  const now = live();
  return now.coordinator.request(Object.freeze(request.target === undefined ? { kind: request.kind } : { kind: request.kind, target: request.target }))
    .then(function (outcome) {
      if (outcome.kind === "refused" && outcome.conflict && started === now) now.conflicts.show(outcome.conflict);
      return outcome;
    });
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

export function saveDestinations(): LegacySaveDestinations {
  return live().destinations;
}

export function autoSaveTarget(): AutoSaveTarget {
  const now = live();
  const place = now.place();
  const destination = now.destinations.taking(AUTOSAVE_REQUEST, place);
  return destination ? destination.autoSaveTarget(place) : null;
}

export function scheduleAutoSave(): void {
  live().autosave.schedule(autoSaveTarget());
}

export function haltAutoSave(reason: string): void {
  live().autosave.halt(reason);
}

export function resumeAutoSave(): void {
  live().autosave.resume();
}

export function queueAutoSave(): void {
  const now = live();
  if (!now.autosave.may(autoSaveTarget())) return;
  now.autosave.clear();
  if (now.coordinator.running() && !autoSaveWriting) { scheduleAutoSave(); return; }
  Promise.resolve().then(function () { return requestSave({ kind: "autosave" }); }).catch(function () {});
}

function autoSaveDue(): void {
  if (!unsavedChanges()) return;
  queueAutoSave();
}

export function flushAutoSave(): void {
  const policy = live().autosave;
  if (!policy.pending()) return;
  policy.clear();
  if (unsavedChanges()) queueAutoSave();
}

export function setAutoSaveEnabled(on: boolean): void {
  preferences().setAutosave(!!on);
  live().autosave.setEnabled(on);
  if (on && unsavedChanges()) scheduleAutoSave();
}

export function toggleAutoSave(): void {
  const on = !live().autosave.enabled();
  setAutoSaveEnabled(on);
  showToast(on
    ? "Autosave is on — edits go to the file you saved to, a moment after you stop typing."
    : "Autosave is off — your changes are only written when you press Save.", "ok");
}

export interface SaveDocOptions {
  readonly auto?: boolean;
  readonly force?: boolean;
  readonly saveAs?: boolean;
}

function saveKind(opts: SaveDocOptions): LegacySaveKind {
  if (opts.saveAs) return "saveAs";
  if (opts.force) return "force";
  return opts.auto ? "auto" : "save";
}

export function saveDoc(opts?: SaveDocOptions | null): Promise<void> {
  const given = opts || {};
  if (!given.auto) resumeAutoSave();
  return requestSave({ kind: saveKind(given) }).then(function () {});
}

const SENT_OUTCOMES: readonly SaveOutcome["kind"][] = Object.freeze(["saved", "obsolete"]);

export function saveToServer(): Promise<boolean> {
  return requestSave({ kind: "server" }).then(function (outcome) {
    return SENT_OUTCOMES.indexOf(outcome.kind) !== -1;
  });
}

export function fileConflicts(): FileConflicts {
  return live().conflicts;
}
