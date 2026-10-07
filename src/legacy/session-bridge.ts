import { createDocumentSession } from "../application/session/document-session.ts";
import type { AbsorbedKind, DocumentSession } from "../application/session/document-session.ts";
import type { SessionChange } from "../application/session/change-set.ts";
import type { Capability } from "../application/session/ports.ts";
import type { ValidatedDocument } from "../core/document/validated.ts";
import { syncCommentAnchors } from "../core/text/anchors.ts";
import { migrateRows } from "../js/02-state.js";
import { cellOf } from "./richtext.ts";
import { createUndoAdapter, watchUndoAdoption } from "./undo-adapter.ts";

export interface LegacyEffects {
  dirty: (change: SessionChange) => void;
  draft: (change: SessionChange) => void;
  save: (change: SessionChange) => void;
  edit: () => Capability;
}

const ALLOWED: Capability = Object.freeze({ allowed: true });

function nothing(): void {}

const given: LegacyEffects = {
  dirty: nothing,
  draft: nothing,
  save: nothing,
  edit: function () { return ALLOWED; }
};

let refreshRunner: (jobs: ReadonlySet<string>) => void = nothing;

function enter(raw: unknown): ValidatedDocument {
  return migrateRows(raw);
}

const session: DocumentSession = createDocumentSession({
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
  timers: {
    now: function () { return Date.now(); },
    start: function (run, ms) { return setTimeout(run, ms); },
    stop: function (handle) { clearTimeout(handle as number); }
  }
});

watchUndoAdoption(function (doc) { session.adopt(doc); });

export function provideSessionEffects(effects: Partial<LegacyEffects>): void {
  if (effects.dirty) given.dirty = effects.dirty;
  if (effects.draft) given.draft = effects.draft;
  if (effects.save) given.save = effects.save;
  if (effects.edit) given.edit = effects.edit;
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

export function noteReload(): void {
  session.absorbReload();
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
