import { applySharedUpdate, createSharedDocument, destroySharedDocument, encodeSharedState, encodeSharedStateVector, encodeSharedUpdate,
  observeSharedUpdates, shouldDeliverSharedUpdate } from "../../adapters/collab/document.ts";
import { observeSharedDeclined } from "../../adapters/collab/ingress.ts";
import { registerSharedOperationFamilies } from "../../adapters/collab/operation-families.ts";
import { createSharedReplica } from "../../adapters/collab/replica.ts";
import { sharedBufferedTarget } from "../../adapters/collab/buffer.ts";
import { bufferedFieldKey } from "../../core/collab/buffer.ts";
import { readSharedPaintedText } from "../../adapters/collab/paint-base.ts";
import { collabState } from "../../adapters/collab/state.ts";
import type { SharedDocumentHandle } from "../../adapters/collab/types.ts";
import { randomIds } from "../../adapters/identity/ids.ts";
import type { SharedUndo } from "../../application/editing/undo/shared-undo.ts";
import { sharedUndoActions } from "../../application/editing/undo/shared-undo-actions.ts";
import { createSharedSession } from "../../application/session/shared-session.ts";
import type { SharedDocumentSession } from "../../application/session/shared-session.ts";
import { createSessionCapabilities } from "../../application/session/capabilities.ts";
import { gallerySize } from "../../core/document/gallery.ts";
import { beatPos, replaceRange, setMarkAcross } from "../../core/flow/flow.ts";
import type { FlowDoc, FlowOutcome, FlowPorts, FlowRange } from "../../core/flow/flow.ts";
import { enterSharedDocument } from "../../core/migrate.ts";
import { projection } from "../../core/text/runs.ts";
import type { MarkName } from "../../core/text/runs.ts";
import type { SharedSwitchPorts, SharedSessionParts } from "./shared-session.ts";
import { sharedAuthorPort } from "./ports/shared-author.ts";
import { sharedBufferPorts } from "./ports/shared-buffer.ts";
import { sharedUndoOwner } from "./ports/shared-undo.ts";
import { sharedStructurePorts } from "./ports/shared-values.ts";
import { writerFlowCommands } from "./ports/writer-flow.ts";
import { addBeatCommand, deleteBeatCommand } from "../../application/commands/rows.ts";
import { joinBeatsCommand, splitBeatCommand, textCut } from "../../application/commands/split-join.ts";
import type { SharedApplyResult } from "../../adapters/collab/types.ts";
import { sharedBufferQueueBytes } from "../../core/collab/buffer.ts";
import { productionReaders } from "../document-ports.ts";
import { fromHtml } from "../richtext.ts";
import { sessionStamps } from "./session-owner.ts";
import { projectSharedDocumentWithRecovery } from "../../adapters/collab/project.ts";

type Side = "app" | "peer";
type BufferedField = "audioText" | "visualText";
type Order = "forward" | "reverse" | "duplicate" | "catch-up";
type RefusedKind = "throws" | "zero-length" | "queue-full";
export type SharedTestReplica = Side | "joiner";

const PEER_LEFT = "The peer has left";
const NOT_JOINED = "The late joiner has not joined";
const NAME_TAKEN = "The name is already given to another identity";
const UNKNOWN_REFUSAL = "There is no refused update of that kind";
const MEDIA_CELL = Object.freeze({ media: true });
// why: a decodable item whose origin is a later clock of its own client, which native integration throws on
const THROWS_WHILE_APPLYING: readonly number[] = [1, 1, 7, 0, 168, 7, 5, 1, 125, 1, 0];
const ZERO_LENGTH_STRUCT: readonly number[] = [1, 1, 1, 0, 40, 1, 4, 109, 101, 116, 97, 1, 120, 0, 0];

