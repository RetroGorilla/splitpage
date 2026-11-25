import * as Y from "yjs";
import type { NativeMembershipRecord, NativeReplicaEntry } from "../../../../shared/native-replica.d.ts";
import { decodeNativePendingEdits, encodeNativePendingEdits } from "./pending-edits.ts";
import type { NativePendingEditsData } from "./pending-edits.ts";
import { nativeCallbackGuard } from "./script.ts";
import { openNativeSession, type NativeSessionOptions } from "./session.ts";

const CHECKPOINT_EVERY = 512;
const MAX_TAIL = 4 * CHECKPOINT_EVERY;
const MAX_REPLICA_JOURNAL_BYTES = 16_000_000;
type Session = ReturnType<typeof openNativeSession>;
type StoreReopen = (failed: Session) => Promise<Session>;
let openers: WeakMap<Session, StoreReopen> | null = null;

function markNativeStoreSession(session: Session, reopen: StoreReopen): void {
  (openers ??= new WeakMap()).set(session, reopen);
}

export function nativeStoreOpener(session: Session): StoreReopen | undefined {
  return openers?.get(session);
}

export type NativeLocalStoreFailure = {
  readonly kind: "failed";
  readonly reason: "locked" | "blocked" | "quota" | "closed" | "version" | "unavailable" | "io";
  readonly error?: unknown;
};

export type NativeLocalStoreReceipt =
  | { readonly kind: "stored"; readonly generation: number }
  | NativeLocalStoreFailedReceipt;

type NativeLocalStoreFailedReceipt = NativeLocalStoreFailure & {
  readonly generation: number;
  readonly committed: number;
  readonly operation?: "compact";
};

export type NativeLocalStoreClose = NativeLocalStoreReceipt & { readonly state: Uint8Array };

export type NativeLocalStoreOpen = NativeLocalStoreFailure | {
  readonly kind: "opened";
  readonly restored: boolean;
  readonly membership?: NativeReplicaMembership;
  readonly discardOnClose?: () => Promise<boolean>;
  readonly hasUnstoredChanges: () => boolean;
  readonly generation: number;
  readonly session: ReturnType<typeof openNativeSession>;
  readonly persistent: Promise<boolean>;
  readonly flush: () => Promise<NativeLocalStoreReceipt>;
  readonly subscribe: (listener: (receipt: NativeLocalStoreReceipt) => void) => () => void;
  readonly reopen: StoreReopen;
  readonly closed: Promise<NativeLocalStoreClose>;
};

export interface NativeLocalStore {
  readonly open: (name: string, options: NativeSessionOptions) => Promise<NativeLocalStoreOpen>;
  readonly delete: (name: string) => Promise<{ readonly kind: "stored" } | NativeLocalStoreFailure>;
}

export interface NativeReplicaMembership {
  readonly record: () => Promise<NativeMembershipRecord | null>;
  readonly token: () => Promise<string | null>;
  readonly manage?: (operation: string, address: string) => Promise<NativeMembershipRecord>;
  readonly join: (record: string | NativeMembershipRecord) => Promise<void>;
  readonly stageInvitation?: (token: string, previous: NativeMembershipRecord | null, signal: AbortSignal) => Promise<NativeInvitationStage>;
}

export interface NativeInvitationStage {
  readonly commit: () => void;
  readonly rollback: () => Promise<void>;
}

