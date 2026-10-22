import { createDocumentSession } from "../application/session/document-session.ts";
import type { AbsorbedKind, Command, CommandOutcome, DocumentSession, DocumentView, Plan, ReloadedContent, Replay, SessionCounters, SessionListener, Stamp } from "../application/session/document-session.ts";
import type { ChangeSet } from "../application/session/change-set.ts";
import type { CapabilityPort, CellTextPorts, DocumentEntry, EditorPort, EffectPort, RecordsPlan, ReportPort, StampPorts, TimerPort, UndoPort } from "../application/session/ports.ts";
import type { ValidatedDocument } from "../core/document/validated.ts";
import { syncCommentAnchors } from "../core/text/anchors.ts";
import { systemClock } from "../adapters/identity/ids.ts";
import { cellOf, scriptCellOf } from "./richtext.ts";
import { followLiveDocument } from "./undo-adapter.ts";

export type RecordsReconciler = (doc: ValidatedDocument, changes: ChangeSet) => RecordsPlan | null;

export type ReplayRunner = (replay: Replay, live: ValidatedDocument | null) => CommandOutcome;

export interface SessionUndoPorts {
  readonly adapter: UndoPort;
  readonly route: (run: ReplayRunner, stamps: StampPorts, amend: ReplayRunner) => () => void;
  readonly watch: (adopted: (doc: unknown) => void) => () => void;
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

function createSession(ports: SessionBridgePorts, after: SessionCounters): DocumentSession {
  return createDocumentSession({
    entry: ports.entry,
    undo: ports.undo.adapter,
    effects: ports.effects,
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
}

const replacedListeners: Array<() => void> = [];

function announceReplaced(): void {
  for (const listener of replacedListeners.slice()) listener();
}

export function onDocumentReplaced(listener: () => void): void {
  replacedListeners.push(listener);
}

const session: DocumentSession = {
  epoch: function () { return running().current.epoch(); },
  generation: function () { return running().current.generation(); },
  read: function <T>(select: (doc: DocumentView | null) => T): T { return running().current.read(select); },
  adopt: function (raw: unknown) { return running().current.adopt(raw); },
  absorbServer: function (raw: unknown) { return running().current.absorbServer(raw); },
  absorbRecovery: function (raw: unknown) { return running().current.absorbRecovery(raw); },
  absorbMerged: function (kind: "server" | "recovery", merged: ValidatedDocument) { return running().current.absorbMerged(kind, merged); },
  absorbReload: function (content: ReloadedContent) { return running().current.absorbReload(content); },
  settle: function (kind: AbsorbedKind) { running().current.settle(kind); },
  run: function (command: Command) { return running().current.run(command); },
  replay: function (task: Replay) { return running().current.replay(task); },
  amend: function (task: Replay) { return running().current.amend(task); },
  stamp: function (task: Stamp) { return running().current.stamp(task); },
  noteEdit: function (changes?: ChangeSet) { running().current.noteEdit(changes); },
  refresh: function (job: string) { running().current.refresh(job); },
  subscribe: function (listener: SessionListener) { return running().current.subscribe(listener); },
  dispose: function () {
    const now = running();
    now.ended = true;
    now.current.dispose();
  }
};

function holdLive(owner: Started, live: ValidatedDocument | null): void {
  if (live && owner.current.read(function (held) { return held; }) !== live) owner.current.adopt(live);
}

const STALE: CommandOutcome = Object.freeze({ kind: "noop" });

export function startSessionBridge(ports: SessionBridgePorts): () => void {
  if (started) throw new Error("The document session is already started; stop it first");
  const mine: Started = { ports: ports, current: createSession(ports, { epoch: 0, generation: 0 }), ended: false };
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
    releases.push(ports.undo.watch(function (doc) {
      if (started !== mine) return;
      mine.current.adopt(doc);
      announceReplaced();
    }));
    releases.push(ports.undo.route(function (task, live) {
      if (started !== mine) return STALE;
      holdLive(mine, live);
      return mine.current.replay(task);
    }, sessionStamps, function (task, live) {
      if (started !== mine) return STALE;
      holdLive(mine, live);
      return mine.current.amend(task);
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
  followLiveDocument();
  if (now.current.read(function (held) { return held; }) !== doc) now.current.adopt(doc);
  announceReplaced();
}

export function readSession<T>(select: (doc: DocumentView | null) => T): T {
  running();
  followLiveDocument();
  return session.read(select);
}

export function runCommand(command: Command): CommandOutcome {
  running();
  followLiveDocument();
  return session.run(command);
}

export function runDocumentEdit(command: Command): boolean {
  const outcome = runCommand(command);
  if (outcome.kind === "failed") throw outcome.error;
  return outcome.kind === "applied" || outcome.kind === "committed";
}

export function stampDocument(task: Stamp): CommandOutcome {
  running();
  followLiveDocument();
  return session.stamp(task);
}

export function editAllowed(): boolean {
  return running().ports.capability.edit().allowed;
}

export function noteSessionEdit(): void {
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
  running();
  followLiveDocument();
  return session.absorbReload(content);
}

export function noteAbsorbedDirty(kind: AbsorbedKind): void {
  session.settle(kind);
}

export function requestRefresh(job: string): void {
  session.refresh(job);
}

export function liveSession(): DocumentSession {
  return session;
}
