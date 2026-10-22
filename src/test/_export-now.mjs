import "./_preferences-started.mjs";
import { S } from "../js/_state.js";
import { brollPrintView, brollShotListForPrint } from "../js/08d-broll-panel.js";
import { exportAssetsNow, exportDocumentOf } from "../js/14b-export-kit.js";

export function liveDoc() {
  return exportDocumentOf(S.state);
}

export function liveWithAssets() {
  const doc = liveDoc();
  return [doc, exportAssetsNow(doc)];
}

export function printData(as) {
  return brollShotListForPrint(liveDoc(), brollPrintView(as));
}
