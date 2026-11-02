import type { LocalFileReference } from "../../application/files/local-file-access.ts";
import { runningOnDesktop } from "../desktop/desktop-port.ts";

const LAST_FILE_DB = "splitpage-files", LAST_FILE_STORE = "handles", LAST_FILE_KEY = "last";

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>(function (resolve, reject) {
    if (!("indexedDB" in window)) { reject(new Error("no-indexeddb")); return; }
    const req = indexedDB.open(LAST_FILE_DB, 1);
    req.onupgradeneeded = function () { req.result.createObjectStore(LAST_FILE_STORE); };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

export async function rememberLastFileHandle(handle: unknown) {
  if (!handle) return;
  if (runningOnDesktop()) return;
  try {
    const db = await openHandleDb();
    await new Promise<void>(function (resolve, reject) {
      const tx = db.transaction(LAST_FILE_STORE, "readwrite");
      tx.objectStore(LAST_FILE_STORE).put(handle, LAST_FILE_KEY);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  } catch (e) { }
}

export async function loadLastFileHandle() {
  try {
    const db = await openHandleDb();
    return await new Promise<LocalFileReference | null>(function (resolve, reject) {
      const req: IDBRequest<LocalFileReference | null> = db.transaction(LAST_FILE_STORE, "readonly").objectStore(LAST_FILE_STORE).get(LAST_FILE_KEY);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { reject(req.error); };
    });
  } catch (e) { return null; }
}

