import { deepFreeze } from "../../../src/core/document/freeze.ts";
import type { IdSource } from "../../../src/core/document/ports.ts";
import { createProductionReaders } from "../../../src/core/production/readers.ts";
import type { ProductionReaders } from "../../../src/core/production/ports.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import type { CellDecoder } from "../../../src/core/text/ports.ts";
import { normalizeCell } from "../../../src/core/text/runs.ts";
import type { Marks, Run, TextRun } from "../../../src/core/text/runs.ts";
import { B, T } from "../text/cells.ts";

export { B, T };

export function tag(cat: string, name: string, text?: string, marks?: Marks): TextRun {
  return T(text === undefined ? name : text, Object.assign({ tag: "t:" + cat + ":" + name }, marks || {}));
}

export function cue(line: string): TextRun {
  return T(line, { cue: true });
}

export type MapDecoder = {
  decode: CellDecoder;
  html: (cell: readonly Run[]) => string;
  put: (html: string, cell: readonly Run[]) => string;
  decoded: string[];
};

export function mapDecoder(): MapDecoder {
  const byHtml = new Map<string, Run[]>();
  const decoded: string[] = [];
  return {
    decoded: decoded,
    html: function (cell) {
      const html = toHtml(cell);
      byHtml.set(html, normalizeCell(cell));
      return html;
    },
    put: function (html, cell) {
      byHtml.set(html, normalizeCell(cell));
      return html;
    },
    decode: function (html) {
      decoded.push(html);
      const cell = byHtml.get(html);
      if (!cell) throw new Error("not written by toHtml: " + html);
      return cell;
    }
  };
}

export function readersOver(cells: MapDecoder): ProductionReaders {
  return createProductionReaders(cells.decode, deepFreeze);
}

export function countingIds(prefix?: string): IdSource & { minted: string[] } {
  const minted: string[] = [];
  return {
    minted: minted,
    id: function (p) {
      const id = p + (prefix || "mint") + String(minted.length + 1).padStart(4, "0");
      minted.push(id);
      return id;
    },
    docId: function () { return "d" + "0".repeat(32); }
  };
}

export function plainTextOf(html: string | null | undefined): string {
  if (!html) return "";
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&")
    .trim();
}

export function jsonCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
