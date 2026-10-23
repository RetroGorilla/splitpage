import { createDocumentSession } from "../application/session/document-session.ts";
import type { AbsorbedKind, Command, CommandOutcome, DocumentSession, DocumentView, Plan, ReloadedContent, Replay, SessionCounters, SessionListener, Stamp } from "../application/session/document-session.ts";
import type { ChangeSet } from "../application/session/change-set.ts";
import type { CapabilityPort, CellTextPorts, DocumentEntry, EditorPort, EffectPort, RecordsPlan, ReportPort, StampPorts, TimerPort, UndoPort } from "../application/session/ports.ts";
import type { ValidatedDocument } from "../core/document/validated.ts";
import type { LiveDocumentPort } from "../application/transitions/ports.ts";
import { syncCommentAnchors } from "../core/text/anchors.ts";
import { systemClock } from "../adapters/identity/ids.ts";
import { cellOf, scriptCellOf } from "./richtext.ts";
import { documentGuardOn, documentView, unwrapped } from "./document-guard.ts";

export type RecordsReconciler = (doc: ValidatedDocument, changes: ChangeSet) => RecordsPlan | null;

export type ReplayRunner = (replay: Replay) => CommandOutcome;

export interface SessionUndoPorts {
  readonly adapter: UndoPort;
  readonly route: (run: ReplayRunner, stamps: StampPorts, amend: ReplayRunner) => () => void;
}

export interface SessionBridgePorts {
  readonly entry: DocumentEntry;
  readonly undo: SessionUndoPorts;
  readonly effects: EffectPort;
  readonly capability: CapabilityPort;
  readonly editor: EditorPort;
  readonly records: RecordsReconciler;
  readonly attribution: { readonly attribute: (doc: DocumentView) => Plan | null };
  readonly report: ReportPort;
  readonly timers: TimerPort;
}

export const REVIEW_ONLY = "review";

interface Started {
  readonly ports: SessionBridgePorts;
  current: DocumentSession;
  ended: boolean;
  mergeBase: ValidatedDocument | null;
}

let started: Started | null = null;

function running(): Started {
  if (!started) throw new Error("The document session is not started yet");
  return started;
}

export const sessionStamps: StampPorts = Object.freeze({
  clock: systemClock,
  editor: Object.freeze({ name: function () { return running().ports.editor.name(); } })
});

export const sessionTextPorts: CellTextPorts = Object.freeze({
  clock: sessionStamps.clock,
  editor: sessionStamps.editor,
  cells: function (html: string) { return scriptCellOf(html); }
});

interface Hearing {
  readonly listener: SessionListener;
  on: boolean;
}

const changeListeners: Hearing[] = [];

const refreshListeners: ((jobs: ReadonlySet<string>) => void)[] = [];

const stampListeners: ((changes: ChangeSet) => void)[] = [];

function hearing(entry: Hearing): SessionListener {
  return function (change) {
    if (entry.on) entry.listener(change);
  };
}

function createSession(ports: SessionBridgePorts, after: SessionCounters): DocumentSession {
  const made = createDocumentSession({
    entry: ports.entry,
    undo: ports.undo.adapter,
    effects: {
      dirty: function (change) { ports.effects.dirty(change); },
      draft: function (change) { ports.effects.draft(change); },
      save: function (change) { ports.effects.save(change); },
      refresh: function (jobs) {
        ports.effects.refresh(jobs);
        refreshListeners.slice().forEach(function (listener) { listener(jobs); });
      }
    },
    capability: ports.capability,
    reconcile: {
      anchors: function (doc) { return syncCommentAnchors(doc, cellOf); },
      records: ports.records
    },
    attribution: ports.attribution,
    report: ports.report,
    timers: ports.timers,
    after: after
  });
  changeListeners.forEach(function (entry) { made.subscribe(hearing(entry)); });
  return made;
}

const replacedListeners: Array<() => void> = [];

function announceReplaced(): void {
  for (const listener of replacedListeners.slice()) listener();
}

export function onDocumentReplaced(listener: () => void): void {
  replacedListeners.push(listener);
}

export function onRefresh(listener: (jobs: ReadonlySet<string>) => void): () => void {
  refreshListeners.push(listener);
  return function () {
    const at = refreshListeners.indexOf(listener);
    if (at !== -1) refreshListeners.splice(at, 1);
  };
}

export function onStamped(listener: (changes: ChangeSet) => void): () => void {
  stampListeners.push(listener);
  return function () {
    const at = stampListeners.indexOf(listener);
    if (at !== -1) stampListeners.splice(at, 1);
  };
}

export function onSessionChange(listener: SessionListener): () => void {
  const entry: Hearing = { listener: listener, on: true };
  changeListeners.push(entry);
  if (started) started.current.subscribe(hearing(entry));
  return function () {
    entry.on = false;
    const at = changeListeners.indexOf(entry);
    if (at !== -1) changeListeners.splice(at, 1);
  };
}

function swept<T>(outcome: T): T {
  if (documentGuardOn) unwrapped(heldDocument());
  return outcome;
}

