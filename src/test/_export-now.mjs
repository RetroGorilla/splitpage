import "./_preferences-started.mjs";
import { currentDocument } from "../legacy/session-bridge.ts";
import { brollPrintView, brollShotListForPrint } from "../js/08d-broll-panel.js";
import { exportAssetsNow } from "../adapters/formats/export-assets.ts";
import { exportDocumentOf } from "../js/14b-export-kit.js";

export function liveDoc() {
  return exportDocumentOf(currentDocument());
}

export function liveWithAssets() {
  const doc = liveDoc();
  return [doc, exportAssetsNow(doc)];
}

export function printData(as) {
  return brollShotListForPrint(liveDoc(), brollPrintView(as));
}