export interface NativeReplicaConnection {
  readonly membership?: NativeReplicaMembership;
  readonly forget?: () => Promise<void>;
  readonly read: (through?: number) => Promise<readonly NativeReplicaEntry[]>;
  readonly write: (entry: NativeReplicaEntry) => Promise<void>;
  readonly readJournal?: () => Promise<Uint8Array | null>;
  readonly writeJournal?: (bytes: Uint8Array) => Promise<void>;
  readonly release: () => Promise<void>;
  readonly persistent: () => Promise<boolean>;
  readonly onStop?: (stop: (reason: "closed" | "version") => void) => void;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

export function nativeLocalStoreFailure(error: unknown): NativeLocalStoreFailure {
  switch (error instanceof DOMException ? error.name : "") {
    case "QuotaExceededError": return { kind: "failed", reason: "quota", error };
    case "InvalidStateError": return { kind: "failed", reason: "closed", error };
    case "VersionError": return { kind: "failed", reason: "version", error };
    default: return { kind: "failed", reason: "io", error };
  }
}

function replicaState(entries: readonly NativeReplicaEntry[]): Uint8Array {
  const doc = new Y.Doc();
  try {
    doc.transact(() => {
      for (const entry of entries) {
        if (!(entry?.bytes instanceof Uint8Array)) throw new TypeError("Invalid replica bytes");
        Y.applyUpdate(doc, entry.bytes);
      }
    });
    return Y.encodeStateAsUpdate(doc);
  } finally { doc.destroy(); }
}

type PendingWrite =
  | { readonly kind: "entry"; readonly generation: number; readonly checkpoint: boolean; readonly bytes: Uint8Array; journal?: Uint8Array; journalDirty?: boolean }
  | { readonly kind: "journal"; bytes?: Uint8Array; journalDirty?: boolean };

interface RecoveryState {
  readonly state: Uint8Array;
  readonly journal?: Uint8Array;
}

export async function attachNativeLocalStore(
  { read, write, readJournal, writeJournal, release, persistent, onStop, membership, forget }: NativeReplicaConnection, options: NativeSessionOptions
): Promise<NativeLocalStoreOpen> {
  let stopped: NativeLocalStoreFailure | undefined;
  let disconnect: (() => void) | undefined;
  onStop?.(reason => {
    stopped = { kind: "failed", reason };
    disconnect?.();
  });
  const entries = await read().catch(error => {
    if (!stopped) throw error;
    return [];
  });
  if (stopped) return stopped;

  let initialJournal: NativeSessionOptions["noticeJournal"] = options.noticeJournal;
  let journalCorrupt = false;
  if (options.noticeJournal) {
    const rawJournal = await readJournal?.().catch(error => {
      if (!stopped) throw error;
      return null;
    });
    if (stopped) return stopped;
    if (rawJournal) {
      try { initialJournal = decodeNativePendingEdits(rawJournal); }
      catch (error) {
        if (error instanceof DOMException && error.name === "VersionError") throw error;
        journalCorrupt = true;
      }
    }
  }
  const initialOptions: NativeSessionOptions = initialJournal !== undefined ? { ...options, noticeJournal: initialJournal } : options;
  let session: Session;
  try {
    session = openNativeSession(entries.length ? { kind: "state", state: replicaState(entries) } : { kind: "empty" }, initialOptions);
  } catch (error) {
    if (initialJournal === options.noticeJournal || (error instanceof DOMException && error.name === "VersionError")) throw error;
    journalCorrupt = true;
    session = openNativeSession(entries.length ? { kind: "state", state: replicaState(entries) } : { kind: "empty" }, options);
  }
  const listeners = new Set<(receipt: NativeLocalStoreReceipt) => void>();
  const closed = deferred<NativeLocalStoreClose>();
  let discard: ReturnType<typeof deferred<boolean>> | undefined;
  let released = false;
  let drained = deferred<NativeLocalStoreClose>();
  let recovering = false, handoff: ReturnType<typeof deferred<Session>> | undefined;
  let recovery: RecoveryState | undefined;
  const pending: PendingWrite[] = [];
  let inFlight: PendingWrite | undefined;
  let lastJournalRevision = session.pendingEdits?.revision() ?? 0;
  const generation = entries.at(-1)?.generation ?? 0;
  let committed = generation, next = generation;
  let checkpoint = entries[0]?.checkpoint ? entries[0].generation : 0;
  let active: Promise<NativeLocalStoreReceipt> | undefined;
  let compaction: Promise<NativeLocalStoreFailedReceipt | undefined> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function publish(receipt: NativeLocalStoreReceipt): void {
    for (const listener of [...listeners]) {
      // why: one subscriber's error must not hide an outcome from the others
      try { listener(receipt); } catch { continue; }
    }
  }

  function current(): NativeLocalStoreReceipt {
    return stopped ? { ...stopped, generation: next, committed } : { kind: "stored", generation: committed };
  }

  function cancelTimer(): void { clearTimeout(timer); timer = undefined; }

  function compact(): Promise<NativeLocalStoreFailedReceipt | undefined> {
    const through = committed;
    cancelTimer();
    compaction ??= (async () => {
      try {
        // why: the live session may already contain changes beyond the committed generation
        const entries = await read(through);
        const queued = pending.at(-1);
        if (through < checkpoint || (queued?.kind === "entry" && queued.checkpoint && through < queued.generation)) return undefined;
        const bytes = replicaState(entries);
        await write({ generation: through, bytes, checkpoint: true });
        checkpoint = through;
        return undefined;
      } catch (error) { return { ...nativeLocalStoreFailure(error), generation: through, committed, operation: "compact" } as const; }
    })().finally(() => { compaction = undefined; });
    return compaction;
  }

  function scheduleCompaction(): void {
    if (timer !== undefined || compaction || committed - checkpoint < CHECKPOINT_EVERY || session.isClosingOrClosed()) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (pending.length || session.isClosingOrClosed()) return;
      void compact().then(result => { if (result) publish(result); });
    }, 0);
  }

  function failedWrite(result: NativeLocalStoreReceipt): NativeLocalStoreReceipt {
    // why: a failure listener can call flush to retry once the failed transaction has settled
    active = undefined;
    publish(result);
    return result;
  }

  function encodeBoundedJournal(): Uint8Array | undefined {
    const edits = session.pendingEdits;
    if (!edits) return undefined;
    const bytes = encodeNativePendingEdits(edits.data());
    if (bytes.byteLength > MAX_REPLICA_JOURNAL_BYTES) {
      return encodeNativePendingEdits({ through: edits.through(), entries: [] });
    }
    return bytes;
  }

  async function drain(): Promise<NativeLocalStoreReceipt> {
    while (!stopped) {
      if (!pending.length && recovery) {
        pending.push({
          kind: "entry", generation: ++next, bytes: recovery.state, checkpoint: true,
          ...(recovery.journal && { journal: recovery.journal })
        });
        recovery = undefined;
      }
      const item = pending[0];
      if (!item) break;
      if (item.kind === "journal") {
        if (!writeJournal) { pending.shift(); continue; }
        const bytes = item.bytes ?? (item.journalDirty ? encodeBoundedJournal() : undefined);
        if (!bytes) { pending.shift(); publish({ kind: "stored", generation: committed }); continue; }
        inFlight = item;
        try { await writeJournal(bytes); }
        catch (error) {
          inFlight = undefined;
          return failedWrite({ ...nativeLocalStoreFailure(error), generation: committed, committed });
        }
        inFlight = undefined;
        pending.shift();
        publish({ kind: "stored", generation: committed });
        continue;
      }
      if (!item.checkpoint && committed - checkpoint >= MAX_TAIL) {
        const failed = await compact();
        if (failed) return failedWrite({ ...failed, generation: item.generation });
        if (stopped) break;
      }
      const journal = item.journal ?? (item.journalDirty ? encodeBoundedJournal() : undefined);
      inFlight = item;
      try {
        await write({
          generation: item.generation, checkpoint: item.checkpoint, bytes: item.bytes,
          ...(journal && { journal })
        });
      } catch (error) {
        inFlight = undefined;
        return failedWrite({ ...nativeLocalStoreFailure(error), generation: item.generation, committed });
      }
      inFlight = undefined;
      pending.shift();
      committed = item.generation;
      if (item.checkpoint) checkpoint = committed;
      publish({ kind: "stored", generation: committed });
    }
    active = undefined;
    scheduleCompaction();
    return current();
  }

  function flush(): Promise<NativeLocalStoreReceipt> {
    active ??= Promise.resolve().then(drain);
    return active;
  }

  function saveUpdate(bytes: Uint8Array): void {
    let journalDirty = false;
    const edits = session.pendingEdits;
    if (edits && !session.inCommand()) {
      const rev = edits.revision();
      if (rev !== lastJournalRevision) {
        lastJournalRevision = rev;
        journalDirty = true;
      }
    }
    pending.push({ kind: "entry", generation: ++next, bytes: new Uint8Array(bytes), checkpoint: false, ...(journalDirty && { journalDirty: true }) });
    void flush();
  }

  function saveJournal(): void {
    const edits = session.pendingEdits;
    if (!edits) return;
    const rev = edits.revision();
    if (rev === lastJournalRevision) return;
    lastJournalRevision = rev;
    const tail = pending.at(-1);
    if (tail && tail !== inFlight) {
      if (tail.kind === "journal") { tail.journalDirty = true; return; }
      if (tail.kind === "entry" && !tail.checkpoint) { tail.journalDirty = true; return; }
    }
    pending.push({ kind: "journal", journalDirty: true });
    void flush();
  }

  async function finish(state: Uint8Array, savedJournal?: NativePendingEditsData): Promise<void> {
    const inProgress = active, finished = drained;
    let result = await flush();
    if (inProgress && result.kind === "failed") result = await flush();
    cancelTimer();
    await compaction;
    if (stopped) {
      result = current();
      publish(result);
    }
    const requested = handoff;
    handoff = undefined;
    recovering = false;
    if (requested) {
      try {
        if (result.kind === "failed") throw result;
        const reopenedOptions: NativeSessionOptions = savedJournal
          ? { ...options, noticeJournal: savedJournal }
          : options;
        session = openNativeSession({ kind: "state", state }, reopenedOptions);
        drained = deferred<NativeLocalStoreClose>();
        bind();
        finished.resolve({ ...result, state });
        requested.resolve(session);
        return;
      } catch (error) { requested.reject(error); }
    }
    const discarded = discard && forget ? await forget().then(() => true, () => false) : false;
    try { await release(); }
    catch (error) {
      if (result.kind === "stored") result = { ...nativeLocalStoreFailure(error), generation: next, committed };
    }
    listeners.clear();
    const outcome = { ...result, state };
    released = true;
    finished.resolve(outcome);
    closed.resolve(outcome);
    discard?.resolve(discarded);
  }

  function bind(): void {
    markNativeStoreSession(session, reopen);
    lastJournalRevision = journalCorrupt ? -1 : (session.pendingEdits?.revision() ?? 0);
    journalCorrupt = false;
    const doc = session.ydoc, guardSharedCallback = nativeCallbackGuard(doc);
    const updated = (bytes: Uint8Array) => guardSharedCallback(() => saveUpdate(bytes));
    const stopJournal = session.pendingEdits?.subscribe(saveJournal);
    doc.on("update", updated);
    session.subscribe(change => {
      if (change.kind !== "closed") return;
      const state = new Uint8Array(change.state);
      const savedJournal = session.pendingEdits?.data();
      doc.off("update", updated);
      stopJournal?.();
      recovering = !stopped && change.reason === "failed";
      if (recovering) {
        const journal = savedJournal ? encodeNativePendingEdits(savedJournal) : undefined;
        recovery = { state, ...(journal && journal.byteLength <= MAX_REPLICA_JOURNAL_BYTES && { journal }) };
      }
      void finish(state, savedJournal);
    });
    disconnect = () => { cancelTimer(); doc.off("update", updated); stopJournal?.(); session.close(); };
  }

  function reopen(failed: Session): Promise<Session> {
    if (!recovering || failed !== session) return Promise.reject(new Error("The store has no handover for this session."));
    handoff ??= deferred<Session>();
    return handoff.promise;
  }

  bind();
  return {
    kind: "opened", restored: entries.length > 0, generation, get session() { return session; },
    persistent: persistent(),
    ...(membership && { membership }),
    ...(forget && { discardOnClose: () => discard?.promise ?? (released ? Promise.resolve(false) : (discard = deferred<boolean>()).promise) }),
    hasUnstoredChanges: () => next > committed || pending.length > 0 || recovery !== undefined,
    flush: () => session.isClosingOrClosed() ? drained.promise : flush(),
    reopen,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    closed: closed.promise
  };
}
