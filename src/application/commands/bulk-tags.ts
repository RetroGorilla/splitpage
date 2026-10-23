import type { DocumentRow } from "../../core/document/validated.ts";
import type { FieldHtml } from "../../core/production/ports.ts";
import type { BulkTagResult } from "../../core/production/tags.ts";

export interface BulkTagPorts {
  readonly cell: (html: FieldHtml, phrase: string, cat: string, name: string, matchCase?: boolean, countOnly?: boolean) => BulkTagResult;
  readonly stamp: (row: DocumentRow) => void;
}

export type BulkTagTotals = Pick<BulkTagResult, "hits" | "inTags" | "skipped">;

let tagging: BulkTagPorts;

export function bindBulkTagRows(ports: BulkTagPorts): void {
  tagging = ports;
}

export function bulkTagRows(rows: readonly DocumentRow[] | null | undefined, phrase: string, cat: string, name: string, matchCase?: boolean, countOnly?: boolean): BulkTagTotals {
  const total = { hits: 0, inTags: 0, skipped: 0 };
  (rows || []).forEach(function (row) {
    const res = tagging.cell(row.visualText, phrase, cat, name, matchCase, countOnly);
    total.hits += res.hits;
    total.inTags += res.inTags;
    total.skipped += res.skipped;
    if (!countOnly && res.hits && res.html !== row.visualText) {
      row.visualText = res.html;
      tagging.stamp(row);
    }
  });
  return total;
}
