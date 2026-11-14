import { createDocumentSession } from "../../application/session/document-session.ts";
import { captureSessionCapabilities } from "../../application/session/capabilities.ts";
import type { AbsorbedKind, Command, CommandOutcome, CommonDocumentSession, DocumentSession, DocumentView, Plan, ReloadedContent, Replay, SessionCounters, SessionListener, Stamp, StandaloneDocumentSession } from "../../application/session/document-session.ts";
import type { ChangeSet } from "../../application/session/change-set.ts";
import type { RecordsReconciler } from "../../application/production/broll-records.ts";
import type { CapabilityPort, CellTextPorts, DocumentEntry, EditorPort, EffectPort, ReportPort, StampPorts, TimerPort, UndoPort } from "../../application/session/ports.ts";
import type { SharedDocumentSession } from "../../application/session/shared-session.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import { enterSharedDocument } from "../../core/migrate.ts";
import type { LiveDocumentPort } from "../../application/transitions/ports.ts";
import { syncCommentAnchors } from "../../core/text/anchors.ts";
import { systemClock } from "../../adapters/identity/ids.ts";
import { cellOf, scriptCellOf } from "../richtext.ts";
import { documentGuardOn, documentView, unwrapped } from "../../application/identity/document-guard.ts";
import { createNumberingReader } from "../../application/session/numbering.ts";
import type { DocumentNumberingReader } from "../../application/session/numbering.ts";

export type SessionReplayRunner = StandaloneDocumentSession["replay"];

