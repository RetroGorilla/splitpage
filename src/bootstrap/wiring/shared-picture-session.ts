import { sharedPictureHttp } from "../../adapters/collab/native/picture-http.ts";
import { startSharedPictures } from "../../adapters/collab/native/shared-pictures.ts";
import { blobStore, repaintSharedPictures, showSharedPicturePending } from "../../adapters/storage/02c-blobs.ts";
import type { NativeLocalStoreOpen } from "../../adapters/collab/native/local-store.ts";

type Copy = Pick<Extract<NativeLocalStoreOpen, { kind: "opened" }>, "session"> &
  Partial<Pick<Extract<NativeLocalStoreOpen, { kind: "opened" }>, "flush">>;
let loadPictures: ((hashes: readonly string[]) => Promise<void>) | undefined;

export function loadSharedExportPictures(hashes: readonly string[]) {
  return loadPictures?.(hashes);
}

export function bindSharedPictures(copy: Copy, origin: string, script: string, token: string, cancel?: AbortSignal) {
  const session = copy.session;
  let required: readonly string[] = [];
  let changed: (() => void) | undefined;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const pictures = startSharedPictures(sharedPictureHttp(origin, script, token), blobStore, () => {
    if (typeof document !== "undefined") repaintSharedPictures();
    changed?.();
  });

  function scan() {
    clearTimeout(scheduled);
    scheduled = undefined;
    const references = session.pictureReferences();
    required = references.required;
    pictures.track(references.tracked);
    changed?.();
  }

  const unsubscribe = session.subscribe(event => {
    if (event.kind === "closed") stop();
    if (event.kind === "changed" && scheduled === undefined) scheduled = setTimeout(scan, 100);
  });
  let hidePending: (() => void) | undefined;
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(scheduled);
    unsubscribe();
    hidePending?.();
    pictures.stop();
    cancel?.removeEventListener("abort", stop);
    if (loadPictures === pictures.prepareExport) loadPictures = undefined;
    changed?.();
  }
  cancel?.addEventListener("abort", stop, { once: true });
  if (cancel?.aborted) stop();
  else scan();

  return {
    reconnect: pictures.reconnect,
    stop,
    finishPreparation() { cancel?.removeEventListener("abort", stop); },
    activate() {
      if (stopped) return;
      hidePending ??= showSharedPicturePending(() => true);
      loadPictures = pictures.prepareExport;
    },
    async hydrate() {
      while (!stopped && !pictures.refused()) {
        scan();
        if (pictures.rejected(required) || pictures.storageFailed(required)) return false;
        if (!pictures.ready(required)) {
          await new Promise<void>(resolve => { changed = resolve; });
          changed = undefined;
          continue;
        }
        const revision = session.revision();
        if (copy.flush) {
          if ((await copy.flush()).kind !== "stored") return false;
        }
        if (stopped || pictures.refused()) return false;
        if (revision === session.revision()) return true;
      }
      return false;
    }
  };
}
