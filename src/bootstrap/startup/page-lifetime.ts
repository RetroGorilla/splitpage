export const SERVICE_WORKER_URL = "sw.js";

export async function waitDuringLifetime<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  let cancel = (): void => {};
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => { reject(new Error("The operation was cancelled.")); };
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    if (signal.aborted) cancel();
    const result = await Promise.race([work, stopped]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export function watchHistoryMigration(win: Window, snapshotKey: string, migrate: () => void): () => void {
  const onStorage = (e: StorageEvent): void => {
    if (e.key === snapshotKey && e.newValue) migrate();
  };
  win.addEventListener("storage", onStorage);
  return () => win.removeEventListener("storage", onStorage);
}

export function guardUnload(win: Window, unsaved: () => boolean): () => void {
  const onBeforeUnload = (e: BeforeUnloadEvent): void => {
    if (!unsaved()) return;
    e.preventDefault();
    e.returnValue = "";
  };
  const dispose = (): void => win.removeEventListener("beforeunload", onBeforeUnload);
  try {
    win.addEventListener("beforeunload", onBeforeUnload);
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}

export function registerServiceWorker(win: Window, desktop: boolean): () => void {
  if (desktop || !("serviceWorker" in win.navigator) || win.location.protocol === "file:") return () => {};
  const workers = win.navigator.serviceWorker;
  const onLoad = (): void => {
    workers.register(SERVICE_WORKER_URL).catch(() => {});
  };
  win.addEventListener("load", onLoad);
  return () => win.removeEventListener("load", onLoad);
}