export function sharedTestBytes(update: string | Uint8Array | ArrayBuffer | readonly number[]): Uint8Array {
  if (typeof update === "string") return Uint8Array.from(atob(update), character => character.charCodeAt(0));
  return update instanceof ArrayBuffer ? new Uint8Array(update.slice(0)) : Uint8Array.from(update);
}

function base64Of(update: Uint8Array): string {
  let text = "";
  for (let at = 0; at < update.length; at += 0x8000) text += String.fromCharCode(...update.subarray(at, at + 0x8000));
  return btoa(text);
}

// why: the same flow ports as the Writer's (writer.ts), so the peer plans what a second Writer would plan
const PEER_FLOW: FlowPorts = {
  cells: html => fromHtml(html ?? "", MEDIA_CELL),
  newId: () => randomIds.id("r"),
  hasVisual: row => !!projection(fromHtml(row.visualText ?? "", MEDIA_CELL)) || !!gallerySize(row)
};

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sessionOn(handle: SharedDocumentHandle, ports: SharedSwitchPorts, undo?: SharedUndo) {
  const replica = createSharedReplica(handle, undefined, undo);
  const session = createSharedSession({ replica, entry: enterSharedDocument, undo: { record: () => {} },
    effects: { dirty: () => {}, draft: () => {}, save: () => {}, refresh: () => {} },
    capability: createSessionCapabilities("shared", ports.common), report: ports.report, timers: ports.timers, refused: ports.commandRefused });
  return { replica, session };
}

function hydratedCopy(source: SharedDocumentHandle, ports: SharedSwitchPorts): SharedDocumentHandle {
  const handle = createSharedDocument();
  registerSharedOperationFamilies(handle, ports.structure);
  const hydrated = applySharedUpdate(handle, encodeSharedState(source));
  if (!hydrated.ok) { destroySharedDocument(handle); throw new Error(hydrated.reason); }
  return handle;
}

function refuseName(name: string): never {
  throw new Error(NAME_TAKEN + ": " + name);
}

function range(rowId: string, from: number, endRow: string, to: number): FlowRange {
  return { anchor: beatPos(rowId, from), head: beatPos(endRow, to) };
}

function participantOn(handle: SharedDocumentHandle, ports: SharedSwitchPorts, name: string, live: () => boolean) {
  const author = sharedAuthorPort({ handle: () => live() ? handle : null, name: () => name });
  const undo = sharedUndoOwner(handle, () => author.next(), ports.now, ports.report);
  const { replica, session } = sessionOn(handle, ports, undo);
  const history = sharedUndoActions(session, undo);
  const stamps = { clock: sessionStamps.clock, editor: { name: () => name } };
  const text = sharedBufferPorts(handle, session, { author: () => {
    const next = author.next(); if (!next) throw new Error(PEER_LEFT); return next;
  }, readers: productionReaders, stamps, missingBase: () => {}, recovered: () => {}, report: ports.report });
  const buffered = (rowId: string, field: BufferedField, from: number, to: number, insert: string) => {
    const key = bufferedFieldKey(rowId, field), base = text.paintedText.read(key, field);
    if (!base) throw new Error("The peer beat is missing");
    const edit = text.bufferedText.open(key, base);
    if (!edit) throw new Error("The peer buffer is unavailable");
    edit.replace(from, to, insert);
    try { return edit.commit([{ text: edit.text(), marks: {} }], [from + insert.length, from + insert.length]); }
    finally { if (edit.isOpen()) edit.cancel(); }
  };
  return { author, undo, replica, session, history, stamps, buffered };
}

