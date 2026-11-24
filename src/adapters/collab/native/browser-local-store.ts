import type { NativeReplicaEntry } from "../../../../shared/native-replica.d.ts";
import { attachNativeLocalStore, nativeLocalStoreFailure } from "./local-store.ts";
import type { NativeLocalStore, NativeLocalStoreFailure, NativeLocalStoreOpen, NativeReplicaConnection } from "./local-store.ts";

const DATABASE = "splitpage-native-replica-log";
const DATABASE_VERSION = 3;
const REPLICAS = "replicas";
const MEMBERSHIPS = "memberships";
const INVITATIONS = "invitations";
const JOURNALS = "journals";
const OPEN_TIMEOUT_MS = 2000;
interface BrowserLocalStorePorts {
  readonly indexedDB?: IDBFactory;
  readonly locks?: Pick<LockManager, "request">;
  readonly storage?: Pick<StorageManager, "persist">;
}

interface ReplicaEntry extends NativeReplicaEntry {
  readonly name: string;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
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
    const request = factory.open(DATABASE, DATABASE_VERSION);
    let refused = false;
    // why: an open queued behind another connection's blocked upgrade or delete gets no blocked event of its own
    const timer = setTimeout(refuse, OPEN_TIMEOUT_MS);
    function refuse(): void {
      refused = true;
      clearTimeout(timer);
      resolve({ kind: "failed", reason: "blocked" });
    }
    request.onblocked = refuse;
    request.onupgradeneeded = event => {
      if (refused) { request.transaction?.abort(); return; }
      if (event.oldVersion < 1) request.result.createObjectStore(REPLICAS, { keyPath: ["name", "generation"] });
      if (event.oldVersion < 2) {
        request.result.createObjectStore(MEMBERSHIPS);
        request.result.createObjectStore(INVITATIONS);
      }
      if (event.oldVersion < 3) request.result.createObjectStore(JOURNALS);
    };
    request.onerror = () => { clearTimeout(timer); reject(request.error); };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (refused) request.result.close();
      else resolve(request.result);
    };
  });
}

function transaction<T>(database: IDBDatabase, stores: string[], mode: "readonly" | "readwrite", run: (tx: IDBTransaction) => IDBRequest<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const tx = database.transaction(stores, mode, { durability: "strict" });
    const cancel = () => {
      try { tx.abort(); } catch (error) {
        if (!(error instanceof DOMException && error.name === "InvalidStateError")) throw error;
      }
    };
    const settled = () => { signal?.removeEventListener("abort", cancel); };
    try {
      const request = run(tx);
      tx.oncomplete = () => { settled(); resolve(request.result); };
      tx.onabort = () => { settled(); reject(tx.error ?? request.error); };
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    } catch (error) {
      // why: a synchronous put failure must roll back a checkpoint's earlier delete request
      tx.abort();
      reject(error);
    }
  });
}

function transact<T>(database: IDBDatabase, mode: "readonly" | "readwrite", run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return transaction(database, [REPLICAS], mode, tx => run(tx.objectStore(REPLICAS)));
}

function replicaRange(name: string, through = Number.MAX_SAFE_INTEGER): IDBKeyRange {
  return IDBKeyRange.bound([name, 0], [name, through]);
}

function write(database: IDBDatabase, entry: ReplicaEntry): Promise<IDBValidKey> {
  const { journal, ...storedEntry } = entry;
  if (journal) {
    return transaction(database, [REPLICAS, JOURNALS], "readwrite", tx => {
      const store = tx.objectStore(REPLICAS);
      if (storedEntry.checkpoint) store.delete(replicaRange(storedEntry.name, storedEntry.generation));
      tx.objectStore(JOURNALS).put(journal, storedEntry.name);
      return storedEntry.checkpoint ? store.put(storedEntry) : store.add(storedEntry);
    });
  }
  return transact(database, "readwrite", store => {
    if (storedEntry.checkpoint) store.delete(replicaRange(storedEntry.name, storedEntry.generation));
    return storedEntry.checkpoint ? store.put(storedEntry) : store.add(storedEntry);
  });
}

