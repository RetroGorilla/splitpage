import * as Y from "yjs";
import type { NativeReplicaEntry } from "../../../../shared/native-replica.d.ts";
import { nativeCallbackGuard } from "./script.ts";
import { openNativeSession, type NativeSessionOptions } from "./session.ts";

const CHECKPOINT_EVERY = 512;
const MAX_TAIL = 4 * CHECKPOINT_EVERY;
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
  readonly token: () => Promise<string | null>;
  readonly join: (token: string) => Promise<void>;
  readonly stageInvitation?: (token: string, previous: string | null, signal: AbortSignal) => Promise<NativeInvitationStage>;
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

export async function attachNativeLocalStore(
  { read, write, release, persistent, onStop, membership, forget }: NativeReplicaConnection, options: NativeSessionOptions
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

  let session = openNativeSession(entries.length ? { kind: "state", state: replicaState(entries) } : { kind: "empty" }, options);
  const listeners = new Set<(receipt: NativeLocalStoreReceipt) => void>();
  const closed = deferred<NativeLocalStoreClose>();
  let discard: ReturnType<typeof deferred<boolean>> | undefined;
  let released = false;
  let drained = deferred<NativeLocalStoreClose>();
  let recovering = false, handoff: ReturnType<typeof deferred<Session>> | undefined;
  let recovery: Uint8Array | undefined;
  const pending: NativeReplicaEntry[] = [];
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
        if (through < checkpoint || (queued?.checkpoint && through < queued.generation)) return undefined;
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

  async function drain(): Promise<NativeLocalStoreReceipt> {
    while (!stopped) {
      if (!pending.length && recovery) {
        pending.push({ generation: ++next, bytes: recovery, checkpoint: true });
        recovery = undefined;
      }
      const entry = pending[0];
      if (!entry) break;
      if (!entry.checkpoint && committed - checkpoint >= MAX_TAIL) {
        const failed = await compact();
        if (failed) return failedWrite({ ...failed, generation: entry.generation });
        if (stopped) break;
      }
      try { await write(entry); }
      catch (error) {
        return failedWrite({ ...nativeLocalStoreFailure(error), generation: entry.generation, committed });
      }
      pending.shift();
      committed = entry.generation;
      if (entry.checkpoint) checkpoint = committed;
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
    pending.push({ generation: ++next, bytes: new Uint8Array(bytes), checkpoint: false });
    void flush();
  }

  async function finish(state: Uint8Array): Promise<void> {
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
        session = openNativeSession({ kind: "state", state }, options);
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
    const doc = session.ydoc, guardSharedCallback = nativeCallbackGuard(doc);
    const updated = (bytes: Uint8Array) => guardSharedCallback(() => saveUpdate(bytes));
    doc.on("update", updated);
    session.subscribe(change => {
      if (change.kind !== "closed") return;
      const state = new Uint8Array(change.state);
      doc.off("update", updated);
      recovering = !stopped && change.reason === "failed";
      if (recovering) recovery = state;
      void finish(state);
    });
    disconnect = () => { cancelTimer(); doc.off("update", updated); session.close(); };
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
    hasUnstoredChanges: () => next > committed || recovery !== undefined,
    flush: () => session.isClosingOrClosed() ? drained.promise : flush(),
    reopen,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    closed: closed.promise
  };
}
