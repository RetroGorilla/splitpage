import { documentLocation } from "../wiring/location-owner.ts";
import { documentTransitions } from "../wiring/transition-owners.ts";
import { withDocumentPorts, migrateRows } from "../document-ports.ts";
import { migrateDocument as migrateDocumentWith } from "../../core/migrate.ts";
import type { DocumentOrigin } from "../../core/migrate.ts";
import { STATE_FIELDS } from "../../core/merge/state-fields.ts";
import { cloneState } from "../../core/document/clone.ts";
import { neverWrittenOut } from "../../application/recovery/pristine.ts";
import { defaultState } from "../../adapters/page/page-shell.ts";

export function migrateDocument(raw: unknown, origin?: DocumentOrigin | null) {
  return withDocumentPorts(STATE_FIELDS, function (ports) {
    return migrateDocumentWith(raw, origin, ports);
  });
}

export async function loadInitialState(pristine: boolean) {
  let raw = null;
  if (!pristine) {
    try { raw = JSON.parse((document.getElementById("state-data") as HTMLElement).textContent as string); } catch (e) { raw = null; }
  }
  const loaded = pristine || !raw || typeof raw !== "object" || neverWrittenOut(raw)
    ? null
    : migrateDocument(raw, { kind: "file" });
  if (!loaded || neverWrittenOut(loaded)) {
    documentLocation().markWrittenOut(false);
    return migrateRows(defaultState());
  }
  documentLocation().markWrittenOut(true);
  return loaded;
}

export function adoptRestoredState(snap: unknown) {
  return documentTransitions().restore({ from: { raw: cloneState(snap) } }).document;
}