export function createSharedTestPeer(app: SharedSessionParts, ports: SharedSwitchPorts) {
  const handle = hydratedCopy(app.handle, ports);
  let live = true, paused = false;
  const { author, undo, replica, session, history, stamps, buffered } = participantOn(handle, ports, "Peer", () => live);
  const structure = sharedStructurePorts({ handle: () => live ? handle : null, author: () => author.next(),
    stamps, cells: html => ports.structure.cells(html) });
  const flow = writerFlowCommands(PEER_FLOW, { author, writer: () => String(collabState(handle).doc.clientID), handle: () => live ? handle : null });
  let joiner: { readonly handle: SharedDocumentHandle; readonly session: SharedDocumentSession; readonly dispose: () => void;
    readonly participant: ReturnType<typeof participantOn>; readonly written: Uint8Array[] } | null = null;
  const unitNames = new Map<string, string>(), beatNames = new Map<string, string>();
  const pending: { readonly side: Side; readonly id: number; readonly update: Uint8Array }[] = [];
  const applied: { readonly to: Side; readonly update: number }[] = [];
  let sent = 0;
  const alive = (): void => { if (!live) throw new Error(PEER_LEFT); };
  const enqueue = (side: Side, update: Uint8Array): void => {
    if (!live) return;
    pending.push({ side, id: ++sent, update: Uint8Array.from(update) });
    if (!paused) queueMicrotask(() => { if (live && !paused) deliver(); });
  };
  const receive = (side: Side, update: Uint8Array, id?: number): void => {
    const result = applySharedUpdate(side === "app" ? app.handle : handle, update);
    if (!result.ok && result.reason !== "queue-full") throw new Error(result.reason);
    if (result.ok && id !== undefined) applied.push({ to: side, update: id });
  };
  const catchUpOf = (side: Side): Uint8Array => {
    const target = side === "app" ? app.handle : handle, source = side === "app" ? handle : app.handle;
    return encodeSharedUpdate(source, encodeSharedStateVector(target));
  };
  const resend = (side: Side): void => {
    if (!live) return;
    receive(side, catchUpOf(side));
  };
  const taken = (to: Side): Uint8Array[] => {
    const updates = pending.filter(item => item.side === to);
    for (const item of updates) pending.splice(pending.indexOf(item), 1);
    return updates.map(item => item.update);
  };
  function deliver(order: Order = "forward", to?: Side): number {
    alive();
    const updates = pending.filter(item => !to || item.side === to);
    for (const item of updates) pending.splice(pending.indexOf(item), 1);
    if (order === "catch-up") {
      for (const side of ["app", "peer"] as const) {
        const ids = updates.filter(item => item.side === side).map(item => item.id);
        if (!ids.length) continue;
        const result = applySharedUpdate(side === "app" ? app.handle : handle, catchUpOf(side));
        if (!result.ok && result.reason !== "queue-full") throw new Error(result.reason);
        if (result.ok) for (const id of ids) applied.push({ to: side, update: id });
      }
      return updates.length;
    }
    if (order === "reverse") updates.reverse();
    for (const item of updates) {
      receive(item.side, item.update, item.id);
      if (order === "duplicate") receive(item.side, item.update, item.id);
    }
    return updates.length;
  }
  const releases = [
    observeSharedUpdates(app.handle, (update, origin) => { if (shouldDeliverSharedUpdate(origin)) enqueue("peer", update); }),
    observeSharedUpdates(handle, (update, origin) => { if (shouldDeliverSharedUpdate(origin)) enqueue("app", update); }),
    observeSharedDeclined(app.handle, () => { resend("app"); }), observeSharedDeclined(handle, () => { resend("peer"); })
  ];
  const joined = (): NonNullable<typeof joiner> => {
    alive();
    if (!joiner) throw new Error(NOT_JOINED);
    return joiner;
  };
  const planned = (name: string, operation: (doc: FlowDoc) => FlowOutcome, before: FlowRange): string => {
    alive();
    const command = flow.commands.prepare(name, operation, stamps, before).command;
    // why: as the Writer's runPlanned (flow-writer.ts): only a plan that was not refused ends the open undo group
    return session.run({ ...command, plan: (doc, capability) => {
      const plan = command.plan(doc, capability);
      if (plan && !("refused" in plan)) undo.breakGroup();
      return plan;
    } }).kind;
  };
  const replicaOf = (which: SharedTestReplica): { readonly handle: SharedDocumentHandle; readonly session: SharedDocumentSession } | null =>
    which === "app" ? app : which === "peer" ? { handle, session } : joiner;
  const unitsOf = (which: SharedTestReplica, rowId: string): readonly string[] | null => {
    const found = replicaOf(which);
    if (!found) return null;
    const painted = readSharedPaintedText(found.handle, sharedBufferedTarget(found.handle, rowId));
    if (!painted) return null;
    return Array.from({ length: painted.text.length }, (_, index) => painted.identity(index) ?? "");
  };
  const leaveJoiner = (): void => { const left = joiner; joiner = null; left?.dispose(); };
  const cellText = { ...stamps, cells: (html: string) => PEER_FLOW.cells(html) };
  const joinText = { ...cellText, plainText: (html: string | null | undefined) => projection(fromHtml(html ?? "", MEDIA_CELL)) };
  const structural = (command: Parameters<typeof session.run>[0]): string => { alive(); return session.run(command).kind; };
  const beatIds = (): readonly string[] => session.read(doc => doc ? doc.rows.map(row => row.id) : []);
  const created = (command: Parameters<typeof session.run>[0]): { readonly kind: string; readonly id: string | null } => {
    const before = new Set(beatIds()), kind = structural(command);
    return { kind, id: beatIds().find(id => !before.has(id)) ?? null };
  };
  let replaying: { readonly results: SharedApplyResult[]; total: number; timer: unknown } | null = null;
  const stopReplay = (): void => {
    const running = replaying;
    if (running && running.timer !== null) ports.timers.stop(running.timer);
    if (running) running.timer = null;
  };
  const replay = (updates: readonly (string | Uint8Array | readonly number[])[], everyMs: number, to: Side = "app"): number => {
    alive();
    stopReplay();
    paused = true;
    const bytes = updates.map(sharedTestBytes), started = ports.now(), target = to === "app" ? app.handle : handle;
    const running = { results: [] as SharedApplyResult[], total: bytes.length, timer: null as unknown };
    replaying = running;
    const next = (): void => {
      const at = running.results.length, update = bytes[at];
      if (!update) { running.timer = null; return; }
      running.timer = ports.timers.start(() => {
        if (!live || replaying !== running || running.timer === null) return;
        running.results.push(applySharedUpdate(target, update));
        next();
      }, Math.max(0, started + (at + 1) * everyMs - ports.now()));
    };
    next();
    return bytes.length;
  };
  return {
    split: (rowId: string, at: number) => created(splitBeatCommand(rowId, "audioText", textCut(at, at), PEER_FLOW.newId(), cellText, structure() ?? undefined)),
    join: (intoId: string) => structural(joinBeatsCommand(intoId, joinText, structure() ?? undefined)),
    add: (afterId: string | null) => created(addBeatCommand(afterId, PEER_FLOW.newId(), stamps, structure() ?? undefined)),
    inject: (update: string | Uint8Array | readonly number[], to: Side = "app"): SharedApplyResult => {
      alive();
      return applySharedUpdate(to === "app" ? app.handle : handle, sharedTestBytes(update));
    },
    refusedUpdate: (kind: RefusedKind, rowId?: string): string => {
      alive();
      if (kind === "throws") return base64Of(Uint8Array.from(THROWS_WHILE_APPLYING));
      if (kind === "zero-length") return base64Of(Uint8Array.from(ZERO_LENGTH_STRUCT));
      if (kind !== "queue-full" || !rowId) throw new Error(UNKNOWN_REFUSAL);
      const held = paused, before = sent;
      paused = true;
      try { buffered(rowId, "audioText", 0, 0, "x".repeat(sharedBufferQueueBytes() + 1)); } finally { paused = held; }
      const made = pending.filter(item => item.side === "app" && item.id > before);
      for (const item of made) pending.splice(pending.indexOf(item), 1);
      if (made.length !== 1 || !made[0]) throw new Error(UNKNOWN_REFUSAL);
      return base64Of(made[0].update);
    },
    capture: (to: Side = "app") => { alive(); return taken(to).map(base64Of); },
    replay,
    replayed: () => {
      const running = replaying;
      return running ? { delivered: running.results.filter(result => result.ok).length, refused: running.results.filter(result => !result.ok).length,
        remaining: running.total - running.results.length, running: running.timer !== null } : null;
    },
    stopReplay,
    recovery: () => projectSharedDocumentWithRecovery(handle).recovery,
    type: (rowId: string, offset: number, insert: string, field: BufferedField = "audioText") => { alive(); return buffered(rowId, field, offset, offset, insert); },
    erase: (rowId: string, from: number, to: number, field: BufferedField = "audioText") => { alive(); return buffered(rowId, field, from, to, "").kind; },
    format: (rowId: string, from: number, to: number, mark: MarkName = "b", endRow = rowId) => {
      const target = range(rowId, from, endRow, to);
      return planned("format", doc => setMarkAcross(doc, target, mark, flow.flow), target);
    },
    deleteRange: (rowId: string, from: number, endRow: string, to: number) => {
      const target = range(rowId, from, endRow, to);
      return planned("delete-selection", doc => replaceRange(doc, target, [], flow.flow), target);
    },
    remove: (rowId: string) => {
      alive();
      return session.run(deleteBeatCommand(rowId, structure() ?? undefined)).kind;
    },
    undo: () => { alive(); return history.undo(); },
    redo: () => { alive(); return history.redo(); },
    deliver,
    hold: () => { paused = true; },
    release: (order: Order = "forward") => { paused = false; return deliver(order); },
    lateJoiner: (from: Side = "app") => {
      alive();
      leaveJoiner();
      const copied = hydratedCopy(from === "app" ? app.handle : handle, ports), built = participantOn(copied, ports, "Joiner", () => live);
      const written: Uint8Array[] = [];
      const stop = observeSharedUpdates(copied, (update, origin) => { if (shouldDeliverSharedUpdate(origin)) written.push(Uint8Array.from(update)); });
      joiner = { handle: copied, session: built.session, participant: built, written,
        dispose: () => { stop(); built.session.dispose(); built.replica.dispose(); destroySharedDocument(copied); } };
      return built.session.read(doc => doc ? copy(doc) as unknown : null);
    },
    catchUp: () => {
      const third = joined();
      for (const source of [app.handle, handle]) {
        const result = applySharedUpdate(third.handle, encodeSharedUpdate(source, encodeSharedStateVector(third.handle)));
        if (!result.ok) throw new Error(result.reason);
      }
      for (const update of third.written.splice(0)) { receive("app", update); receive("peer", update); }
      return third.session.read(doc => doc ? copy(doc) as unknown : null);
    },
    joinerType: (rowId: string, offset: number, insert: string, field: BufferedField = "audioText") =>
      joined().participant.buffered(rowId, field, offset, offset, insert).kind,
    joinerUndo: () => joined().participant.history.undo(),
    read: (which: SharedTestReplica = "peer") => replicaOf(which)?.session.read(doc => doc ? copy(doc) as unknown : null) ?? null,
    recoveryEntries: (which: SharedTestReplica = "peer") => {
      const found = replicaOf(which);
      return found ? copy(found.session.recovery()) : null;
    },
    nameIdentities: (which: SharedTestReplica, rowId: string, from: number, names: readonly string[]) => {
      const units = unitsOf(which, rowId);
      if (!units) throw new Error("The beat has no painted text on " + which);
      const chosen = names.map((name, index) => {
        const unit = units[from + index];
        if (!unit) throw new Error("No character at " + String(from + index) + " in " + rowId + " on " + which);
        return [unit, name] as const;
      });
      chosen.forEach(([unit, name], index) => {
        if (chosen.some(([other, again], at) => at < index && again === name && other !== unit)) refuseName(name);
        const owner = [...unitNames].find(([other, given]) => given === name && other !== unit);
        if (owner) refuseName(name);
      });
      for (const [unit, name] of chosen) unitNames.set(unit, name);
    },
    nameBeat: (rowId: string, name: string) => {
      if ([...beatNames].some(([other, given]) => given === name && other !== rowId)) refuseName(name);
      beatNames.set(rowId, name);
    },
    identities: (which: SharedTestReplica = "peer") => {
      const found = replicaOf(which);
      if (!found) return null;
      const rows = found.session.read(doc => doc ? doc.rows.map(row => row.id) : []);
      return rows.map(rowId => ({ beat: beatNames.get(rowId) ?? rowId, units: (unitsOf(which, rowId) ?? []).map(unit => unitNames.get(unit) ?? null) }));
    },
    queued: () => pending.length,
    appliedUpdates: () => applied.map(entry => ({ ...entry })),
    dispose: () => {
      stopReplay();
      live = false;
      for (const release of releases) release();
      pending.length = 0; leaveJoiner(); session.dispose(); replica.dispose(); destroySharedDocument(handle);
    }
  };
}

