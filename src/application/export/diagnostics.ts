import type { ExportAssetRequest, ExportAssets } from "./assets.ts";
import type { ExportDocument } from "../../core/document/export-document.ts";
import { rowSlots } from "../../core/document/gallery.ts";

export function imagesLeftOutText(count: number, name: string): string {
  return count + (count === 1 ? " image" : " images") + " could not be included in " + name +
    " — the picture" + (count === 1 ? " was" : "s were") + " not available on this computer.";
}

export function unshownCharactersText(count: number): string {
  return count + (count === 1 ? " character" : " characters") + " can't be shown in PDF";
}
export function sharedMissingPicturesText(request: ExportAssetRequest, assets: ExportAssets, doc: ExportDocument,
  pictureRefs: ((document: ExportDocument) => readonly string[]) | undefined, name: string): string {
  if (!request.shared || !pictureRefs || !assets.missing.length) return "";
  const missing = new Set(assets.missing);
  const omitted = [...new Set(pictureRefs(doc))].filter(sha => missing.has(sha));
  if (!omitted.length) return "";
  const names = new Map<string, string>();
  for (const row of doc.beats) {
    for (const { ref, name } of rowSlots(row)) if (ref && name) names.set(ref.sha256, name);
  }
  return "Pictures left out of " + name + " — " + omitted.map(sha => names.get(sha) ?? sha).join(", ");
}
