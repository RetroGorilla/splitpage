import type { PictureStore } from "../../../application/media/picture-store.ts";
import { blobImgHtml, bytesForSync, dataUrlForSync, ensureBytes, intern, internDataUrl, isDurableSync, persist, queuePersist, recordFor, urlForSync } from "../../../adapters/storage/02c-blobs.ts";

export const pictures: PictureStore = {
  intern,
  internDataUrl,
  recordFor,
  bytesFor: bytesForSync,
  urlFor: urlForSync,
  dataUrlFor: dataUrlForSync,
  isDurable: isDurableSync,
  queuePersist,
  persist,
  ensureBytes: (shas) => ensureBytes(shas),
  imgHtml: blobImgHtml
};