export type SharedTestPeer = ReturnType<typeof createSharedTestPeer>;

export function sharedTestPeerHook(current: () => SharedTestPeer | null) {
  return {
    type: (rowId: string, offset: number, insert: string, field?: BufferedField) => current()?.type(rowId, offset, insert, field),
    erase: (rowId: string, from: number, to: number, field?: BufferedField) => current()?.erase(rowId, from, to, field),
    format: (rowId: string, from: number, to: number, mark?: MarkName, endRow?: string) => current()?.format(rowId, from, to, mark, endRow),
    deleteRange: (rowId: string, from: number, endRow: string, to: number) => current()?.deleteRange(rowId, from, endRow, to),
    remove: (rowId: string) => current()?.remove(rowId),
    split: (rowId: string, at: number) => current()?.split(rowId, at),
    join: (intoId: string) => current()?.join(intoId),
    add: (afterId: string | null) => current()?.add(afterId),
    inject: (update: string | Uint8Array | readonly number[], to?: Side) => current()?.inject(update, to),
    refusedUpdate: (kind: RefusedKind, rowId?: string) => current()?.refusedUpdate(kind, rowId),
    capture: (to?: Side) => current()?.capture(to) ?? [],
    replay: (updates: readonly (string | Uint8Array | readonly number[])[], everyMs: number, to?: Side) => current()?.replay(updates, everyMs, to),
    replayed: () => current()?.replayed() ?? null,
    stopReplay: () => { current()?.stopReplay(); },
    undo: () => current()?.undo(),
    redo: () => current()?.redo(),
    hold: () => { current()?.hold(); },
    deliver: (order?: Order, to?: Side) => current()?.deliver(order, to),
    release: (order?: Order) => current()?.release(order),
    lateJoiner: (from?: Side) => current()?.lateJoiner(from),
    catchUp: () => current()?.catchUp(),
    joinerType: (rowId: string, offset: number, insert: string, field?: BufferedField) => current()?.joinerType(rowId, offset, insert, field),
    joinerUndo: () => current()?.joinerUndo(),
    joined: () => current()?.read("joiner") ?? null,
    recoveryEntries: (which?: SharedTestReplica) => current()?.recoveryEntries(which) ?? null,
    nameIdentities: (which: SharedTestReplica, rowId: string, from: number, names: readonly string[]) => { current()?.nameIdentities(which, rowId, from, names); },
    nameBeat: (rowId: string, name: string) => { current()?.nameBeat(rowId, name); },
    identities: (which?: SharedTestReplica) => current()?.identities(which) ?? null,
    appliedUpdates: () => current()?.appliedUpdates() ?? []
  };
}
