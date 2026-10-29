import { documentLocation } from "../../legacy/location-bridge.ts";
import { documentTransitions } from "../wiring/transition-owners.ts";
import { withDocumentPorts, migrateRows } from "../document-ports.ts";
import { migrateDocument as migrateDocumentWith } from "../../core/migrate.ts";
import { STATE_FIELDS } from "../../core/merge/state-fields.ts";
import { cloneState } from "../../core/document/clone.ts";
import { neverWrittenOut } from "../../application/recovery/pristine.ts";
import { defaultState } from "../../adapters/page/page-shell.ts";

export function migrateDocument(raw, origin) {
  return withDocumentPorts(STATE_FIELDS, function (ports) {
    return migrateDocumentWith(raw, origin, ports);
  });
}

export async function loadInitialState(pristine) {
  var raw = null;
  if (!pristine) {
    try { raw = JSON.parse(document.getElementById("state-data").textContent); } catch (e) { raw = null; }
  }
  var loaded = pristine || !raw || typeof raw !== "object" || neverWrittenOut(raw)
    ? null
    : migrateDocument(raw, { kind: "file" });
  if (!loaded || neverWrittenOut(loaded)) {
    documentLocation().markWrittenOut(false);
    return migrateRows(defaultState());
  }
  documentLocation().markWrittenOut(true);
  return loaded;
}

export function adoptRestoredState(snap) {
  return documentTransitions().restore({ from: { raw: cloneState(snap) } }).document;
}