export interface SessionUndoPorts {
  readonly adapter: UndoPort;
  readonly route: (run: SessionReplayRunner, stamps: StampPorts, amend: StandaloneDocumentSession["amend"]) => () => void;
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

export interface SharedOwnerPorts {
  readonly entry: DocumentEntry;
  readonly capability: CapabilityPort;
  readonly after: SessionCounters;
  readonly refresh: (jobs: ReadonlySet<string>) => void;
}

type Owner =
  | { readonly kind: "standalone"; readonly session: DocumentSession }
  | { readonly kind: "shared"; readonly session: SharedDocumentSession; readonly entered: WeakMap<object, ValidatedDocument> };

interface Started {
  readonly numbering: DocumentNumberingReader;
  readonly ports: SessionBridgePorts;
  current: Owner;
  capability: CapabilityPort;
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

function refreshed(ports: SessionBridgePorts): (jobs: ReadonlySet<string>) => void {
  return function (jobs) {
    ports.effects.refresh(jobs);
    refreshListeners.slice().forEach(function (listener) { listener(jobs); });
  };
}

function createSession(ports: SessionBridgePorts, after: SessionCounters, numbering: DocumentNumberingReader, capability: CapabilityPort): DocumentSession {
  const made = createDocumentSession({
    entry: ports.entry,
    undo: ports.undo.adapter,
    effects: {
      dirty: function (change) { ports.effects.dirty(change); },
      draft: function (change) { ports.effects.draft(change); },
      save: function (change) { ports.effects.save(change); },
      refresh: refreshed(ports)
    },
    capability: capability,
    reconcile: {
      anchors: function (doc) { return syncCommentAnchors(doc, cellOf); },
      records: ports.records
    },
    attribution: ports.attribution,
    report: ports.report,
    timers: ports.timers,
    after: after
  });
  made.subscribe(change => {
    numbering.changed(change.changes);
    if (ports.records.resync) ports.records.resync(made.held(), change.changes);
  });
  changeListeners.forEach(function (entry) { made.subscribe(hearing(entry)); });
  return made;
}

const replacedListeners: Array<() => void> = [];

let replacementErrors: unknown[] | null = null;

function announceReplaced(): void {
  const sink = replacementErrors;
  if (!sink) {
    for (const listener of replacedListeners.slice()) listener();
    return;
  }
  for (const listener of replacedListeners.slice()) {
    try { listener(); } catch (error) { sink.push(error); }
  }
}

export function collectReplacementErrors<T>(errors: unknown[], run: () => T): T {
  const outer = replacementErrors;
  replacementErrors = errors;
  try { return run(); } finally { replacementErrors = outer; }
}

export interface OwnerSwap {
  readonly commit: () => void;
  readonly restore: () => void;
}

let commandHold: string | null = null;

function heldOutcome(): CommandOutcome | null {
  return commandHold ? { kind: "rejected", reason: commandHold } : null;
}

export function holdSessionCommands(reason: string): () => void {
  const outer = commandHold;
  commandHold = reason;
  let open = true;
  return function () {
    if (!open) return;
    open = false;
    commandHold = outer;
  };
}

export function onDocumentReplaced(listener: () => void): () => void {
  replacedListeners.push(listener);
  return function () {
    const at = replacedListeners.indexOf(listener);
    if (at !== -1) replacedListeners.splice(at, 1);
  };
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
  if (started) started.current.session.subscribe(hearing(entry));
  return function () {
    entry.on = false;
    const at = changeListeners.indexOf(entry);
    if (at !== -1) changeListeners.splice(at, 1);
  };
}

function swept<T>(outcome: T): T {
  if (documentGuardOn()) unwrapped(ownerDocument());
  return outcome;
}

function standaloneOnly(member: string): string {
  return "standalone only while the session is shared: " + member;
}

function owner(): CommonDocumentSession {
  return running().current.session;
}

function standalone(member: string) {
  const now = running().current;
  if (now.kind === "shared") throw new Error(standaloneOnly(member));
  return now.session;
}

function refusedWhileShared(member: string): CommandOutcome | null {
  const now = running().current;
  return now.kind === "shared" ? now.session.refuse(standaloneOnly(member)) : null;
}

const session: DocumentSession = {
  epoch: function () { return owner().epoch(); },
  generation: function () { return owner().generation(); },
  read: function <T>(select: (doc: DocumentView | null) => T): T { return owner().read(select); },
  held: function () { return standalone("held").held(); },
  adopt: function (raw: unknown) { return standalone("adopt").adopt(unwrapped(raw)); },
  absorbDisk: function (raw: unknown) { return standalone("absorbDisk").absorbDisk(unwrapped(raw)); },
  absorbRecovery: function (raw: unknown) { return standalone("absorbRecovery").absorbRecovery(unwrapped(raw)); },
  absorbMerged: function (kind: "disk" | "recovery", merged: ValidatedDocument | null) { return standalone("absorbMerged").absorbMerged(kind, unwrapped(merged)); },
  absorbReload: function (content: ReloadedContent) { return standalone("absorbReload").absorbReload(unwrapped(content)); },
  settle: function (kind: AbsorbedKind) { standalone("settle").settle(kind); },
  run: function (command: Command) { return heldOutcome() ?? swept(owner().run(command)); },
  replay: function (task: Replay) { return refusedWhileShared("replay") ?? swept(standalone("replay").replay(task)); },
  amend: function (task: Replay) { return refusedWhileShared("amend") ?? swept(standalone("amend").amend(task)); },
  stamp: function (task: Stamp) { return refusedWhileShared("stamp") ?? swept(standalone("stamp").stamp(task)); },
  noteEdit: function (changes?: ChangeSet) { standalone("noteEdit").noteEdit(changes); swept(null); },
  refresh: function (job: string) { owner().refresh(job); },
  cancelRefresh: function (jobs: readonly string[]) { owner().cancelRefresh(jobs); },
  subscribe: function (listener: SessionListener) { return owner().subscribe(listener); },
  dispose: function () {
    const now = running();
    now.ended = true;
    now.current.session.dispose();
  }
};

const STALE: CommandOutcome = Object.freeze({ kind: "noop" });

export function startSessionBridge(ports: SessionBridgePorts): () => void {
  if (started) throw new Error("The document session is already started; stop it first");
  const numbering = createNumberingReader();
  const capability = captureSessionCapabilities(ports.capability);
  const mine: Started = { ports: ports, numbering, capability, current: { kind: "standalone", session: createSession(ports, { epoch: 0, generation: 0 }, numbering, capability) }, ended: false, mergeBase: null };
  const releases: (() => void)[] = [];
  const release = (): void => {
    if (started === mine) started = null;
    try {
      mine.current.session.dispose();
    } finally {
      while (releases.length) releases.pop()?.();
    }
  };
  started = mine;
  try {
    releases.push(ports.undo.route(function (task) {
      if (started !== mine) return STALE;
      return heldOutcome() ?? refusedWhileShared("replay") ?? swept(standalone("replay").replay(task));
    }, sessionStamps, function (task) {
      if (started !== mine) return STALE;
      return heldOutcome() ?? refusedWhileShared("amend") ?? swept(standalone("amend").amend(task));
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

export function adoptReplacement(doc: ValidatedDocument, capability?: CapabilityPort): void {
  const now = running();
  if (now.ended) return;
  const old = now.current.session;
  if (now.current.kind === "shared" && !capability) throw new Error("Leaving a shared session takes the standalone capabilities");
  const nextCapability = capability ? captureSessionCapabilities(capability) : now.capability;
  const next = createSession(now.ports, { epoch: old.epoch(), generation: old.generation() }, now.numbering, nextCapability);
  now.current = { kind: "standalone", session: next };
  now.capability = nextCapability;
  old.dispose();
  next.adopt(unwrapped(doc));
  announceReplaced();
}

function swapBack(now: Started, previous: Owner, previousCapability: CapabilityPort, replaced: CommonDocumentSession): () => void {
  return function () {
    if (now.current.session !== replaced) return;
    now.current = previous;
    now.capability = previousCapability;
    try { replaced.dispose(); } finally { announceReplaced(); }
  };
}

export function adoptShared(build: (ports: SharedOwnerPorts) => SharedDocumentSession, capability: CapabilityPort): OwnerSwap {
  const now = running();
  if (now.ended) throw new Error("The document session has ended");
  if (now.current.kind === "shared") throw new Error("The document session is shared already");
  const previous = now.current, previousCapability = now.capability, old = previous.session;
  const nextCapability = captureSessionCapabilities(capability);
  const entered = new WeakMap<object, ValidatedDocument>();
  const made = build({
    entry: function (raw) {
      const doc = enterSharedDocument(raw);
      entered.set(doc, doc);
      return doc;
    },
    capability: nextCapability,
    after: { epoch: old.epoch(), generation: old.generation() },
    refresh: refreshed(now.ports)
  });
  if (made.read(doc => doc !== null)) {
    made.dispose();
    throw new Error("A shared owner is adopted before it is hydrated, so the app hears its first document");
  }
  made.subscribe(change => { now.numbering.changed(change.changes); });
  changeListeners.forEach(function (entry) { made.subscribe(hearing(entry)); });
  now.current = { kind: "shared", session: made, entered: entered };
  now.capability = nextCapability;
  announceReplaced();
  return { commit: () => { if (now.current.session === made) old.dispose(); }, restore: swapBack(now, previous, previousCapability, made) };
}

export function landStandalone(doc: ValidatedDocument, capability: CapabilityPort): OwnerSwap {
  const now = running();
  if (now.current.kind !== "shared") throw new Error("Only a shared session lands a standalone copy");
  const previous = now.current, previousCapability = now.capability, old = previous.session;
  const nextCapability = captureSessionCapabilities(capability);
  const next = createSession(now.ports, { epoch: old.epoch(), generation: old.generation() }, now.numbering, nextCapability);
  now.current = { kind: "standalone", session: next };
  now.capability = nextCapability;
  try {
    next.adopt(unwrapped(doc));
  } catch (error) {
    now.current = previous;
    now.capability = previousCapability;
    next.dispose();
    throw error;
  }
  announceReplaced();
  return { commit: () => { if (now.current.session === next) old.dispose(); }, restore: swapBack(now, previous, previousCapability, next) };
}

export function sharedSession(): boolean {
  return started !== null && started.current.kind === "shared";
}

export function sharedRecoverySession(): Pick<SharedDocumentSession, "recovery" | "subscribe"> | null {
  return started?.current.kind === "shared" ? started.current.session : null;
}

// why: The shared session hands its projection to readers typed as a view; keeping the entry's own result gives
// the app's readers that same object, and only the core entry may make a validated document.
function ownerDocument(): ValidatedDocument | null {
  if (!started) return null;
  const now = started.current;
  if (now.kind === "standalone") return now.session.held();
  return now.session.read(function (view) {
    if (view === null) return null;
    const doc = now.entered.get(view);
    if (!doc) throw new Error("The shared projection did not come through the bridge's entry");
    return doc;
  });
}

export function heldDocument(): ValidatedDocument | null {
  if (started && started.current.kind === "shared") throw new Error(standaloneOnly("held"));
  return ownerDocument();
}

export function currentDocument(): ValidatedDocument | null {
  const doc = ownerDocument();
  return doc === null ? null : documentView(doc);
}

export function documentNumbering() {
  return running().numbering.read(currentDocument());
}


export const liveDocumentPort: LiveDocumentPort = Object.freeze({
  current: currentDocument,
  assign: adoptReplacement
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
  return running().capability.edit().allowed;
}

function attribute(): void {
  const outcome = session.stamp({ name: "attribute", plan: function (doc) { return running().ports.attribution.attribute(doc); } });
  if (outcome.kind === "failed") throw outcome.error;
}

export function noteSessionEdit(): void {
  attribute();
  session.noteEdit();
}

export function noteDiskUpdate(next: unknown): ValidatedDocument | null {
  return session.absorbDisk(next);
}

export function noteRecovery(next: unknown): ValidatedDocument | null {
  return session.absorbRecovery(next);
}

export function noteMerged(kind: "disk" | "recovery", merged: ValidatedDocument | null): ValidatedDocument | null {
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

export function cancelRefresh(jobs: readonly string[]): void {
  if (started && !started.ended) started.current.session.cancelRefresh(jobs);
}

export function liveSession(): CommonDocumentSession {
  return session;
}

export function currentCapabilities(): CapabilityPort {
  return running().capability;
}

export function standaloneSession(): StandaloneDocumentSession {
  return session;
}
