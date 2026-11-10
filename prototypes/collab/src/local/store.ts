import * as Y from "yjs";

export interface LocalReplicaScope {
  deployment: string;
  instance: string;
}

export interface LocalReplicaCapture {
  editor: Uint8Array;
  network: Uint8Array;
  sequence: number;
  manifest: string[];
  blobs: { hash: string; bytes: Uint8Array }[];
}

export function localReplicaKey(scope: LocalReplicaScope): string {
  return JSON.stringify([scope.deployment, scope.instance]);
}

export function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new DOMException("Transaction aborted", "AbortError")), { once: true });
  });
}

export function idbResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class LocalReplicaStore {
  readonly database: IDBDatabase;
  private active = true;
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(database: IDBDatabase, invalidate: () => void) {
    this.database = database;
    database.onversionchange = () => {
      this.active = false;
      database.close();
      invalidate();
    };
  }

  static async open(scope: LocalReplicaScope, invalidate: () => void): Promise<LocalReplicaStore> {
    const request = indexedDB.open(`local-replica:${localReplicaKey(scope)}`, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("replicas");
      request.result.createObjectStore("blobs");
    };
    return new LocalReplicaStore(await idbResult(request), invalidate);
  }

  async hydrate(): Promise<LocalReplicaCapture | null> {
    const transaction = this.database.transaction(["replicas", "blobs"], "readonly");
    const done = transactionComplete(transaction);
    const store = transaction.objectStore("replicas");
    const editor = idbResult(store.get("editor") as IDBRequest<Uint8Array | undefined>);
    const network = idbResult(store.get("network") as IDBRequest<Uint8Array | undefined>);
    const metadata = idbResult(store.get("metadata") as IDBRequest<{ sequence: number; manifest: string[] } | undefined>);
    const keys = idbResult(transaction.objectStore("blobs").getAllKeys());
    await done;
    const [e, n, meta, hashes] = await Promise.all([editor, network, metadata, keys]);
    if (!e && !n && !meta) return null;
    if (!e || !n || !meta || meta.manifest.some(hash => !hashes.includes(hash))) throw new Error("Incomplete local replica");
    return { editor: e, network: n, ...meta, blobs: [] };
  }

  save(editor: Y.Doc, network: Y.Doc, sequence: number, manifest: readonly string[], blobs: ReadonlyMap<string, Uint8Array>, owns: () => boolean): Promise<number> {
    const captured: LocalReplicaCapture = {
      editor: Y.encodeStateAsUpdate(editor), network: Y.encodeStateAsUpdate(network), sequence,
      manifest: [...manifest], blobs: [...blobs].map(([hash, bytes]) => ({ hash, bytes: bytes.slice() }))
    };
    const write = this.tail.then(async () => {
      if (!this.active || !owns()) throw new Error("Writable ownership ended");
      const transaction = this.database.transaction(["replicas", "blobs"], "readwrite", { durability: "strict" });
      const done = transactionComplete(transaction);
      const assets = transaction.objectStore("blobs");
      for (const blob of captured.blobs) assets.put(blob.bytes, blob.hash);
      for (const hash of captured.manifest) {
        const request = assets.getKey(hash);
        request.onsuccess = () => { if (request.result === undefined) transaction.abort(); };
      }
      const replicas = transaction.objectStore("replicas");
      replicas.put(captured.editor, "editor");
      replicas.put(captured.network, "network");
      replicas.put({ sequence: captured.sequence, manifest: captured.manifest }, "metadata");
      await done;
      return captured.sequence;
    });
    this.tail = write.catch(() => undefined);
    return write;
  }

  close(): void { this.active = false; this.database.close(); }
}
