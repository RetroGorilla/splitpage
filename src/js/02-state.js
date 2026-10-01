import { PAGE_SHELL } from "./00-prelude.js";
import { STATE_FIELDS as FIELD_POLICIES, missingStateFields as missingFieldsIn } from "../core/document/fields.ts";
import { mediaCommentId } from "../core/document/ids.ts";
import { escapeHtml, legacyMdToHtml } from "../core/document/text-policy.ts";
import { LIST_MERGERS } from "../core/merge/lists.ts";
import { migrateRows as migrateRowsWith } from "../core/migrate.ts";
import { withDocumentPorts } from "../legacy/document-ports.ts";
export { makeId } from "../adapters/identity/ids.ts";
export { escapeHtml, legacyMdToHtml, mediaCommentId };

export function defaultState() {
  try {
    return JSON.parse(document.getElementById("state-data").textContent);
  } catch (e) {
    return { title: "Untitled Script", rows: [] };
  }
}

export var STATE_FIELDS = FIELD_POLICIES.map(function (f) {
  var entry = Object.assign({}, f);
  if (LIST_MERGERS[f.key]) entry.mergeList = LIST_MERGERS[f.key];
  return entry;
});

export function missingStateFields(s) {
  return missingFieldsIn(s, STATE_FIELDS);
}

export function migrateRows(s) {
  return withDocumentPorts(STATE_FIELDS, function (ports) {
    return migrateRowsWith(s, ports);
  });
}

export function buildPublishHtml(stateJson) {
  var CLOSE_SCRIPT = "<" + "/script>";
  var openTag = '<script id="state-data" type="application/json">';
  var start = PAGE_SHELL.indexOf(openTag);
  if (start === -1) throw new Error("state-data anchor missing from the page shell");
  var openEnd = start + openTag.length;
  var close = PAGE_SHELL.indexOf(CLOSE_SCRIPT, openEnd);
  if (close === -1) throw new Error("state-data closing tag missing from the page shell");
  var safeJson = String(stateJson).replace(/<\//g, "<\\/");
  return PAGE_SHELL.slice(0, openEnd) + "\n" + safeJson + "\n" + PAGE_SHELL.slice(close);
}

export function __init() {}
