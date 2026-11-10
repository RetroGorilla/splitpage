import * as Y from "yjs";
import { IndexeddbPersistence, storeState } from "y-indexeddb";
import { LocalReplicaStore, idbResult, localReplicaKey, transactionComplete } from "../../src/local/store.ts";
import type { LocalReplicaScope } from "../../src/local/store.ts";
import { LocalWritableTab } from "../../src/local/ownership.ts";
import { probeTransactions } from "./faults.ts";
import type { LocalTransactionProbe } from "./faults.ts";
import { probeLocalStartup } from "./startup.ts";

let editor = new Y.Doc();
let network = new Y.Doc();
let owner = new LocalWritableTab();
let store: LocalReplicaStore | null = null;
let library: IndexeddbPersistence | null = null;
let scope: LocalReplicaScope = { deployment: "fixture", instance: "none" };
let sequence = 0;
let saved: number[] = [];
const statusElement = document.createElement("p");
statusElement.id = "local-status";
statusElement.setAttribute("role", "status");
statusElement.textContent = "Read-only";
const explanationElement = document.createElement("p");
explanationElement.id = "local-explanation";
document.body.append(statusElement, explanationElement);
let errors: string[] = [];
let probe: LocalTransactionProbe | null = null;
let pending: Promise<unknown> = Promise.resolve();
let manifest: string[] = [];
let atomicGap: Promise<void> = Promise.resolve();
let readBlock: LocalReplicaStore | null = null;
let hydrationEntry: Promise<string> | null = null;
const blobs = new Map<string, Uint8Array>();

function setStatus(value: string): void { statusElement.textContent = value; }

addEventListener("unhandledrejection", event => { errors.push(String(event.reason)); event.preventDefault(); });

function snapshot(includeBytes = true): unknown {
  return {
    writable: owner.owns(), explanation: explanationElement.textContent, status: statusElement.textContent, sequence, saved: [...saved], errors: [...errors],
    editor: includeBytes ? [...Y.encodeStateAsUpdate(editor)] : [], network: includeBytes ? [...Y.encodeStateAsUpdate(network)] : [], manifest: [...manifest],
    probe: probe ? { opened: probe.opened, completed: probe.completed, aborted: probe.aborted, durability: probe.durability, errors: probe.errors } : null,
    synced: library?.synced ?? null, largeSize: (editor.getMap("large").get("bytes") as Uint8Array | undefined)?.length ?? 0
  };
}

async function close(): Promise<void> {
  probe?.release();
  probe?.restore();
  probe = null;
  await pending;
  store?.close();
  store = null;
  await library?.destroy();
  library = null;
  await owner.dispose();
  editor.destroy();
  network.destroy();
}

async function open(next: LocalReplicaScope, candidate: "minimal" | "library", wait = false, earlyEditing = false): Promise<unknown> {
  await close();
  owner = new LocalWritableTab();
  editor = new Y.Doc();
  network = new Y.Doc();
  scope = next;
  saved = [];
  errors = [];
  manifest = [];
  blobs.clear();
  sequence = 0;
  setStatus("Hydrating");
  explanationElement.textContent = "";
  const writable = await owner.acquire(scope, async () => {
    if (earlyEditing) owner.owns = () => true;
    dispatchEvent(new CustomEvent("local-hydration-entry", { detail: localReplicaKey(scope) }));
    if (candidate === "minimal") {
      store = await LocalReplicaStore.open(scope, () => { setStatus("Could not save on this device"); void owner.dispose(); });
      const capture = await store.hydrate();
      if (capture) {
        Y.applyUpdate(editor, capture.editor);
        Y.applyUpdate(network, capture.network);
        sequence = capture.sequence;
        manifest = capture.manifest;
      }
    } else {
      library = new IndexeddbPersistence(`library:${localReplicaKey(scope)}`, editor);
      await library.whenSynced;
    }
  }, wait);
  setStatus(writable ? "Ready" : "Read-only");
  explanationElement.textContent = writable ? "" : owner.explanation;
  return snapshot();
}

function apply(update: number[], nextSequence: number, bypassLock = false): void {
  if (!bypassLock && !owner.owns()) throw new Error("Read-only: another tab owns this instance");
  Y.applyUpdate(editor, Uint8Array.from(update));
  Y.applyUpdate(network, Uint8Array.from(update));
  sequence = nextSequence;
  setStatus("Saving on this device");
}

function save(premature = false): void {
  if (!store) throw new Error("No completion-aware store");
  const capturedSequence = sequence;
  const write = store.save(editor, network, sequence, manifest, blobs, () => owner.owns());
  if (premature) { saved.push(capturedSequence); setStatus("Saved on this device"); }
  pending = write.then(coverage => {
    if (!premature) saved.push(coverage);
    setStatus(coverage === sequence ? "Saved on this device" : "Saving on this device");
  }, error => { setStatus("Could not save on this device"); errors.push(String(error)); });
}

function gate(hold: boolean, abort = false): void {
  probe?.restore();
  probe = probeTransactions(`${store ? "local-replica" : "library"}:${localReplicaKey(scope)}`, hold, abort);
}

async function upgrade(name: string): Promise<number> {
  const request = indexedDB.open(name, 2);
  const db = await idbResult(request);
  const version = db.version;
  db.close();
  return version;
}