const session: DocumentSession = {
  epoch: function () { return running().current.epoch(); },
  generation: function () { return running().current.generation(); },
  read: function <T>(select: (doc: DocumentView | null) => T): T { return running().current.read(select); },
  held: function () { return running().current.held(); },
  adopt: function (raw: unknown) { return running().current.adopt(unwrapped(raw)); },
  absorbServer: function (raw: unknown) { return running().current.absorbServer(unwrapped(raw)); },
  absorbRecovery: function (raw: unknown) { return running().current.absorbRecovery(unwrapped(raw)); },
  absorbMerged: function (kind: "server" | "recovery", merged: ValidatedDocument) { return running().current.absorbMerged(kind, unwrapped(merged)); },
  absorbReload: function (content: ReloadedContent) { return running().current.absorbReload(unwrapped(content)); },
  settle: function (kind: AbsorbedKind) { running().current.settle(kind); },
  run: function (command: Command) { return swept(running().current.run(command)); },
  replay: function (task: Replay) { return swept(running().current.replay(task)); },
  amend: function (task: Replay) { return swept(running().current.amend(task)); },
  stamp: function (task: Stamp) { return swept(running().current.stamp(task)); },
  noteEdit: function (changes?: ChangeSet) { running().current.noteEdit(changes); swept(null); },
  refresh: function (job: string) { running().current.refresh(job); },
  subscribe: function (listener: SessionListener) { return running().current.subscribe(listener); },
  dispose: function () {
    const now = running();
    now.ended = true;
    now.current.dispose();
  }
};

const STALE: CommandOutcome = Object.freeze({ kind: "noop" });

export function startSessionBridge(ports: SessionBridgePorts): () => void {
  if (started) throw new Error("The document session is already started; stop it first");
  const mine: Started = { ports: ports, current: createSession(ports, { epoch: 0, generation: 0 }), ended: false, mergeBase: null };
  const releases: (() => void)[] = [];
  const release = (): void => {
    if (started === mine) started = null;
    try {
      mine.current.dispose();
    } finally {
      while (releases.length) releases.pop()?.();
    }
  };
  started = mine;
  try {
    releases.push(ports.undo.route(function (task) {
      if (started !== mine) return STALE;
      return swept(mine.current.replay(task));
    }, sessionStamps, function (task) {
      if (started !== mine) return STALE;
      return swept(mine.current.amend(task));
    }));
  } catch (error) {
    release();
    throw error;
  }
  let stopped = false;
  return function () {
    if (stopped) return;
    stopped = true;
    release();
  };
}

export function sessionStarted(): boolean {
  return started !== null;
}

export function adoptReplacement(doc: ValidatedDocument): void {
  const now = running();
  if (now.ended) return;
  const old = now.current;
  now.current = createSession(now.ports, { epoch: old.epoch(), generation: old.generation() });
  old.dispose();
  now.current.adopt(unwrapped(doc));
  announceReplaced();
}

export function heldDocument(): ValidatedDocument | null {
  return started ? started.current.held() : null;
}

function viewedDocument(): ValidatedDocument | null {
  return documentView(heldDocument());
}

export const currentDocument: () => ValidatedDocument | null = documentGuardOn ? viewedDocument : heldDocument;

export const liveDocumentPort: LiveDocumentPort = Object.freeze({
  current: currentDocument,
  assign: adoptReplacement,
  stamp: stampDocument
});

export function mergeBase(): ValidatedDocument | null {
  return started ? started.mergeBase : null;
}

export function holdMergeBase(base: ValidatedDocument | null): void {
  running().mergeBase = unwrapped(base);
}

export function readSession<T>(select: (doc: DocumentView | null) => T): T {
  return session.read(select);
}

export function runCommand(command: Command): CommandOutcome {
  return session.run(command);
}

export function runDocumentEdit(command: Command): boolean {
  const outcome = runCommand(command);
  if (outcome.kind === "failed") throw outcome.error;
  return outcome.kind === "applied" || outcome.kind === "committed";
}

export function stampDocument(task: Stamp): CommandOutcome {
  const outcome = session.stamp(task);
  if (outcome.kind === "applied") {
    const changes = outcome.changes;
    stampListeners.slice().forEach(function (listener) { listener(changes); });
  }
  return outcome;
}

export function editAllowed(): boolean {
  return running().ports.capability.edit().allowed;
}

function attribute(): void {
  const outcome = session.stamp({ name: "attribute", plan: function (doc) { return running().ports.attribution.attribute(doc); } });
  if (outcome.kind === "failed") throw outcome.error;
}

export function noteSessionEdit(): void {
  attribute();
  session.noteEdit();
}

export function noteServerUpdate(next: unknown): ValidatedDocument | null {
  return session.absorbServer(next);
}

export function noteRecovery(next: unknown): ValidatedDocument | null {
  return session.absorbRecovery(next);
}

export function noteMerged(kind: "server" | "recovery", merged: ValidatedDocument): ValidatedDocument | null {
  return session.absorbMerged(kind, merged);
}

export function noteReload(content: ReloadedContent): ValidatedDocument | null {
  return session.absorbReload(content);
}

export function noteAbsorbedDirty(kind: AbsorbedKind): void {
  attribute();
  session.settle(kind);
}

export function requestRefresh(job: string): void {
  session.refresh(job);
}

export function liveSession(): DocumentSession {
  return session;
}
