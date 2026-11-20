import * as Y from "yjs";
import type { NativeLocalStore, NativeLocalStoreClose, NativeLocalStoreFailure, NativeLocalStoreOpen, NativeLocalStoreReceipt } from "./local-store.ts";
import { nativeCallbackGuard } from "./script.ts";
import { openNativeSession } from "./session.ts";
import type { NativeSessionOptions } from "./session.ts";

const DATABASE = "splitpage-native-replica-log";
const REPLICAS = "replicas";
const OPEN_TIMEOUT_MS = 2000;
const CHECKPOINT_EVERY = 512;

interface BrowserLocalStorePorts {
  readonly indexedDB?: IDBFactory;
  readonly locks?: Pick<LockManager, "request">;
  readonly storage?: Pick<StorageManager, "persist">;
}

interface ReplicaEntry {
  readonly name: string;
  readonly generation: number;
  readonly bytes: Uint8Array;
  readonly checkpoint: boolean;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

function failure(error: unknown): NativeLocalStoreFailure {
  switch (error instanceof DOMException ? error.name : "") {
    case "QuotaExceededError": return { kind: "failed", reason: "quota", error };
    case "InvalidStateError": return { kind: "failed", reason: "closed", error };
    case "VersionError": return { kind: "failed", reason: "version", error };
    default: return { kind: "failed", reason: "io", error };
  }
}

function acquire(locks: Pick<LockManager, "request">, name: string): Promise<(() => Promise<void>) | null> {
  return new Promise((resolve, reject) => {
    const hold = deferred<undefined>();
    const released = locks.request(`${DATABASE}:${name}`, { ifAvailable: true }, lock => {
      resolve(lock ? async () => { hold.resolve(undefined); await released; } : null);
      return lock ? hold.promise : undefined;
    });
    void released.catch(reject);
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase | NativeLocalStoreFailure> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, 1);
    let refused = false;
    // why: an open queued behind another connection's blocked upgrade or delete gets no blocked event of its own
    const timer = setTimeout(refuse, OPEN_TIMEOUT_MS);
    function refuse(): void {
      refused = true;
      clearTimeout(timer);
      resolve({ kind: "failed", reason: "blocked" });
    }
    request.onblocked = refuse;
    request.onupgradeneeded = () => {
      if (refused) request.transaction?.abort();
      else request.result.createObjectStore(REPLICAS, { keyPath: ["name", "generation"] });
    };
    request.onerror = () => { clearTimeout(timer); reject(request.error); };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (refused) request.result.close();
      else resolve(request.result);
    };
  });
}

function transact<T>(database: IDBDatabase, mode: "readonly" | "readwrite", run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(REPLICAS, mode, { durability: "strict" });
    try {
      const request = run(tx.objectStore(REPLICAS));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error ?? request.error);
    } catch (error) {
      // why: a synchronous put failure must roll back a checkpoint's earlier delete request
      tx.abort();
      reject(error);
    }
  });
}

function replicaRange(name: string, through = Number.MAX_SAFE_INTEGER): IDBKeyRange {
  return IDBKeyRange.bound([name, 0], [name, through]);
}

function write(database: IDBDatabase, entry: ReplicaEntry): Promise<IDBValidKey> {
  return transact(database, "readwrite", store => {
    if (entry.checkpoint) store.delete(replicaRange(entry.name, entry.generation));
    return entry.checkpoint ? store.put(entry) : store.add(entry);
  });
}

async function requestPersistence(storage: BrowserLocalStorePorts["storage"]): Promise<boolean> {
  try { return await storage?.persist() ?? false; } catch { return false; }
}

async function attachSession(
  database: IDBDatabase, name: string, options: NativeSessionOptions,
  release: () => Promise<void>, storage: BrowserLocalStorePorts["storage"]
): Promise<NativeLocalStoreOpen> {
  let stopped: NativeLocalStoreFailure | undefined;
  function stop(reason: "closed" | "version"): void {
    stopped = { kind: "failed", reason };
    database.close();
  }
  database.onversionchange = () => stop("version");
  database.onclose = () => stop("closed");
  const entries = await transact(database, "readonly", store => store.getAll(replicaRange(name))).catch(error => {
    if (!stopped) throw error;
    return [];
  }) as ReplicaEntry[];
  if (stopped) return stopped;

  const session = openNativeSession({ kind: "empty" }, options);
  const doc = session.ydoc;
  try {
    Y.transact(doc, () => {
      for (const entry of entries) {
        if (!(entry?.bytes instanceof Uint8Array)) throw new TypeError("Invalid replica bytes");
        Y.applyUpdate(doc, entry.bytes);
      }
    });
  } catch (error) {
    session.close();
    throw error;
  }
  return attachWrites(database, name, session, entries, release, storage, stop, () => stopped);
}

