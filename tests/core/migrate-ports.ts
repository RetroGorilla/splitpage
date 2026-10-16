import type { StateField } from "../../src/core/document/fields.ts";
import { deepFreeze } from "../../src/core/document/freeze.ts";
import { createImageIngestion } from "../../src/core/document/media.ts";
import type { ImageIngestion } from "../../src/core/document/media.ts";
import type { ImageRef } from "../../src/core/document/ports.ts";
import { storedImageMarkup } from "../../src/core/document/text-policy.ts";
import type { ValidatedDocument } from "../../src/core/document/validated.ts";
import { migrateRows } from "../../src/core/migrate.ts";
import type { MigratePorts } from "../../src/core/migrate.ts";
import { createProductionReaders } from "../../src/core/production/readers.ts";
import { toHtml } from "../../src/core/text/html.ts";
import type { DecodeOptions } from "../../src/core/text/ports.ts";
import { normalizeCell } from "../../src/core/text/runs.ts";
import type { Run } from "../../src/core/text/runs.ts";
import { countingIds } from "./merge/fakes.ts";

export { countingIds };

export type PortLog = string[];

export type FakeMigration = {
  ports: MigratePorts;
  images: ImageIngestion;
  log: PortLog;
  ids: ReturnType<typeof countingIds>;
  cell: (cell: readonly Run[]) => string;
};

const IMG_SRC = /<img src="([^"]*)">/g;
const IMG_BLOB = /<img\b[^>]*\sdata-blob="([0-9a-f]{64})"[^>]*>/g;
const VIDEO = /<a class="video-embed-card" href="([^"]*)">[^]*?<\/a>/g;

function plainRuns(html: string): Run[] {
  const text = html.replace(/<[^>]*>/g, "");
  return text ? [{ text: text, marks: {} }] : [];
}

export function fakeMigration(registry?: Record<string, ImageRef>, fields?: readonly StateField[]): FakeMigration {
  const log: PortLog = [];
  const held = registry || {};
  const images = createImageIngestion(function (sha) {
    log.push("registry:" + sha.slice(0, 4));
    return Object.prototype.hasOwnProperty.call(held, sha) ? held[sha] as ImageRef : null;
  });
  const cells = new Map<string, Run[]>();
  cells.set("", []);
  function cellOf(html: string): readonly Run[] {
    return cells.get(html) || plainRuns(html);
  }
  const ids = countingIds();
  const ports: MigratePorts = {
    images: {
      known: function (sha) { log.push("known:" + sha.slice(0, 4)); return images.known(sha); },
      fromDataUrl: function (url) {
        const ref = images.fromDataUrl(url);
        log.push("fromDataUrl:" + (ref ? ref.sha256.slice(0, 4) : "null"));
        return ref;
      }
    },
    sanitize: function (html) {
      const s = html == null ? "" : String(html);
      log.push("sanitize");
      return s.replace(IMG_SRC, function (m: string, src: string) {
        const ref = ports.images.fromDataUrl(src);
        return ref ? storedImageMarkup(ref) : "";
      });
    },
    decode: function (html: string, opts: DecodeOptions) {
      log.push("decode");
      let rest = html.replace(IMG_BLOB, function (m: string, sha: string) {
        const ref = ports.images.known(sha);
        if (opts.onMedia) opts.onMedia({ kind: "image", ref: ref || { sha256: sha, width: null, height: null, mime: null } });
        return "";
      });
      rest = rest.replace(VIDEO, function (m: string, href: string) {
        if (opts.onMedia) opts.onMedia({ kind: "video", href: href });
        return "";
      });
      return cells.get(rest) || plainRuns(rest);
    },
    videoCardHtml: function (href) {
      log.push("videoCard");
      return '<a class="video-embed-card" href="' + href + '">card</a>';
    },
    readers: createProductionReaders(cellOf, deepFreeze),
    ids: ids,
    fields: fields
  };
  return {
    ports: ports,
    images: images,
    log: log,
    ids: ids,
    cell: function (cell) {
      const html = toHtml(cell);
      cells.set(html, normalizeCell(cell));
      return html;
    }
  };
}

const be32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

export function pngDataUrl(width: number, height: number, salt: number): string {
  const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52,
    ...be32(width), ...be32(height), 8, 6, 0, 0, 0, ...be32(salt), 0x49, 0x45, 0x4e, 0x44];
  return "data:image/png;base64," + Buffer.from(bytes).toString("base64");
}

export function jsonCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function migratedThenSet<T extends object>(fixture: T, ports?: MigratePorts): T & ValidatedDocument {
  const doc = migrateRows(jsonCopy(fixture), ports || fakeMigration().ports);
  return Object.assign(doc, fixture);
}
