import { resolveExportAssets } from "../export/assets.ts";
import type { ExportAssetPorts, ExportAssetRequest, ExportAssets } from "../export/assets.ts";
import type { ExportServices } from "../export/services.ts";
import { captureExportDocument as captureWith } from "./capture.ts";
import type { CapturePorts } from "./capture.ts";
import { buildExportDocument } from "../../core/document/export-document.ts";
import type { ClockMode, ExportCaptureOptions, ExportDocument, ExportReadModels } from "../../core/document/export-document.ts";
import type { Clock, IdSource } from "../../core/document/ports.ts";
import { contentMemo } from "../../core/document/memo.ts";
import { deriveProductionIndex } from "../../core/production/tags.ts";
import { brollEntries } from "../../core/production/broll.ts";
import { toHtml } from "../../core/text/html.ts";
import type { DocumentEntry } from "../session/ports.ts";
import type { DocumentView } from "../session/document-session.ts";

export interface ExportAnchor {
  readonly contains: (other: ExportAnchor) => boolean;
  readonly compareDocumentPosition: (other: ExportAnchor) => number;
  readonly getAttribute: (name: string) => string | null;
}

export interface ExportAnchorBody {
  readonly querySelectorAll: (selector: string) => ArrayLike<ExportAnchor>;
}

export interface ExportKitPorts {
  readonly read: CapturePorts["read"];
  readonly preferences: { readonly clock: () => string };
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly services: () => ExportServices<ExportAnchorBody>;
  readonly entry: DocumentEntry;
  readonly assets: ExportAssetPorts;
  readonly following: number;
}

export interface ExportKit {
  readonly captureExportDocument: (opts?: ExportCaptureOptions | null) => ExportDocument;
  readonly loadExportAssets: (request: ExportAssetRequest) => Promise<ExportAssets>;
  readonly exportDocumentOf: (state: unknown, opts?: ExportCaptureOptions | null) => ExportDocument;
}

export function createExportKit(ports: ExportKitPorts): ExportKit {
  const anchorOrder = contentMemo(function (html) {
    const services = ports.services();
    const spans = Array.prototype.slice.call(services.inertBody(toHtml(services.cellOf(html))).querySelectorAll(".cmt-anchor")) as ExportAnchor[];
    spans.sort(function (a, b) {
      if (a.contains(b)) return 1;
      if (b.contains(a)) return -1;
      return a.compareDocumentPosition(b) & ports.following ? -1 : 1;
    });
    return spans.map(function (el) { return el.getAttribute("data-cmt"); });
  }, function (value) { return ports.services().cacheSeal(value); });

  function numberComments(state: DocumentView): Record<string, number> {
    const open: Record<string, boolean> = Object.create(null);
    (state.comments || []).forEach(function (c) {
      if (c && c.id && !c.resolved && c.field !== "title") open[c.id] = true;
    });
    const nums: Record<string, number> = Object.create(null);
    let n = 0;
    (state.rows || []).forEach(function (row) {
      (["visualText", "audioText"] as const).forEach(function (field) {
        const html = row[field] || "";
        if (html.indexOf("cmt-anchor") === -1) return;
        anchorOrder(html).forEach(function (id) {
          if (!open[id as string]) return;
          n++;
          if (!nums[id as string]) nums[id as string] = n;
        });
      });
    });
    return nums;
  }

  function exportReadModels(doc: DocumentView): ExportReadModels {
    const services = ports.services();
    return {
      production: deriveProductionIndex(doc, services.productionReaders).entries,
      commentNumbers: numberComments(doc),
      broll: brollEntries(doc, services.productionReaders, ports.ids, services.htmlToPlainText)
    };
  }

  const capturePorts: CapturePorts = { read: ports.read, readModels: exportReadModels, clock: ports.clock };

  function withClock(opts?: ExportCaptureOptions | null): ExportCaptureOptions {
    return Object.assign({ clockMode: ports.preferences.clock() as ClockMode }, opts);
  }

  return {
    captureExportDocument: function (opts) { return captureWith(capturePorts, withClock(opts)); },
    loadExportAssets: function (request) { return resolveExportAssets(request, ports.assets); },
    exportDocumentOf: function (state, opts) {
      const doc = ports.entry(JSON.parse(JSON.stringify(state)));
      return buildExportDocument(doc, ports.clock.nowIso(), exportReadModels(doc), withClock(opts));
    }
  };
}
