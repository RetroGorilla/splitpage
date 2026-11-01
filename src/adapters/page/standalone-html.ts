import type { ExportAssets } from "../../application/export/assets.ts";
import type { ExportDocument } from "../../core/document/export-document.ts";
import type { migrateRows as migrateRowsCore } from "../../core/migrate.ts";
import { withPageHead } from "../../core/document/ids.ts";
import { base64Encode } from "../../core/document/media.ts";
import { cloneState } from "../../core/document/clone.ts";
import { buildPublishHtml } from "./page-shell.ts";
import { inlineStateImages } from "../storage/02c-blobs.js";

let entry: ((raw: Parameters<typeof migrateRowsCore>[0]) => ReturnType<typeof migrateRowsCore>) | null = null;

export function startStandaloneHtml(migrateRows: NonNullable<typeof entry>) {
  entry = migrateRows;
  return function () { if (entry === migrateRows) entry = null; };
}

function migrateRows(raw: Parameters<typeof migrateRowsCore>[0]) {
  if (!entry) throw new Error("Standalone HTML is not started yet");
  return entry(raw);
}

export function standaloneHtmlFor(doc: ExportDocument, head?: Parameters<typeof withPageHead>[1] | null, assets?: ExportAssets | null) {
  const copy = migrateRows(cloneState(doc.document));
  inlineStateImages(copy, null, assets ? function (sha: string) {
    const held = assets.picture(sha);
    return held && held.mime ? "data:" + held.mime + ";base64," + base64Encode(held.bytes) : null;
  } : null);
  delete (copy as Partial<Pick<typeof copy, "docId">>).docId;
  const html = buildPublishHtml(JSON.stringify(copy));
  return head ? withPageHead(html, head) : html;
}
