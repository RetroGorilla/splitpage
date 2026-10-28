import "./_preferences-started.mjs";
import "./_export-kit-started.mjs";
import { currentDocument } from "../legacy/session-bridge.ts";
import { brollView } from "../application/preferences/broll-view.ts";
import { brollShotListForPrint } from "../adapters/formats/export-projections.ts";
import { exportAssetsNow } from "../adapters/formats/export-assets.ts";
import { exportDocumentOf } from "../bootstrap/wiring/export-capture.ts";

export function liveDoc() {
  return exportDocumentOf(currentDocument());
}

export function liveWithAssets() {
  const doc = liveDoc();
  return [doc, exportAssetsNow(doc)];
}

export function printData(as) {
  return brollShotListForPrint(liveDoc(), brollView.printView(as));
}