function attachWrites(
  database: IDBDatabase, name: string, session: ReturnType<typeof openNativeSession>, entries: readonly ReplicaEntry[],
  release: () => Promise<void>, storage: BrowserLocalStorePorts["storage"], stop: (reason: "closed" | "version") => void,
  stopped: () => NativeLocalStoreFailure | undefined
): NativeLocalStoreOpen {
  const doc = session.ydoc, guardSharedCallback = nativeCallbackGuard(doc);
  const listeners = new Set<(receipt: NativeLocalStoreReceipt) => void>();
  const closed = deferred<NativeLocalStoreClose>();
  const pending: ReplicaEntry[] = [];
  const generation = entries.at(-1)?.generation ?? 0;
  let committed = generation, next = generation;
  let checkpoint = entries[0]?.checkpoint ? entries[0].generation : 0;
  let active: Promise<NativeLocalStoreReceipt> | undefined;
  let compaction: Promise<void> | undefined;

  function publish(receipt: NativeLocalStoreReceipt): void {
    for (const listener of [...listeners]) {
      // why: one subscriber's error must not hide an outcome from the others
      try { listener(receipt); } catch { continue; }
    }
  }

  function current(): NativeLocalStoreReceipt {
    const loss = stopped();
    return loss ? { ...loss, generation: next, committed } : { kind: "stored", generation: committed };
  }

  function scheduleCompaction(): void {
    if (compaction || committed - checkpoint < CHECKPOINT_EVERY || session.isClosingOrClosed()) return;
    compaction = new Promise<void>(resolve => { setTimeout(resolve, 0); }).then(async () => {
      // why: a live checkpoint can cover exactly the committed prefix only when the update queue is empty
      if (pending.length || session.isClosingOrClosed()) return;
      const through = committed;
      try {
        await write(database, { name, generation: through, bytes: session.encodeState(), checkpoint: true });
        checkpoint = through;
      } catch (error) {
        publish({ ...failure(error), generation: through, committed, operation: "compact" });
      }
    }).finally(() => { compaction = undefined; });
  }

  async function drain(): Promise<NativeLocalStoreReceipt> {
    for (let entry = pending[0]; entry && !stopped(); entry = pending[0]) {
      try { await write(database, entry); }
      catch (error) {
        const result = { ...failure(error), generation: entry.generation, committed };
        // why: a failure listener can call flush to retry once the failed transaction has settled
        active = undefined;
        publish(result);
        return result;
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
    pending.push({ name, generation: ++next, bytes, checkpoint: false });
    void flush();
  }

  async function finish(state: Uint8Array): Promise<void> {
    const inProgress = active;
    let result = await flush();
    if (inProgress && result.kind === "failed" && !stopped()) result = await flush();
    await compaction;
    database.close();
    await release();
    if (stopped()) {
      result = current();
      publish(result);
    }
    listeners.clear();
    closed.resolve({ ...result, state });
  }

  const updated = (bytes: Uint8Array) => guardSharedCallback(() => saveUpdate(bytes));
  doc.on("update", updated);
  session.subscribe(change => {
    if (change.kind === "closed") {
      const state = new Uint8Array(change.state);
      doc.off("update", updated);
      if (!stopped() && change.reason === "failed") pending.push({ name, generation: ++next, bytes: state, checkpoint: true });
      void finish(state);
    }
  });

  function disconnect(reason: "closed" | "version"): void {
    stop(reason);
    doc.off("update", updated);
    session.close();
  }
  database.onversionchange = () => disconnect("version");
  database.onclose = () => disconnect("closed");

  return {
    kind: "opened", restored: entries.length > 0, generation, session, persistent: requestPersistence(storage),
    flush: () => session.isClosingOrClosed() ? closed.promise : flush(),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    closed: closed.promise
  };
}

export function createBrowserNativeLocalStore(ports: BrowserLocalStorePorts = {
  indexedDB: globalThis.indexedDB, locks: globalThis.navigator?.locks, storage: globalThis.navigator?.storage
}): NativeLocalStore {
  const { indexedDB, locks, storage } = ports;
  async function useDatabase<T extends NativeLocalStoreOpen | { readonly kind: "stored" }>(
    name: string, use: (database: IDBDatabase, release: () => Promise<void>) => Promise<T>
  ): Promise<T | NativeLocalStoreFailure> {
    if (!indexedDB || !locks) return { kind: "failed", reason: "unavailable" };
    try {
      const release = await acquire(locks, name);
      if (!release) return { kind: "failed", reason: "locked" };
      let database: IDBDatabase | undefined, handedOff = false;
      try {
        const result = await openDatabase(indexedDB);
        if ("kind" in result) return result;
        database = result;
        const outcome = await use(database, release);
        handedOff = outcome.kind === "opened";
        return outcome;
      } finally {
        if (!handedOff) { database?.close(); await release(); }
      }
    } catch (error) { return failure(error); }
  }

  return {
    open: (name, options) => useDatabase(name, (database, release) => attachSession(database, name, options, release, storage)),
    delete: name => useDatabase(name, async database => {
      await transact(database, "readwrite", store => store.delete(replicaRange(name)));
      return { kind: "stored" } as const;
    })
  };
}
