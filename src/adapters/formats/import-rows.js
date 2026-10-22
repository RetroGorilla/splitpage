import { MD_IMAGE_PREFIX_RE } from "./markdown-image.ts";
import { audioDirectionsHtml } from "./docx.ts";
import { internDataUrl, queuePersist } from "../storage/02c-blobs.js";
import { makeId } from "../identity/ids.ts";
import { legacyMdToHtml, safeImageSrc } from "../../core/document/text-policy.ts";

export function normalizeImportedRows(rows, sanitizeHtml) {
  function importedImageRef(dataUrl) {
    var rec = dataUrl ? internDataUrl(dataUrl) : null;
    if (rec) queuePersist([rec.sha256]);
    return rec;
  }
  return rows.map(function (r) {
    var visual = String(r.visualText || "");
    var image = null;
    var m = MD_IMAGE_PREFIX_RE.exec(visual);
    if (m) {
      image = safeImageSrc(m[1]);
      if (image) visual = visual.slice(m[0].length);
    }
    return {
      id: makeId(),
      visualText: sanitizeHtml(legacyMdToHtml(visual)),
      imageRef: importedImageRef(image),
      audioText: audioDirectionsHtml(sanitizeHtml(legacyMdToHtml(r.audioText || "")))
    };
  });
}
