import type { NativeLocalStore, NativeLocalStoreFailure, NativeLocalStoreOpen, NativeLocalStoreReceipt } from "./local-store.ts";
import { openNativeSession } from "./session.ts";
import type { NativeSessionOptions } from "./session.ts";

const DATABASE = "splitpage-native-replicas";
const REPLICAS = "replicas";
const STORED = Object.freeze({ kind: "stored" });

interface BrowserLocalStorePorts {
  readonly indexedDB?: IDBFactory;
  readonly locks?: Pick<LockManager, "request">;
  readonly storage?: Pick<StorageManager, "persist">;
}

function deferred<T>() {
  let resolve!: (result: T) => void;
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
    const hold = deferred<void>();
    const released = locks.request(`${DATABASE}:${name}`, { ifAvailable: true }, lock => {
      resolve(lock ? async () => { hold.resolve(); await released; } : null);
      return lock ? hold.promise : undefined;
    });
    void released.catch(reject);
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase | NativeLocalStoreFailure> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, 1);
    let blocked = false;
    request.onblocked = () => {
      blocked = true;
      resolve({ kind: "failed", reason: "blocked" });
    };
    request.onupgradeneeded = () => {
      // why: after reporting a blocked open, the queued upgrade must not change the database later
      if (blocked) request.transaction!.abort();
      else request.result.createObjectStore(REPLICAS);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function readState(database: IDBDatabase, name: string): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(REPLICAS);
    const request = transaction.objectStore(REPLICAS).get(name);
    transaction.oncomplete = () => {
      const state: unknown = request.result;
      if (state === undefined || state instanceof Uint8Array) resolve(state);
      else reject(new TypeError("Invalid replica bytes"));
    };
    transaction.onabort = () => reject(transaction.error);
  });
}

function writeState(database: IDBDatabase, name: string, state?: Uint8Array): Promise<NativeLocalStoreReceipt> {
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(REPLICAS, "readwrite", { durability: "strict" });
    const replicas = transaction.objectStore(REPLICAS);
    const request = state === undefined ? replicas.delete(name) : replicas.put(state, name);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? request.error);
  }).then(() => STORED, failure);
}

async function requestPersistence(storage: BrowserLocalStorePorts["storage"]): Promise<boolean> {
  try { return await storage?.persist() ?? false; } catch { return false; }
}

async function attachSession(
  database: IDBDatabase, name: string, options: NativeSessionOptions,
  release: () => Promise<void>, storage: BrowserLocalStorePorts["storage"]
): Promise<NativeLocalStoreOpen> {
  let stopped: NativeLocalStoreFailure | undefined;
  let disconnect: (() => void) | undefined;

  function stop(reason: "closed" | "version"): void {
    stopped = { kind: "failed", reason };
    database.close();
    disconnect?.();
  }

  database.onversionchange = () => stop("version");
  database.onclose = () => stop("closed");
  const state = await readState(database, name).catch(error => {
    if (!stopped) throw error;
    return undefined;
  });
  if (stopped) { await release(); return stopped; }

  const session = openNativeSession(state === undefined ? { kind: "empty" } : { kind: "state", state }, options);
  const listeners = new Set<(receipt: NativeLocalStoreReceipt) => void>();
  const ending = deferred<void>();
  let latest: Promise<NativeLocalStoreReceipt> = Promise.resolve(STORED);
  let queued = false;
  let finalState: Uint8Array | undefined;

  function publish(result: NativeLocalStoreReceipt): void {
    for (const listener of [...listeners]) {
      // why: one subscriber's error must not change a receipt or hide it from other subscribers
      try { listener(result); } catch { continue; }
    }
  }

  async function saveSnapshot(): Promise<NativeLocalStoreReceipt> {
    try { return await writeState(database, name, finalState ?? session.encodeState()); }
    catch (error) { return failure(error); }
  }

  function save(): void {
    if (queued) return;
    queued = true;
    latest = latest.then(async () => {
      queued = false;
      if (stopped) return stopped;
      const result = await saveSnapshot();
      if (result.kind === "failed" || !queued) publish(result);
      return result;
    });
  }

  const closed = ending.promise.then(async () => {
    const result = await latest;
    database.close();
    await release();
    if (stopped) publish(stopped);
    listeners.clear();
    return stopped ?? result;
  });

  const unsubscribe = session.subscribe(change => {
    if (change.kind === "changed") save();
    else {
      finalState = change.state;
      if (change.reason === "failed") save();
      ending.resolve();
    }
  });

  disconnect = () => {
    unsubscribe();
    ending.resolve();
  };

  return {
    kind: "opened", restored: state !== undefined, session, persistent: requestPersistence(storage),
    // why: the session announces a command's changes in a microtask before a same-turn flush reads the queue
    flush: async () => { await Promise.resolve(); return stopped ?? latest; },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    closed
  };
}

export function createBrowserNativeLocalStore(ports: BrowserLocalStorePorts = {
  indexedDB: globalThis.indexedDB, locks: globalThis.navigator?.locks, storage: globalThis.navigator?.storage
}): NativeLocalStore {
  const { indexedDB, locks, storage } = ports;
  async function useDatabase<T>(name: string, use: (database: IDBDatabase, release: () => Promise<void>) => Promise<T>) {
    if (!indexedDB || !locks) return { kind: "failed", reason: "unavailable" } as const;
    try {
      const release = await acquire(locks, name);
      if (!release) return { kind: "failed", reason: "locked" } as const;
      try {
        const database = await openDatabase(indexedDB);
        if (!("kind" in database)) {
          try { return await use(database, release); }
          catch (error) { database.close(); throw error; }
        }
        await release();
        return database;
      } catch (error) { await release(); throw error; }
    } catch (error) { return failure(error); }
  }

  return {
    open: (name, options) => useDatabase(name, (database, release) => attachSession(database, name, options, release, storage)),
    delete: name => useDatabase(name, async (database, release) => {
      try { return await writeState(database, name); }
      finally { database.close(); await release(); }
    })
  };
}
