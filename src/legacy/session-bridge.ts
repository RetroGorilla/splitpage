import { createDocumentSession } from "../application/session/document-session.ts";
import type { AbsorbedKind, Command, CommandOutcome, DocumentSession, DocumentView, Plan, ReloadedContent, Replay, SessionCounters, SessionListener } from "../application/session/document-session.ts";
import type { ChangeSet, SessionChange } from "../application/session/change-set.ts";
import type { Capability, CellTextPorts, StampPorts } from "../application/session/ports.ts";
import type { ValidatedDocument } from "../core/document/validated.ts";
import { syncCommentAnchors } from "../core/text/anchors.ts";
import { systemClock } from "../adapters/identity/ids.ts";
import { migrateRows } from "../js/02-state.js";
import { cellOf } from "./richtext.ts";
import { createUndoAdapter, followLiveDocument, routeReplays, watchUndoAdoption } from "./undo-adapter.ts";

export interface LegacyEffects {
  dirty: (change: SessionChange) => void;
  draft: (change: SessionChange) => void;
  save: (change: SessionChange) => void;
  edit: () => Capability;
  editorName: () => string;
  attribute: (doc: DocumentView) => Plan | null;
}

export const REVIEW_ONLY = "review";

function missing(port: string): never {
  throw new Error("The session's " + port + " port was not provided");
}

const given: LegacyEffects = {
  dirty: function () { missing("dirty"); },
  draft: function () { missing("draft"); },
  save: function () { missing("save"); },
  edit: function () { return missing("edit capability"); },
  editorName: function () { return missing("editor name"); },
  attribute: function () { return missing("attribution"); }
};

export const sessionStamps: StampPorts = Object.freeze({
  clock: systemClock,
  editor: Object.freeze({ name: function () { return given.editorName(); } })
});

export const sessionTextPorts: CellTextPorts = Object.freeze({
  clock: sessionStamps.clock,
  editor: sessionStamps.editor,
  cells: function (html: string) { return cellOf(html); }
});

let refreshRunner: (jobs: ReadonlySet<string>) => void = function () { missing("refresh"); };

function enter(raw: unknown): ValidatedDocument {
  return migrateRows(raw);
}

function startSession(after: SessionCounters): DocumentSession {
  return createDocumentSession({
    entry: enter,
    undo: createUndoAdapter(),
    effects: {
      dirty: function (change) { given.dirty(change); },
      draft: function (change) { given.draft(change); },
      save: function (change) { given.save(change); },
      refresh: function (jobs) { refreshRunner(jobs); }
    },
    capability: { edit: function () { return given.edit(); } },
    reconcile: { anchors: function (doc) { return syncCommentAnchors(doc, cellOf); } },
    attribution: { attribute: function (doc) { return given.attribute(doc); } },
    report: function (error) { console.error(error); },
    timers: {
      now: function () { return Date.now(); },
      start: function (run, ms) { return setTimeout(run, ms); },
      stop: function (handle) { clearTimeout(handle as number); }
    },
    after: after
  });
}

let current: DocumentSession = startSession({ epoch: 0, generation: 0 });
let ended = false;

const replacedListeners: Array<() => void> = [];

function announceReplaced(): void {
  for (const listener of replacedListeners.slice()) listener();
}

watchUndoAdoption(function (doc) {
  current.adopt(doc);
  announceReplaced();
});

export function onDocumentReplaced(listener: () => void): void {
  replacedListeners.push(listener);
}

const session: DocumentSession = {
  epoch: function () { return current.epoch(); },
  generation: function () { return current.generation(); },
  read: function <T>(select: (doc: DocumentView | null) => T): T { return current.read(select); },
  adopt: function (raw: unknown) { return current.adopt(raw); },
  absorbServer: function (raw: unknown) { return current.absorbServer(raw); },
  absorbRecovery: function (raw: unknown) { return current.absorbRecovery(raw); },
  absorbMerged: function (kind: "server" | "recovery", merged: ValidatedDocument) { return current.absorbMerged(kind, merged); },
  absorbReload: function (content: ReloadedContent) { return current.absorbReload(content); },
  settle: function (kind: AbsorbedKind) { current.settle(kind); },
  run: function (command: Command) { return current.run(command); },
  replay: function (task: Replay) { return current.replay(task); },
  amend: function (task: Replay) { return current.amend(task); },
  noteEdit: function (changes?: ChangeSet) { current.noteEdit(changes); },
  refresh: function (job: string) { current.refresh(job); },
  subscribe: function (listener: SessionListener) { return current.subscribe(listener); },
  dispose: function () {
    ended = true;
    current.dispose();
  }
};

function holdLive(live: ValidatedDocument | null): void {
  if (live && current.read(function (held) { return held; }) !== live) current.adopt(live);
}

routeReplays(function (task, live) {
  holdLive(live);
  return session.replay(task);
}, sessionStamps, function (task, live) {
  holdLive(live);
  return session.amend(task);
});

export function adoptReplacement(doc: ValidatedDocument): void {
  if (ended) return;
  const old = current;
  current = startSession({ epoch: old.epoch(), generation: old.generation() });
  old.dispose();
  followLiveDocument();
  if (current.read(function (held) { return held; }) !== doc) current.adopt(doc);
  announceReplaced();
}

export function provideSessionEffects(effects: Partial<LegacyEffects>): void {
  if (effects.dirty) given.dirty = effects.dirty;
  if (effects.draft) given.draft = effects.draft;
  if (effects.save) given.save = effects.save;
  if (effects.edit) given.edit = effects.edit;
  if (effects.editorName) given.editorName = effects.editorName;
  if (effects.attribute) given.attribute = effects.attribute;
}

export function readSession<T>(select: (doc: DocumentView | null) => T): T {
  followLiveDocument();
  return session.read(select);
}

export function runCommand(command: Command): CommandOutcome {
  followLiveDocument();
  return session.run(command);
}

export function editAllowed(): boolean {
  return given.edit().allowed;
}

export function provideRefreshRunner(run: (jobs: ReadonlySet<string>) => void): void {
  refreshRunner = run;
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
