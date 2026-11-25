import { sharedVersionHttp } from "../../adapters/collab/native/version-http.ts";
import { openNativeSession } from "../../adapters/collab/native/session.ts";
import { startSharedPictures } from "../../adapters/collab/native/shared-pictures.ts";
import { sharedPictureHttp } from "../../adapters/collab/native/picture-http.ts";
import { blobStore, repaintSharedPictures } from "../../adapters/storage/02c-blobs.ts";
import { buildSplitpageFile, fileImagesMissing } from "../../adapters/formats/project-file.ts";
import { mintDocId } from "../../adapters/identity/ids.ts";
import { slugify } from "../../../shared/text.ts";
import type { SharedHistorySource } from "../../features/history/ports.ts";
import { sanitizeHtml } from "../richtext.ts";
import { exportDocumentOf } from "./export-capture.ts";
import { fileDelivery } from "./ports/files.ts";

let currentHistory: SharedHistorySource | null = null;
export const retainedSharedHistory = () => currentHistory;
export function activateSharedHistory(history: SharedHistorySource): () => void {
  currentHistory = history;
  return () => { if (currentHistory === history) currentHistory = null; };
}

export function createSharedHistory(origin: string, script: string, lifetime: AbortSignal,
  token: () => string, online: SharedHistorySource["online"], putBack: SharedHistorySource["putBack"]): SharedHistorySource {
  function connection(signal: AbortSignal) {
    const active = AbortSignal.any([signal, lifetime]);
    active.throwIfAborted();
    if (!online()) throw new Error("Version history needs a connection.");
    return active;
  }

  return {
    online,
    putBack: beat => online() && putBack(beat),
    list: signal => sharedVersionHttp(origin, script, token()).list(connection(signal)),
    async read(id, signal) {
      const active = connection(signal);
      const bytes = await sharedVersionHttp(origin, script, token()).read(id, active);
      active.throwIfAborted();
      const session = openNativeSession({ kind: "stored-script", state: bytes }, { actor: "History", sanitize: sanitizeHtml });
      try {
        if (!session.isStoredScript()) throw new Error("Invalid shared version.");
        const state = session.document();
        const outline = session.historyOutline();
        const hashes = session.pictureReferences().required;
        async function loadPictures(signal: AbortSignal) {
          const active = connection(signal);
          const pictures = startSharedPictures(sharedPictureHttp(origin, script, token()), blobStore, () => {},
            undefined, repaintSharedPictures);
          active.addEventListener("abort", pictures.stop, { once: true });
          try {
            await pictures.prepareExport(hashes);
            active.throwIfAborted();
            repaintSharedPictures();
          } finally {
            active.removeEventListener("abort", pictures.stop);
            pictures.stop();
          }
        }
        return {
          title: state.title, outline, loadPictures,
          async saveCopy(signal) {
            const doc = exportDocumentOf(state, { docId: mintDocId() });
            if (fileImagesMissing(doc).length) await loadPictures(signal);
            connection(signal);
            if (fileImagesMissing(doc).length) throw new Error("Version pictures are unavailable.");
            return fileDelivery.deliver(slugify(state.title) + ".splitpage", buildSplitpageFile(doc), { savedMsg: "Saved a separate copy" });
          }
        };
      } finally { session.close(); }
    }
  };
}
