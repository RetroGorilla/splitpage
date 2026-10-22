import type { ExportDocument } from "../../core/document/export-document.ts";
import type { ExportAssetRequest, ExportAssets, ExportAssetPorts, ExportAssetSource } from "../../application/export/assets.ts";
import type { ImageRef } from "../../core/document/ports.ts";
import { bytesForSync, dataUrlPicture, ensureBytes, recordFor } from "../storage/02c-blobs.js";
import { exportAssetRequest, heldExportAssets } from "../../application/export/assets.ts";
import { rowImage } from "../../core/document/media.ts";
import { refsIn, sniffImageMime } from "../../../shared/blob-policy.js";

export const assetPorts: ExportAssetPorts = {
  load: function (shas, source) { return ensureBytes(shas, { source: source }); },
  bytes: bytesForSync,
  mime: function (sha, bytes) {
    const rec = recordFor(sha);
    return (rec && rec.mime) || sniffImageMime(bytes) || null;
  }
};

export function exportAssetsRequest(doc: ExportDocument, source?: ExportAssetSource | null): ExportAssetRequest {
  return exportAssetRequest(refsIn(doc.document), source || null);
}

export function exportAssetsNow(doc: ExportDocument): ExportAssets {
  return heldExportAssets(exportAssetsRequest(doc, null), assetPorts);
}

export function capturedPicture(assets: ExportAssets | null | undefined, ref: ImageRef | null | undefined) {
  const held = ref && assets ? assets.picture(ref.sha256) : null;
  return held && ref ? { bytes: held.bytes, mime: ref.mime, width: ref.width, height: ref.height } : null;
}

export function capturedRowPicture(assets: ExportAssets | null | undefined, row: unknown) {
  const img = rowImage(row);
  if (!img) return null;
  return img.ref ? capturedPicture(assets, img.ref) : dataUrlPicture(img.dataUrl);
}