async function read(database: IDBDatabase, name: string, through?: number): Promise<ReplicaEntry[]> {
  return await transact(database, "readonly", store => store.getAll(replicaRange(name, through))) as ReplicaEntry[];
}

async function readJournal(database: IDBDatabase, name: string): Promise<Uint8Array | null> {
  const value: unknown = await transaction(database, [JOURNALS], "readonly", tx => tx.objectStore(JOURNALS).get(name));
  if (value === undefined) return null;
  if (value instanceof Uint8Array) return value;
  throw new TypeError("Invalid pending edits journal");
}

function writeJournal(database: IDBDatabase, name: string, bytes: Uint8Array): Promise<IDBValidKey> {
  return transaction(database, [JOURNALS], "readwrite", tx => tx.objectStore(JOURNALS).put(bytes, name));
}

async function requestPersistence(storage: BrowserLocalStorePorts["storage"]): Promise<boolean> {
  try { return await storage?.persist() ?? false; } catch { return false; }
}

function erase(database: IDBDatabase, name: string): Promise<undefined> {
  return transaction(database, [REPLICAS, MEMBERSHIPS, INVITATIONS, JOURNALS], "readwrite", tx => {
    tx.objectStore(MEMBERSHIPS).delete(name);
    tx.objectStore(INVITATIONS).delete(name);
    tx.objectStore(JOURNALS).delete(name);
    return tx.objectStore(REPLICAS).delete(replicaRange(name));
  });
}

function connectionFor(
  database: IDBDatabase, name: string, release: () => Promise<void>, storage: BrowserLocalStorePorts["storage"]
): NativeReplicaConnection {
  let staged: Promise<undefined> | undefined;
  async function writeMembership(token: string | null, signal?: AbortSignal): Promise<void> {
    if (token === null) {
      await transaction(database, [MEMBERSHIPS, INVITATIONS], "readwrite", tx => {
        tx.objectStore(MEMBERSHIPS).delete(name);
        return tx.objectStore(INVITATIONS).delete(name);
      });
      return;
    }
    await transaction(database, [MEMBERSHIPS, INVITATIONS], "readwrite", tx => {
      tx.objectStore(MEMBERSHIPS).put(true, name);
      return tx.objectStore(INVITATIONS).put(token, name);
    }, signal);
  }
  return {
    forget: () => erase(database, name),
    membership: {
      async token() {
        let member: IDBRequest | undefined;
        const token: unknown = await transaction(database, [MEMBERSHIPS, INVITATIONS], "readonly", tx => {
          member = tx.objectStore(MEMBERSHIPS).get(name);
          return tx.objectStore(INVITATIONS).get(name);
        });
        return member?.result === true && typeof token === "string" ? token : null;
      },
      join: writeMembership,
      async stageInvitation(token, previous, signal) {
        const disposition = deferred<undefined>();
        staged = disposition.promise;
        const commit = () => { disposition.resolve(undefined); };
        try { await writeMembership(token, signal); }
        catch (error) { commit(); throw error; }
        return {
          commit,
          async rollback() {
            try { await writeMembership(previous); }
            finally { commit(); }
          }
        };
      }
    },
    read: through => read(database, name, through),
    write: async entry => { await write(database, { ...entry, name }); },
    readJournal: () => readJournal(database, name),
    writeJournal: async bytes => { await writeJournal(database, name, bytes); },
    // why: a refused entry may close the session before its membership has been restored under the writer lease
    async release() { await staged; database.close(); await release(); },
    persistent: () => requestPersistence(storage),
    onStop(stop) {
      database.onversionchange = () => { database.close(); stop("version"); };
      database.onclose = () => { database.close(); stop("closed"); };
    }
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
    } catch (error) { return nativeLocalStoreFailure(error); }
  }

  return {
    open: (name, options) => useDatabase(name, (database, release) => attachNativeLocalStore(connectionFor(database, name, release, storage), options)),
    delete: name => useDatabase(name, async database => {
      await erase(database, name);
      return { kind: "stored" } as const;
    })
  };
}
