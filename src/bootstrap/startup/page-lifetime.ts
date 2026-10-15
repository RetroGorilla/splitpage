export const SERVICE_WORKER_URL = "sw.js";

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
  win.addEventListener("beforeunload", onBeforeUnload);
  return () => win.removeEventListener("beforeunload", onBeforeUnload);
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