async function libraryFence(): Promise<number> {
  if (!library?.db) throw new Error("Library database not open");
  const transaction = library.db.transaction("updates", "readonly");
  const done = transactionComplete(transaction);
  const result = idbResult(transaction.objectStore("updates").count());
  await done;
  return result;
}

async function librarySet(): Promise<unknown> {
  if (!library) throw new Error("Library not open");
  await library.set("receipt", 1);
  return snapshot();
}

async function splitWrite(part: "network" | "editor" | "metadata"): Promise<void> {
  if (!store) throw new Error("Store not open");
  const tx = store.database.transaction("replicas", "readwrite", { durability: "strict" });
  const done = transactionComplete(tx);
  const records = tx.objectStore("replicas");
  records.put(part === "metadata" ? { sequence, manifest } : Y.encodeStateAsUpdate(part === "editor" ? editor : network), part);
  await done;
}

function beginAtomicGap(): void {
  if (!store) throw new Error("Store not open");
  const tx = store.database.transaction(["replicas", "blobs"], "readwrite", { durability: "strict" });
  pending = transactionComplete(tx).catch(error => { errors.push(String(error)); });
  const records = tx.objectStore("replicas");
  atomicGap = idbResult(records.put(Y.encodeStateAsUpdate(network), "network")).then(() => undefined);
}

const api = {
  probeLocalStartup,
  open, close, snapshot, apply, save, gate, upgrade, libraryFence, librarySet, splitWrite, beginAtomicGap,
  metadata: () => snapshot(false),
  expectHydrationEntry: () => {
    hydrationEntry = new Promise<string>(resolve => {
      addEventListener("local-hydration-entry", event => { resolve((event as CustomEvent<string>).detail); }, { once: true });
    });
  },
  hydrationEntered: async () => { if (!hydrationEntry) throw new Error("Hydration entry was not armed"); return hydrationEntry; },
  libraryInitial: async (next: LocalReplicaScope, update: number[]) => {
    await close(); scope = next; editor = new Y.Doc(); network = new Y.Doc();
    Y.applyUpdate(editor, Uint8Array.from(update));
    probe = probeTransactions(`library:${localReplicaKey(scope)}`, true);
    library = new IndexeddbPersistence(`library:${localReplicaKey(scope)}`, editor);
    await library.whenSynced;
    return snapshot();
  },
  blockHydration: async (next: LocalReplicaScope) => {
    await close(); scope = next;
    readBlock = await LocalReplicaStore.open(scope, () => undefined);
    probe = probeTransactions(`local-replica:${localReplicaKey(scope)}`, true);
    const tx = readBlock.database.transaction("replicas", "readwrite");
    tx.objectStore("replicas").get("metadata");
    await probe.held;
  },
  unblockHydration: () => { probe?.release(); readBlock?.close(); readBlock = null; },
  applyNetwork: (update: number[]) => { Y.applyUpdate(network, Uint8Array.from(update)); },
  unsafeWrite: async (update: number[], nextSequence: number) => {
    apply(update, nextSequence, true);
    const unsafeStore = await LocalReplicaStore.open(scope, () => undefined);
    try { await unsafeStore.save(editor, network, sequence, [], new Map(), () => true); }
    finally { unsafeStore.close(); }
  },
  atomicGap: async () => { await atomicGap; return snapshot(); },
  held: async () => { if (!probe) throw new Error("No transaction gate"); await probe.held; return snapshot(); },
  release: () => { probe?.release(); },
  settled: async () => { await pending; return snapshot(); },
  compact: async () => { if (!library) throw new Error("Library not open"); await storeState(library); },
  libraryGet: async (): Promise<unknown> => { if (!library) throw new Error("Library not open"); return library.get("receipt") as Promise<unknown>; },
  libraryLargeUpdate: () => { const bytes = new Uint8Array(16 * 1024 * 1024); for (let offset = 0; offset < bytes.length; offset += 65536) crypto.getRandomValues(bytes.subarray(offset, offset + 65536)); editor.getMap("large").set("bytes", bytes); },
  asset: (hash: string, values: number[]) => { manifest.push(hash); blobs.set(hash, Uint8Array.from(values)); },
  missingAsset: (hash: string) => { manifest.push(hash); },
  mutateAsset: (hash: string) => { manifest.push("later"); blobs.get(hash)?.fill(9); },
  largeAsset: (size: number) => { const bytes = new Uint8Array(size); for (let offset = 0; offset < size; offset += 65536) crypto.getRandomValues(bytes.subarray(offset, offset + 65536)); manifest.push("quota"); blobs.set("quota", bytes); },
  readAsset: async (hash: string) => {
    if (!store) throw new Error("Store not open");
    const tx = store.database.transaction("blobs", "readonly");
    const done = transactionComplete(tx);
    const bytes = await idbResult(tx.objectStore("blobs").get(hash) as IDBRequest<Uint8Array | undefined>);
    await done;
    return bytes ? [...bytes] : null;
  },
  credential: async () => {
    const request = indexedDB.open("local-credential-fixture", 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("credentials"); };
    const db = await idbResult(request);
    const tx = db.transaction("credentials", "readwrite");
    const done = transactionComplete(tx);
    tx.objectStore("credentials").put("credential-only-sentinel", "token");
    await done; db.close();
  },
  persist: async (request: boolean) => ({ granted: request ? await navigator.storage.persist() : await navigator.storage.persisted(), estimate: await navigator.storage.estimate() }),
  listDatabases: async () => indexedDB.databases()
};

Object.assign(window, { localExperiment: api });
