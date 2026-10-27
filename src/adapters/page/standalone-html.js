import { withPageHead } from "../../core/document/ids.ts";
import { base64Encode } from "../../core/document/media.ts";
import { cloneState } from "../../core/document/clone.ts";
import { buildPublishHtml } from "./page-shell.ts";
import { inlineStateImages } from "../storage/02c-blobs.js";

let entry = null;

export function startStandaloneHtml(migrateRows) {
  entry = migrateRows;
  return function () { if (entry === migrateRows) entry = null; };
}

function migrateRows(raw) {
  if (!entry) throw new Error("Standalone HTML is not started yet");
  return entry(raw);
}

export function standaloneHtmlFor(doc, head, assets) {
  var copy = migrateRows(cloneState(doc.document));
  inlineStateImages(copy, null, assets ? function (sha) {
    var held = assets.picture(sha);
    return held && held.mime ? "data:" + held.mime + ";base64," + base64Encode(held.bytes) : null;
  } : null);
  delete copy.docId;
  var html = buildPublishHtml(JSON.stringify(copy));
  return head ? withPageHead(html, head) : html;
}
